import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Argument handling of the Automation CLIs, asserted for BOTH languages with the same input:
 * every rejected invocation must produce the same categorised stderr line and exit code, and must
 * send nothing at all (not even the OAuth token request) to the stub.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const NODE_CLI = path.join(REPO_ROOT, 'cli-tools/automation/node/cli.js');
const PY_CLI = path.join(REPO_ROOT, 'cli-tools/automation/python/cli.py');

type Result = { code: number | null; stdout: string; stderr: string };
type Recorded = { method: string; path: string; headers: Record<string, any>; body: any };

let server: Server;
let baseUrl: string;
let hits: Recorded[] = [];
let uploadStatus = 200;
// Created at load time: the REJECTED table below needs its paths while the file is being collected.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelz-auto-cli-'));
fs.writeFileSync(path.join(workDir, 'photo.webp'), 'not really a webp');
fs.writeFileSync(path.join(workDir, 'notes.txt'), 'secret');

beforeAll(async () => {
    server = createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            const url = new URL(req.url!, 'http://localhost');
            const isJson = (req.headers['content-type'] || '').includes('json');
            hits.push({ method: req.method!, path: url.pathname, headers: req.headers, body: raw && isJson ? JSON.parse(raw) : raw });
            res.writeHead(url.pathname.endsWith('/request-upload-url') && uploadStatus !== 200 ? uploadStatus : 200,
                { 'Content-Type': 'application/json' });
            if (url.pathname.endsWith('/token')) res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }));
            else if (url.pathname.endsWith('/request-upload-url')) res.end(JSON.stringify({ url: `${baseUrl}/s3/target` }));
            else res.end(JSON.stringify({ job_id: 'job-123' }));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
    fs.rmSync(workDir, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
});

const env = () => ({
    ...process.env,
    PIXELZ_AUTOMATION_BASE_URL: `${baseUrl}/v1`,
    PIXELZ_AUTOMATION_AUTH_URL: `${baseUrl}/token`,
    PIXELZ_AUTOMATION_CLIENT_ID: 'stub-id',
    PIXELZ_AUTOMATION_CLIENT_SECRET: 'stub-secret',
    PIXELZ_DOTENV_PATH: path.join(REPO_ROOT, 'nonexistent.env'),
    PIXELZ_REQUEST_TIMEOUT_SECONDS: '10',
});

function run(cmd: string, args: string[]): Promise<Result> {
    return new Promise(resolve => {
        execFile(cmd, args, { env: env() }, (err, stdout, stderr) => {
            resolve({ code: err && typeof err.code === 'number' ? err.code : 0, stdout, stderr });
        });
    });
}

const runNode = (args: string[]) => run(process.execPath, [NODE_CLI, ...args]);
const runPy = (args: string[]) => run('python', [PY_CLI, ...args]);
const firstLine = (s: string) => s.split(/\r?\n/)[0];

const IMG = 'https://example.com/shirt.jpg';
const SWATCH = { swatch_image_url: 'https://example.com/swatch.jpg', x_coordinate: 5, y_coordinate: 6 };
const marker = (extra: object) => JSON.stringify([{ x_coordinate: 10, y_coordinate: 20, ...extra }]);

