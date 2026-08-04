import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const NODE_CLI = path.join(REPO_ROOT, 'cli-tools/platform/node/cli.js');
const PY_CLI = path.join(REPO_ROOT, 'cli-tools/platform/python/cli.py');

/**
 * These cover the flag-drift class of bug: a documented flag that parses fine but never
 * reaches the API under the name the API expects, so the request silently succeeds
 * unfiltered. Asserting on the captured query string is the only thing that catches it.
 */
let server: Server;
let baseUrl: string;
let lastRequest: { path: string; query: URLSearchParams };

beforeAll(async () => {
    server = createServer((req, res) => {
        const url = new URL(req.url!, 'http://localhost');
        lastRequest = { path: url.pathname, query: url.searchParams };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ErrorCode: 'NoError', Images: [] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

const env = () => ({
    ...process.env,
    PIXELZ_PLATFORM_BASE_URL: baseUrl,
    PIXELZ_PLATFORM_EMAIL: 'test@example.com',
    PIXELZ_PLATFORM_API_KEY: 'test_key',
    PIXELZ_DOTENV_PATH: path.join(REPO_ROOT, 'nonexistent.env'),
});

const runNode = (args: string[]) => execFileAsync(process.execPath, [NODE_CLI, ...args], { env: env() });
const runPy = (args: string[]) => execFileAsync('python', [PY_CLI, ...args], { env: env() });

// Both language tracks must send identical params for identical flags.
for (const [label, run] of [['node', runNode], ['python', runPy]] as const) {
    describe(`platform CLI (${label}) — flag to API param mapping`, () => {
        it('list-images --status sends imageStatus, not status', async () => {
            await run(['list-images', '--status', '80']);
            expect(lastRequest.query.get('imageStatus')).toBe('80');
            expect(lastRequest.query.get('status')).toBeNull();
        });

        it('list-images --status resolves a name alias to its code', async () => {
            await run(['list-images', '--status', 'delivered']);
            expect(lastRequest.query.get('imageStatus')).toBe('80');
        });

        it('list-images --excludeImageStatus resolves aliases too', async () => {
            await run(['list-images', '--excludeImageStatus', 'in production']);
            expect(lastRequest.query.get('excludeImageStatus')).toBe('60');
        });

        it('count-images --status sends imageStatus', async () => {
            await run(['count-images', '--status', 'new']);
            expect(lastRequest.path).toContain('/Images/Count');
            expect(lastRequest.query.get('imageStatus')).toBe('10');
            expect(lastRequest.query.get('status')).toBeNull();
        });

        it('status --customer-id reaches the API as customerImageId', async () => {
            await run(['status', 'abc-123', '--customer-id', 'CUST-9']);
            expect(lastRequest.path).toContain('/Image/abc-123');
            expect(lastRequest.query.get('customerImageId')).toBe('CUST-9');
        });

        it('list-products --page and --per-page are forwarded', async () => {
            await run(['list-products', '--page', '3', '--per-page', '25']);
            expect(lastRequest.path).toContain('/ProductIds');
            expect(lastRequest.query.get('page')).toBe('3');
            expect(lastRequest.query.get('productIdsPerPage')).toBe('25');
        });

        it('accepts the API spelling --imageStatus as an alias', async () => {
            await run(['list-images', '--imageStatus', '70']);
            expect(lastRequest.query.get('imageStatus')).toBe('70');
        });
    });
}
