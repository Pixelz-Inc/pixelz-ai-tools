import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const NODE_CLI = path.join(REPO_ROOT, 'cli-tools/automation/node/cli.js');
const PY_CLI = path.join(REPO_ROOT, 'cli-tools/automation/python/cli.py');

/**
 * Parity guard for the automation track: the Node CLI hand-rolls its argument parsing while
 * the Python CLI uses argparse, so the two can drift silently on flag names. These assert the
 * decoded request body, which is the only place a rename actually shows up.
 */
let server: Server;
let baseUrl: string;
let lastRequest: { path: string; body: any; headers: Record<string, any> };
// Token exchanges are counted separately: a validation failure must not even reach /token.
let tokenHits = 0;

beforeAll(async () => {
    server = createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            const url = new URL(req.url!, 'http://localhost');
            if (url.pathname.endsWith('/token')) {
                tokenHits++;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }));
                return;
            }
            lastRequest = {
                path: url.pathname,
                body: raw ? JSON.parse(raw) : null,
                headers: req.headers as Record<string, any>,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ job_id: 'job-123', status: { status_code: 1, status_name: 'Created' } }));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

const env = () => ({
    ...process.env,
    PIXELZ_AUTOMATION_BASE_URL: baseUrl,
    PIXELZ_AUTOMATION_AUTH_URL: `${baseUrl}/token`,
    PIXELZ_AUTOMATION_CLIENT_ID: 'stub-id',
    PIXELZ_AUTOMATION_CLIENT_SECRET: 'stub-secret',
    PIXELZ_DOTENV_PATH: path.join(REPO_ROOT, 'nonexistent.env'),
});

const runNode = (args: string[]) => execFileAsync(process.execPath, [NODE_CLI, ...args], { env: env() });
const runPy = (args: string[]) => execFileAsync('python', [PY_CLI, ...args], { env: env() });

const IMG = 'https://example.com/shirt.jpg';

for (const [label, run] of [['node', runNode], ['python', runPy]] as const) {
    describe(`automation CLI (${label}) — flag to API field mapping`, () => {
        it('model-crop --top/--bottom map to *_crop_location', async () => {
            await run(['model-crop', IMG, '--top', 'below_chin', '--bottom', 'at_knee']);
            expect(lastRequest.path).toContain('/images/model-crop');
            expect(lastRequest.body.top_crop_location).toBe('below_chin');
            expect(lastRequest.body.bottom_crop_location).toBe('at_knee');
        });

        it('remove-bg --color sets background_color and disables transparency', async () => {
            await run(['remove-bg', IMG, '--color', '#FFFFFF']);
            expect(lastRequest.body.background_color).toBe('#FFFFFF');
            expect(lastRequest.body.transparent_background).toBe(false);
        });

        it('remove-bg defaults to transparent when no colour is given', async () => {
            await run(['remove-bg', IMG]);
            expect(lastRequest.body.transparent_background).toBe(true);
        });

        // The API spec: choose exactly one of background_color / transparent_background.
        it('remove-bg rejects --color with --transparent true before sending anything', async () => {
            lastRequest = undefined as any;
            tokenHits = 0;
            await expect(run(['remove-bg', IMG, '--color', '#FFFFFF', '--transparent', 'true']))
                .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('[VALIDATION_ERROR]') });
            expect(lastRequest).toBeUndefined();
            expect(tokenHits).toBe(0);
        });

        it('--sync before the image does not swallow it', async () => {
            await run(['remove-bg', '--sync', IMG]);
            expect(lastRequest.body.image_url).toBe(IMG);
            expect(lastRequest.headers['respond-mode']).toBeUndefined();
        });

        it('rejects a mistyped flag instead of dropping it', async () => {
            lastRequest = undefined as any;
            await expect(run(['create-mask', IMG, '--feathr', '3']))
                .rejects.toMatchObject({ stderr: expect.stringContaining('feathr') });
            expect(lastRequest).toBeUndefined();
        });

        it('remove-bg rejects --transparent false without a colour', async () => {
            await expect(run(['remove-bg', IMG, '--transparent', 'false']))
                .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('[VALIDATION_ERROR]') });
        });

        it('remove-bg --feather maps to feather_width as a number', async () => {
            await run(['remove-bg', IMG, '--feather', '1.5']);
            expect(lastRequest.body.feather_width).toBe(1.5);
        });

        it('remove-bg --trimap maps to trimap_url', async () => {
            await run(['remove-bg', IMG, '--trimap', 'https://example.com/t.png']);
            expect(lastRequest.body.trimap_url).toBe('https://example.com/t.png');
        });

        it('--callback maps to callback_url', async () => {
            await run(['create-mask', IMG, '--callback', 'https://hook.example.com/x']);
            expect(lastRequest.body.callback_url).toBe('https://hook.example.com/x');
        });

        // Async is the documented default; --sync is the opt-in. The header is what
        // actually selects the mode, so assert on it rather than on the payload.
        it('defaults to async mode via the Respond-Mode header', async () => {
            await run(['create-trimap', IMG]);
            expect(lastRequest.headers['respond-mode']).toBe('async');
        });

        it('--sync drops the async Respond-Mode header', async () => {
            await run(['create-trimap', IMG, '--sync']);
            expect(lastRequest.headers['respond-mode']).toBeUndefined();
        });
    });
}