// [name, args, text the [VALIDATION_ERROR] line must contain]
const REJECTED: [string, string[], string][] = [
    ['status without a job id', ['status'], 'status requires <job_id>'],
    ['remove-bg without an image', ['remove-bg'], 'remove-bg requires <input>'],
    ['color-match without markers', ['color-match', IMG], 'color-match requires <markers>'],
    ['a surplus positional', ['create-trimap', IMG, 'extra'], 'unrecognized arguments: extra'],
    ['--sync given a value', ['create-trimap', IMG, '--sync', 'true'], 'unrecognized arguments: true'],
    ['an unknown flag', ['create-mask', IMG, '--feathr', '3'], 'unrecognized arguments: --feathr 3'],
    ['a value flag with no value', ['create-trimap', IMG, '--callback'], 'argument --callback: expected one argument'],
    ['a non-numeric --feather', ['remove-bg', IMG, '--feather', 'abc'], "argument --feather: invalid float value: 'abc'"],
    ['an infinite --feather', ['create-mask', IMG, '--feather', '1e999'], 'invalid float value'],
    ['a negative --feather', ['create-mask', IMG, '--feather', '-1'], '--feather must be >= 0'],
    ['a negative --feather on remove-bg', ['remove-bg', IMG, '--feather=-2'], '--feather must be >= 0'],
    ['a non-hex --color', ['remove-bg', IMG, '--color', 'red'], '--color must be a hex colour'],
    ['a --color without the hash', ['remove-bg', IMG, '--color', 'FFFFFF'], '--color must be a hex colour'],
    ['--color with --transparent true', ['remove-bg', IMG, '--color', '#FFFFFF', '--transparent', 'true'], 'cannot be used together'],
    ['--transparent false without a colour', ['remove-bg', IMG, '--transparent', 'false'], '--transparent false requires --color'],
    ['--transparent with a non-boolean', ['remove-bg', IMG, '--transparent', 'maybe'], "argument --transparent: invalid choice: 'maybe'"],
    ['model-crop with neither --top nor --bottom', ['model-crop', IMG], 'model-crop requires at least one of --top or --bottom'],
    ['an unknown --top', ['model-crop', IMG, '--top', 'at_neck'], '--top must be one of: eye_higher'],
    ['an unknown --bottom', ['model-crop', IMG, '--top', 'chest', '--bottom', 'ankle'], '--bottom must be one of'],
    ['unparseable MARKERS_JSON', ['color-match', IMG, '[{'], 'MARKERS_JSON is not valid JSON'],
    ['an empty markers array', ['color-match', IMG, '[]'], 'MARKERS_JSON must be a non-empty JSON array'],
    ['a markers object instead of an array', ['color-match', IMG, '{"x_coordinate":1}'], 'MARKERS_JSON must be a non-empty JSON array'],
    ['a marker that is not an object', ['color-match', IMG, '[5]'], 'MARKERS_JSON[0] must be an object'],
    ['a marker without coordinates', ['color-match', IMG, '[{"swatch_color_code":"#FFFFFF"}]'], 'integer x_coordinate and y_coordinate'],
    ['a fractional coordinate', ['color-match', IMG, marker({ x_coordinate: 1.5, swatch_color_code: '#FFFFFF' })], 'integer x_coordinate'],
    ['a marker with no swatch', ['color-match', IMG, marker({})], 'exactly one of swatch_color_code or swatch_image'],
    ['a marker with both swatches', ['color-match', IMG, marker({ swatch_color_code: '#FFFFFF', swatch_image: SWATCH })], 'exactly one of swatch_color_code or swatch_image'],
    ['a non-hex swatch_color_code', ['color-match', IMG, marker({ swatch_color_code: 'white' })], 'swatch_color_code must be a hex colour'],
    ['a swatch_image without a URL', ['color-match', IMG, marker({ swatch_image: { x_coordinate: 1, y_coordinate: 2 } })], 'swatch_image needs swatch_image_url'],
    ['a swatch_image with a fractional coordinate', ['color-match', IMG, marker({ swatch_image: { ...SWATCH, y_coordinate: 0.5 } })], 'swatch_image needs swatch_image_url'],
    ['an unsupported local file type', ['create-trimap', path.join(workDir, 'notes.txt')], 'Unsupported file type'],
    ['a missing local file', ['create-trimap', path.join(workDir, 'gone.jpg')], 'Local file not found'],
    ['an invalid job id', ['status', 'a/b'], 'Invalid jobId'],
];

describe('automation CLI (node and python) — rejected invocations', () => {
    it.each(REJECTED)('%s', async (_name, args, expected) => {
        hits = [];
        const [n, p] = await Promise.all([runNode(args), runPy(args)]);
        for (const [label, r] of [['node', n], ['python', p]] as const) {
            expect(r.code, `${label} exit code`).toBe(1);
            expect(r.stderr, `${label} stderr`).toContain('[VALIDATION_ERROR]');
            expect(r.stderr, `${label} stderr`).toContain(expected);
            expect(r.stderr, `${label} stderr`).not.toContain('[API_ERROR]');
            expect(r.stdout, `${label} stdout`).toBe('');
        }
        expect(firstLine(n.stderr)).toBe(firstLine(p.stderr));
        expect(hits).toEqual([]);
    });
});

