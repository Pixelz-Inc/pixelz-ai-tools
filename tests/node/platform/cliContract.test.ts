import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The CLI's *process* contract, asserted identically for both language tracks.
 *
 * The flag-mapping tests in cliFlags.test.ts only exercise success paths, so a whole class
 * of defect went unnoticed: the Python CLI printed a diagnostic and exited 0 on every
 * failure, and sent [AUTH_ERROR] to stdout where callers parse JSON. Both are invisible to
 * a test that only checks the happy path, and both broke the dual-language parity
 * invariant. These assertions are the cheap guard against that regressing.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const NODE_CLI = path.join(REPO_ROOT, 'cli-tools/platform/node/cli.js');
const PY_CLI = path.join(REPO_ROOT, 'cli-tools/platform/python/cli.py');

type Result = { code: number | null; stdout: string; stderr: string };

/** Never rejects — we assert on the exit code, so a non-zero exit is the expected case. */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
    return new Promise(resolve => {
        const child = execFile(cmd, args, { env }, (err, stdout, stderr) => {
            resolve({ code: err && typeof err.code === 'number' ? err.code : 0, stdout, stderr });
        });
        child.on('error', () => resolve({ code: -1, stdout: '', stderr: '' }));
    });
}

// A port that was just freed, so connecting is refused (ECONNREFUSED) in both languages. Not
// port 9: fetch blocks it outright ("bad port") without opening a socket, so the Node side
// never exercised a real connection failure.
let DEAD_PORT: number;
const deadUrl = (suffix = '/REST.svc/JSON') => `http://127.0.0.1:${DEAD_PORT}${suffix}`;
beforeAll(async () => {
    const s = createServer();
    await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
    DEAD_PORT = (s.address() as { port: number }).port;
    await new Promise<void>(resolve => s.close(() => resolve()));
});

const baseEnv = () => ({
    ...process.env,
    PIXELZ_DOTENV_PATH: path.join(REPO_ROOT, 'nonexistent.env'),
    PIXELZ_PLATFORM_BASE_URL: deadUrl(),
});

const withCreds = () => ({
    ...baseEnv(),
    PIXELZ_PLATFORM_EMAIL: 'test@example.com',
    PIXELZ_PLATFORM_API_KEY: 'test_key',
});

const noCreds = () => {
    const env = baseEnv();
    delete env.PIXELZ_PLATFORM_EMAIL;
    delete env.PIXELZ_PLATFORM_API_KEY;
    return env;
};

const tracks = [
    { label: 'node', cmd: process.execPath, argv: [NODE_CLI] },
    { label: 'python', cmd: 'python', argv: [PY_CLI] },
] as const;

// Every group below spawns slow failure runs (Python's connect retries cost ~15 s each on
// Windows) and none share mutable state, so all of them run side by side.
describe.concurrent('CLI process contract', () => {
for (const { label, cmd, argv } of tracks) {
    describe.concurrent(`platform CLI (${label}) — process contract`, () => {
        // One failing run feeds three assertions: each run pays Python's connect retries (~15 s
        // on Windows), and these used to be three identical runs.
        let failed: Promise<Result>;
        beforeAll(() => { failed = run(cmd, [...argv, 'get-contact'], withCreds()); });

        it('exits non-zero when the request fails', async () => {
            expect((await failed).code).toBe(1);
        }, 120_000);

        it('reports a network failure as a categorized error, not a stack trace', async () => {
            const r = await failed;
            expect(r.stderr).toContain('[NETWORK_ERROR]');
            expect(r.stderr).not.toContain('Traceback');
        }, 120_000);

        it('sends failure diagnostics to stderr, leaving stdout clean for JSON', async () => {
            expect((await failed).stdout.trim()).toBe('');
        }, 120_000);

        it('reports missing credentials as [AUTH_ERROR] on stderr and exits non-zero', async () => {
            const r = await run(cmd, [...argv, 'get-contact'], noCreds());
            expect(r.stderr).toContain('[AUTH_ERROR]');
            expect(r.stdout).not.toContain('[AUTH_ERROR]');
            expect(r.code).toBe(1);
        }, 120_000);
    });
}

describe('platform CLI — credential redaction in failure output', () => {
    // A base64-shaped key: every one of + / = is percent-encoded inside a URL, which is
    // exactly what defeated a literal-match redactor and leaked the key to the agent.
    const AWKWARD_KEY = 'ab+cd/ef=gh';
    const AWKWARD_EMAIL = 'leaky@example.com';

    for (const { label, cmd, argv } of tracks) {
        // stderr was redacted but PIXELZ_LOG_FILE once got the raw exception text, which carries
        // the credentialed request URL — readable by any agent with file access.
        it.concurrent(`${label}: never emits the key, raw or encoded, to stderr or PIXELZ_LOG_FILE`, async () => {
            const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pixelz-log-')), 'cli.log');
            const r = await run(cmd, [...argv, 'get-contact'], {
                ...baseEnv(),
                PIXELZ_PLATFORM_EMAIL: AWKWARD_EMAIL,
                PIXELZ_PLATFORM_API_KEY: AWKWARD_KEY,
                PIXELZ_LOG_FILE: logFile,
            });
            const logged = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
            // The failure itself must be logged, or this would pass without testing anything.
            expect(logged).toContain('get-contact failed');
            for (const out of [r.stdout + r.stderr, logged]) {
                expect(out).not.toContain(AWKWARD_KEY);
                expect(out).not.toContain(encodeURIComponent(AWKWARD_KEY));
                expect(out).not.toContain(AWKWARD_EMAIL);
                expect(out).not.toContain(encodeURIComponent(AWKWARD_EMAIL));
            }
        }, 120_000);
    }
});

describe('automation CLI — credential redaction and error contract', () => {
    const AUTOMATION_CLI_NODE = path.join(REPO_ROOT, 'cli-tools/automation/node/cli.js');
    const AUTOMATION_CLI_PY = path.join(REPO_ROOT, 'cli-tools/automation/python/cli.py');
    const SECRET = 'sec+ret/val=ue';

    const autoEnv = () => ({
        ...process.env,
        PIXELZ_DOTENV_PATH: path.join(REPO_ROOT, 'nonexistent.env'),
        PIXELZ_AUTOMATION_AUTH_URL: deadUrl('/token'),
        PIXELZ_AUTOMATION_BASE_URL: deadUrl('/v1'),
        PIXELZ_AUTOMATION_CLIENT_ID: 'client+id',
        PIXELZ_AUTOMATION_CLIENT_SECRET: SECRET,
    });

    for (const [label, cmd, cli] of [
        ['node', process.execPath, AUTOMATION_CLI_NODE],
        ['python', 'python', AUTOMATION_CLI_PY],
    ] as const) {
        it(`${label}: a failed token exchange is categorized, redacted, and exits 1`, async () => {
            const r = await run(cmd, [cli, 'get-key'], autoEnv());
            const out = r.stdout + r.stderr;
            expect(out).not.toContain(SECRET);
            expect(out).not.toContain(encodeURIComponent(SECRET));
            // The OAuth failure must not surface as a raw interpreter stack trace.
            expect(out).not.toContain('Traceback');
            expect(r.code).toBe(1);
        }, 120_000);
    }
});
});
