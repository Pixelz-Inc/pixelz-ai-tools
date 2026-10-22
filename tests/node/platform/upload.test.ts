import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The local-file upload path, end to end against a stub API, asserted identically for both
 * CLIs. Every case here was broken on at least one track and invisible to the suite:
 *  - the documented RequestPresignUrls envelope was rejected (code expected a bare list);
 *  - Node dropped `--template` (the form every skill uses) into an unknown payload field;
 *  - Node retried an S3 PUT with an already-consumed stream, sending 0 bytes and hanging;
 *  - Node retried job-creating POSTs, risking duplicate billable jobs.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const NODE_CLI = path.join(REPO_ROOT, 'cli-tools/platform/node/cli.js');
const PY_CLI = path.join(REPO_ROOT, 'cli-tools/platform/python/cli.py');

const FILE_SIZE = 200_000;
let imagePath: string;

type Hit = { method: string; path: string; bytes: number; body: any };
let server: Server;
let baseUrl: string;
let hits: Hit[];
// Per-test stub behaviour: how many leading failures each route returns before succeeding.
let failFirst: { put: number; image: number };
let presignBody: () => any;

beforeAll(async () => {
    imagePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pixelz-upload-')), 'shirt.jpg');
    fs.writeFileSync(imagePath, Buffer.alloc(FILE_SIZE, 7));

    server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const url = new URL(req.url!, 'http://localhost');
            const isJson = (req.headers['content-type'] || '').includes('json');
            hits.push({ method: req.method!, path: url.pathname, bytes: raw.length, body: isJson && raw.length ? JSON.parse(raw.toString()) : null });
            const json = (status: number, body: any) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (url.pathname.endsWith('/RequestPresignUrls')) return json(200, presignBody());
            if (url.pathname === '/s3/put') {
                if (failFirst.put-- > 0) return json(503, { message: 'SlowDown' });
                return json(200, {});
            }
            if (url.pathname.endsWith('/Image') || url.pathname.endsWith('/StackImage')) {
                if (failFirst.image-- > 0) return json(502, { message: 'Bad Gateway' });
                return json(200, { ErrorCode: 'NoError', ImageTicket: 'T-1' });
            }
            json(404, {});
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(() => {
    hits = [];
    failFirst = { put: 0, image: 0 };
    presignBody = () => ({
        ErrorCode: 'NoError', Message: '',
        PostingUrls: [{ ImageName: 'shirt.jpg', UploadUrl: `${baseUrl}/s3/put`, DownloadUrl: `${baseUrl}/s3/get` }],
    });
});

type Result = { code: number; stdout: string; stderr: string };
function run(cmd: string, args: string[]): Promise<Result> {
    const env = {
        ...process.env,
        PIXELZ_PLATFORM_BASE_URL: baseUrl,
        PIXELZ_PLATFORM_EMAIL: 'test@example.com',
        PIXELZ_PLATFORM_API_KEY: 'test_key',
        PIXELZ_DOTENV_PATH: path.join(REPO_ROOT, 'nonexistent.env'),
    };
    return new Promise(resolve => {
        execFile(cmd, args, { env }, (err, stdout, stderr) => {
            resolve({ code: err && typeof err.code === 'number' ? err.code : 0, stdout, stderr });
        });
    });
}

const tracks = [
    { label: 'node', cmd: process.execPath, cli: NODE_CLI },
    { label: 'python', cmd: 'python', cli: PY_CLI },
] as const;

for (const { label, cmd, cli } of tracks) {
    describe(`platform CLI (${label}) — local file upload`, () => {
        it('accepts the documented presign envelope and submits the DownloadUrl with --template', async () => {
            const r = await run(cmd, [cli, 'upload', imagePath, '--template', '123']);
            expect(r.stderr).toBe('');
            expect(r.code).toBe(0);
            const image = hits.find(h => h.path.endsWith('/Image'))!;
            expect(image.body.imageURL).toBe(`${baseUrl}/s3/get`);
            expect(image.body.templateId).toBe('123');
            expect(image.body).not.toHaveProperty('template');
        }, 60_000);

        it('stack --template reaches the API as templateId', async () => {
            const r = await run(cmd, [cli, 'stack', imagePath, '--template', '456']);
            expect(r.code).toBe(0);
            const stack = hits.find(h => h.path.endsWith('/StackImage'))!;
            expect(stack.body.templateId).toBe('456');
            expect(stack.body).not.toHaveProperty('template');
        }, 60_000);

        it('a retried S3 upload resends the whole file', async () => {
            failFirst.put = 1;
            const r = await run(cmd, [cli, 'upload', imagePath, '--template', '123']);
            expect(r.code).toBe(0);
            const puts = hits.filter(h => h.path === '/s3/put');
            expect(puts).toHaveLength(2);
            expect(puts.map(p => p.bytes)).toEqual([FILE_SIZE, FILE_SIZE]);
        }, 60_000);

        it('never retries the job-creating POST', async () => {
            failFirst.image = 1;
            const r = await run(cmd, [cli, 'upload', 'https://example.com/shirt.jpg', '--template', '123']);
            expect(r.code).toBe(1);
            expect(r.stderr).toContain('[HTTP_502]');
            expect(hits.filter(h => h.path.endsWith('/Image'))).toHaveLength(1);
        }, 60_000);

        it('reports rejected credentials as [AUTH_ERROR], not as a missing upload feature', async () => {
            presignBody = () => ({ ErrorCode: 'InvalidCustomerInformation', Message: 'Could not be validated.', PostingUrls: null });
            const r = await run(cmd, [cli, 'upload', imagePath, '--template', '123']);
            expect(r.code).toBe(1);
            expect(r.stderr.trim().startsWith('[AUTH_ERROR]')).toBe(true);
            expect(r.stderr).not.toContain('PRESIGN_UNAVAILABLE');
        }, 60_000);
    });
}
