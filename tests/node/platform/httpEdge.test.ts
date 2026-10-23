import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HTTP failure modes, asserted identically for both platform CLIs against a stub API. Each case
 * was wrong on at least one track after the axios -> fetch switch or before it:
 *  - fetch reports a peer-closed connection as UND_ERR_SOCKET, which the retry check missed;
 *  - a stall while reading the body escaped the timeout mapping ([API_ERROR], not [TIMEOUT]);
 *  - Node returned a non-JSON 2xx (proxy/login page) as success;
 *  - Python lost the [HTTP_<status>] prefix once retries ran out (urllib3 RetryError);
 *  - Node spread unknown flags into the request instead of rejecting them.
 * The scenario is the first path segment of PIXELZ_PLATFORM_BASE_URL.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const tracks = [
    { label: 'node', cmd: process.execPath, cli: path.join(REPO_ROOT, 'cli-tools/platform/node/cli.js') },
    { label: 'python', cmd: 'python', cli: path.join(REPO_ROOT, 'cli-tools/platform/python/cli.py') },
] as const;

const API_KEY = '0f8e7d6c-1111-2222-3333-444455556666';
let server: Server;
let baseUrl: string;
let hits: number;

beforeAll(async () => {
    server = createServer((req, res) => {
        hits++;
        const scenario = new URL(req.url!, 'http://x').pathname.split('/')[1];
        const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
            res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
            res.end(JSON.stringify(body));
        };
        if (scenario === 'closeonce') {
            // A graceful close (FIN) with no answer, as a server dropping a stale keep-alive does;
            // fetch reports it as UND_ERR_SOCKET. (destroy() would send an RST, i.e. ECONNRESET.)
            if (hits === 1) return req.socket.end();
            return json(200, { ErrorCode: 'NoError', ok: true });
        }
        if (scenario === 'stall') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.write('{"partial":'); // headers sent, body never finishes
        }
        if (scenario === 'html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<html>please log in</html>');
        }
        if (scenario === 'busy') return json(503, { message: 'busy' }, { 'Retry-After': '0' });
        if (scenario === 'echo') {
            // A page that echoes the API key right where the error message cuts the body off.
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<html>' + 'x'.repeat(84) + API_KEY + '</html>');
        }
        json(200, { ErrorCode: 'NoError' });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
beforeEach(() => { hits = 0; });

type Result = { code: number; stdout: string; stderr: string };
function run(cmd: string, args: string[], scenario: string): Promise<Result> {
    const env = {
        ...process.env,
        PIXELZ_PLATFORM_BASE_URL: `${baseUrl}/${scenario}`,
        PIXELZ_PLATFORM_EMAIL: 'qa@example.com',
        PIXELZ_PLATFORM_API_KEY: API_KEY,
        PIXELZ_DOTENV_PATH: path.join(REPO_ROOT, 'nonexistent.env'),
        PIXELZ_REQUEST_TIMEOUT_SECONDS: '2',
    };
    return new Promise(resolve => {
        execFile(cmd, args, { env }, (err, stdout, stderr) => {
            resolve({ code: err && typeof err.code === 'number' ? err.code : 0, stdout, stderr });
        });
    });
}

for (const { label, cmd, cli } of tracks) {
    describe.concurrent(`platform CLI (${label}) — HTTP edge cases`, () => {
        it('retries a GET whose connection the server closed', async () => {
            const r = await run(cmd, [cli, 'get-contact'], 'closeonce');
            expect(r.stderr).toBe('');
            expect(r.code).toBe(0);
            expect(JSON.parse(r.stdout).ok).toBe(true);
        }, 60_000);
    });
}

// Unlike 'closeonce' above, none of these depend on the shared hit counter, so they run side by side.
for (const { label, cmd, cli } of tracks) {
    describe.concurrent(`platform CLI (${label}) — failure categories`, () => {
        it('a stall while reading the body is [TIMEOUT]', async () => {
            const r = await run(cmd, [cli, 'get-contact'], 'stall');
            expect(r.code).toBe(1);
            expect(r.stderr.trim()).toMatch(/^\[TIMEOUT\]/);
        }, 60_000);

        it('a non-JSON 2xx (proxy or login page) is an error, not a result', async () => {
            const r = await run(cmd, [cli, 'get-contact'], 'html');
            expect(r.code).toBe(1);
            expect(r.stderr.trim()).toMatch(/^\[API_ERROR\]/);
            expect(r.stdout.trim()).toBe('');
        }, 60_000);

        it('keeps the [HTTP_<status>] prefix once retries run out', async () => {
            const r = await run(cmd, [cli, 'get-contact'], 'busy');
            expect(r.code).toBe(1);
            expect(r.stderr.trim()).toMatch(/^\[HTTP_503\]/);
        }, 60_000);

        it('never shows part of a key that an echoed page puts at the cut-off point', async () => {
            const r = await run(cmd, [cli, 'get-contact'], 'echo');
            expect(r.code).toBe(1);
            // Redaction must run before the body is shortened, or the key's first part survives.
            expect(r.stderr).not.toContain(API_KEY.slice(0, 8));
        }, 60_000);

        it('rejects a mistyped flag instead of sending it', async () => {
            const r = await run(cmd, [cli, 'list-images', '--staus', '60'], 'unused');
            expect(r.code).not.toBe(0);
            expect(r.stderr).toContain('staus');
            expect(r.stdout.trim()).toBe('');
        }, 60_000);
    });
}