describe('automation CLI (node and python) — command line shape', () => {
    it('an unknown command writes usage to stderr and exits 2', async () => {
        hits = [];
        for (const r of await Promise.all([runNode(['frobnicate']), runPy(['frobnicate'])])) {
            expect(r.code).toBe(2);
            expect(r.stdout).toBe('');
            expect(r.stderr).toContain("[VALIDATION_ERROR] unknown command 'frobnicate'");
            expect(r.stderr).toContain('remove-bg');
        }
        expect(hits).toEqual([]);
    });

    it('no command prints usage on stdout and exits 0', async () => {
        for (const r of await Promise.all([runNode([]), runPy([])])) {
            expect(r.code).toBe(0);
            expect(r.stdout.toLowerCase()).toContain('usage');
            expect(r.stderr).toBe('');
        }
    });

    it('--help prints usage on stdout and exits 0, showing --transparent as true|false', async () => {
        const [n, p] = await Promise.all([runNode(['--help']), runPy(['--help'])]);
        for (const r of [n, p]) {
            expect(r.code).toBe(0);
            expect(r.stdout.toLowerCase()).toContain('usage');
            expect(r.stderr).toBe('');
        }
        expect(n.stdout).toContain('--transparent true|false');
        expect(n.stdout).not.toContain('[--transparent]');
    });
});

describe('automation CLI (node and python) — accepted invocations reach the API unchanged', () => {
    it('color-match sends the validated markers (colour and image swatches)', async () => {
        const markers = [
            { x_coordinate: 10, y_coordinate: 20, swatch_color_code: '#A1B2C3' },
            { x_coordinate: 30, y_coordinate: 40, swatch_image: SWATCH },
        ];
        for (const run of [runNode, runPy]) {
            hits = [];
            const r = await run(['color-match', IMG, JSON.stringify(markers)]);
            expect(r.code).toBe(0);
            const post = hits.find(h => h.path.endsWith('/images/color-matching'))!;
            expect(post.body.color_markers).toEqual(markers);
        }
    });

    it('--feather 0 is sent, not dropped as falsy', async () => {
        for (const run of [runNode, runPy]) {
            hits = [];
            await run(['create-mask', IMG, '--feather', '0']);
            expect(hits.find(h => h.path.endsWith('/images/create-mask'))!.body.feather_width).toBe(0);
        }
    });

    it('model-crop accepts any one of the 17 locations on either side', async () => {
        for (const run of [runNode, runPy]) {
            hits = [];
            const r = await run(['model-crop', IMG, '--bottom', 'below_knee']);
            expect(r.code).toBe(0);
            const body = hits.find(h => h.path.endsWith('/images/model-crop'))!.body;
            expect(body.bottom_crop_location).toBe('below_knee');
            expect(body.top_crop_location).toBeUndefined();
        }
    });

    it('a local .webp is uploaded with Content-Type image/webp from the shared table', async () => {
        for (const run of [runNode, runPy]) {
            hits = [];
            uploadStatus = 200;
            const r = await run(['create-trimap', path.join(workDir, 'photo.webp')]);
            expect(r.code, r.stderr).toBe(0);
            const put = hits.find(h => h.method === 'PUT')!;
            expect(put.path).toBe('/s3/target');
            expect(put.headers['content-type']).toBe('image/webp');
            expect(hits.find(h => h.path.endsWith('/images/create-trimap'))!.body.image_url).toBe(`${baseUrl}/s3/target`);
        }
    });
});

describe('automation CLI (node and python) — upload unavailable', () => {
    it('HTTP 403 on request-upload-url is reported as [UPLOAD_UNAVAILABLE] with the documented text', async () => {
        const expected = '[UPLOAD_UNAVAILABLE] HTTP 403: the account may not be enabled for direct file uploads ' +
            '(off by default on the Automation API). Provide a publicly accessible image URL instead of a local file path.';
        uploadStatus = 403;
        try {
            for (const run of [runNode, runPy]) {
                hits = [];
                const r = await run(['remove-bg', path.join(workDir, 'photo.webp')]);
                expect(r.code).toBe(1);
                expect(r.stderr.trim()).toBe(expected);
                expect(r.stdout).toBe('');
                expect(hits.some(h => h.method === 'PUT')).toBe(false);
            }
        } finally {
            uploadStatus = 200;
        }
    });
});
