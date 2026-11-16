import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Argument handling of the Platform CLIs, asserted for BOTH languages with the same input: every
 * rejected invocation must produce the same categorised stderr line and exit code, and must send
 * nothing to the API. Node hand-parses its arguments and Python uses argparse, so without a
 * side-by-side check the two drift (the Node CLI used to request /Image/undefined).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const NODE_CLI = path.join(REPO_ROOT, 'cli-tools/platform/node/cli.js');
const PY_CLI = path.join(REPO_ROOT, 'cli-tools/platform/python/cli.py');

type Result = { code: number | null; stdout: string; stderr: string };
type Recorded = { method: string; path: string; query: URLSearchParams; body: any };

let server: Server;
let baseUrl: string;
let hits: Recorded[] = [];

beforeAll(async () => {
    server = createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            const url = new URL(req.url!, 'http://localhost');
            hits.push({ method: req.method!, path: url.pathname, query: url.searchParams, body: raw ? JSON.parse(raw) : null });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ErrorCode: 'NoError', Images: [] }));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

const env = () => ({
    ...process.env,
    PIXELZ_PLATFORM_BASE_URL: baseUrl,
    PIXELZ_PLATFORM_EMAIL: 'test@example.com',
    PIXELZ_PLATFORM_API_KEY: 'test_key',
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

// [name, args, text the [VALIDATION_ERROR] line must contain]
const REJECTED: [string, string[], string][] = [
    ['status without a ticket', ['status'], 'status requires <ticket>'],
    ['get-template without an id', ['get-template'], 'get-template requires <id>'],
    ['delete without a ticket', ['delete'], 'delete requires <ticket>'],
    ['reject without a comment', ['reject', 'T1'], 'reject requires <comment>'],
    ['reject with an empty comment', ['reject', 'T1', ''], 'reject requires <comment>'],
    ['upload without a path', ['upload', '--template', '1'], 'upload requires <input>'],
    ['upload without --template', ['upload', IMG], 'upload requires --template'],
    ['white-glove without a path', ['white-glove'], 'white-glove requires <input>'],
    ['stack without a path', ['stack'], 'stack requires <input>'],
    ['add-color-library without images', ['add-color-library'], 'add-color-library requires <images>'],
    ['a surplus positional', ['status', 'T1', 'extra'], 'unrecognized arguments: extra'],
    ['a surplus positional on a no-argument command', ['get-contact', 'extra'], 'unrecognized arguments: extra'],
    ['the old positional template on stack', ['stack', IMG, '123'], 'unrecognized arguments: 123'],
    ['an unknown flag', ['list-images', '--stauts', '80'], 'unrecognized arguments: --stauts 80'],
    ['a value flag with no value', ['upload', IMG, '--template', '1', '--comment'], 'argument --comment: expected one argument'],
    ['a value flag followed by another flag', ['upload', IMG, '--comment', '--template', '1'], 'argument --comment: expected one argument'],
    ['a non-numeric --page', ['list-products', '--page', 'abc'], "argument --page: invalid int value: 'abc'"],
    ['a fractional --page', ['list-images', '--page', '1.5'], "argument --page: invalid int value: '1.5'"],
    ['a non-numeric --per-page', ['list-products', '--per-page', 'x'], "invalid int value: 'x'"],
    ['a non-numeric --markerX', ['upload', IMG, '--template', '1', '--markerX', 'left'], "argument --markerX: invalid int value: 'left'"],
    ['a non-numeric --imagesPerPage', ['list-images', '--imagesPerPage', 'many'], "invalid int value: 'many'"],
    ['--imagesPerPage above 100', ['list-images', '--imagesPerPage', '101'], '--imagesPerPage must be between 1 and 100'],
    ['--imagesPerPage of 0', ['list-images', '--imagesPerPage', '0'], '--imagesPerPage must be between 1 and 100'],
    ['an unknown --sortBy', ['list-images', '--sortBy', 'name'], '--sortBy must be one of: id, date, status'],
    ['an unknown --isDescending', ['list-images', '--isDescending', 'yes'], '--isDescending must be true or false'],
    ['a non-hex --swatchColorCode', ['upload', IMG, '--template', '1', '--swatchColorCode', 'red'], '--swatchColorCode must be a hex colour'],
    ['a short hex --swatchColorCode', ['upload', IMG, '--template', '1', '--swatchColorCode', '#FFF'], '--swatchColorCode must be a hex colour'],
    ['unparseable --colorwayIds', ['upload', IMG, '--template', '1', '--colorwayIds', '[1,'], '--colorwayIds is not valid JSON'],
    ['non-array --colorwayIds', ['upload', IMG, '--template', '1', '--colorwayIds', '{"a":1}'], '--colorwayIds must be a JSON array'],
    ['an unsupported local file type', ['upload', path.join(REPO_ROOT, 'package.json'), '--template', '1'], 'Unsupported file type'],
    ['a missing local file', ['white-glove', path.join(REPO_ROOT, 'no-such-image.jpg')], 'Local file not found'],
    ['an invalid ticket', ['status', 'a/b'], 'Invalid imageTicket'],
];

describe('platform CLI (node and python) — rejected invocations', () => {
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

describe('platform CLI (node and python) — command line shape', () => {
    it('an unknown command writes usage to stderr and exits 2', async () => {
        hits = [];
        for (const r of await Promise.all([runNode(['frobnicate']), runPy(['frobnicate'])])) {
            expect(r.code).toBe(2);
            expect(r.stdout).toBe('');
            expect(r.stderr).toContain("[VALIDATION_ERROR] unknown command 'frobnicate'");
            expect(r.stderr).toContain('list-templates');
        }
        expect(hits).toEqual([]);
    });

    it('inherited object keys are not commands', async () => {
        const [n, p] = await Promise.all([runNode(['constructor']), runPy(['constructor'])]);
        expect([n.code, p.code]).toEqual([2, 2]);
    });

    it('no command prints usage on stdout and exits 0', async () => {
        for (const r of await Promise.all([runNode([]), runPy([])])) {
            expect(r.code).toBe(0);
            expect(r.stdout.toLowerCase()).toContain('usage');
            expect(r.stderr).toBe('');
        }
    });

    it('--help prints usage on stdout and exits 0', async () => {
        for (const r of await Promise.all([runNode(['--help']), runPy(['--help'])])) {
            expect(r.code).toBe(0);
            expect(r.stdout.toLowerCase()).toContain('usage');
            expect(r.stderr).toBe('');
        }
    });

    it('help says --status takes any numeric code and names only four aliases', async () => {
        const [n, p] = await Promise.all([runNode(['--help']), runPy(['list-images', '--help'])]);
        for (const out of [n.stdout, p.stdout]) {
            const text = out.replace(/\s+/g, ' ');
            expect(text.toLowerCase()).toContain('any numeric');
            expect(text).toMatch(/new.*in production.*production finished.*delivered/);
        }
        expect(n.stdout).not.toContain('[--transparent]');
    });
});

describe('platform CLI (node and python) — accepted invocations reach the API unchanged', () => {
    it('--comment true is sent as the string "true"', async () => {
        for (const run of [runNode, runPy]) {
            hits = [];
            const r = await run(['upload', IMG, '--template', '7', '--comment', 'true']);
            expect(r.code).toBe(0);
            expect(hits).toHaveLength(1);
            expect(hits[0].body.comment).toBe('true');
            expect(hits[0].body.templateId).toBe('7');
        }
    });

    it('integer flags are sent as numbers and --colorwayIds as an array', async () => {
        for (const run of [runNode, runPy]) {
            hits = [];
            const r = await run(['upload', IMG, '--template', '7', '--markerX', '10', '--markerY', '20',
                '--swatchColorCode', '#FF5733', '--colorwayIds', '[1,2]']);
            expect(r.code).toBe(0);
            expect(hits[0].body).toMatchObject({ markerX: 10, markerY: 20, swatchColorCode: '#FF5733', colorwayIds: [1, 2] });
        }
    });

    it('--templateId is accepted as an alias of --template on upload and stack', async () => {
        for (const run of [runNode, runPy]) {
            hits = [];
            await run(['stack', IMG, '--templateId', '9']);
            expect(hits[0].body.templateId).toBe('9');
        }
    });

    it('--perPage is accepted as an alias of --per-page', async () => {
        for (const run of [runNode, runPy]) {
            hits = [];
            await run(['list-products', '--perPage', '5']);
            expect(hits[0].query.get('productIdsPerPage')).toBe('5');
        }
    });

    it('--status passes any numeric code through and --imagesPerPage 100 is allowed', async () => {
        for (const run of [runNode, runPy]) {
            hits = [];
            const r = await run(['list-images', '--status', '75', '--imagesPerPage', '100', '--sortBy', 'date', '--isDescending', 'true']);
            expect(r.code).toBe(0);
            expect(hits[0].query.get('imageStatus')).toBe('75');
            expect(hits[0].query.get('imagesPerPage')).toBe('100');
            expect(hits[0].query.get('isDescending')).toBe('true');
        }
    });

    it('--flag=value is accepted', async () => {
        for (const run of [runNode, runPy]) {
            hits = [];
            const r = await run(['reject', 'T1', 'bad edges', '--customer-id=C-1']);
            expect(r.code).toBe(0);
            expect(hits[0].path).toBe('/Image/Reject/T1');
            expect(hits[0].body).toMatchObject({
                contactEmail: 'test@example.com', contactAPIkey: 'test_key',
                imageTicket: 'T1', comment: 'bad edges', customerImageId: 'C-1',
            });
            expect(hits[0].body.markupImageUrl).toBeUndefined();
        }
    });
});
