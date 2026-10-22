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

// An address that refuses connections, so every command fails the same way in both languages.
const DEAD_URL = 'http://127.0.0.1:9/REST.svc/JSON';

const baseEnv = () => ({
    ...process.env,
    PIXELZ_DOTENV_PATH: path.join(REPO_ROOT, 'nonexistent.env'),
    PIXELZ_PLATFORM_BASE_URL: DEAD_URL,
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

for (const { label, cmd, argv } of tracks) {
    describe(`platform CLI (${label}) — process contract`, () => {
        it('exits non-zero when the request fails', async () => {
            const r = await run(cmd, [...argv, 'get-contact'], withCreds());
            expect(r.code).toBe(1);
        }, 120_000);

        it('reports a network failure as a categorized error, not a stack trace', async () => {
            const r = await run(cmd, [...argv, 'get-contact'], withCreds());
            expect(r.stderr).toContain('[NETWORK_ERROR]');
            expect(r.stderr).not.toContain('Traceback');
        }, 120_000);

        it('sends failure diagnostics to stderr, leaving stdout clean for JSON', async () => {
            const r = await run(cmd, [...argv, 'get-contact'], withCreds());
            expect(r.stdout.trim()).toBe('');
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
        it(`${label}: never emits the key raw or percent-encoded`, async () => {
            const r = await run(cmd, [...argv, 'get-contact'], {
                ...baseEnv(),
                PIXELZ_PLATFORM_EMAIL: AWKWARD_EMAIL,
                PIXELZ_PLATFORM_API_KEY: AWKWARD_KEY,
            });
            const out = r.stdout + r.stderr;
            expect(out).not.toContain(AWKWARD_KEY);
            expect(out).not.toContain(encodeURIComponent(AWKWARD_KEY));
            expect(out).not.toContain(AWKWARD_EMAIL);
            expect(out).not.toContain(encodeURIComponent(AWKWARD_EMAIL));
        }, 120_000);

        // stderr was redacted but PIXELZ_LOG_FILE got the raw exception text, which carries the
        // credentialed request URL — readable by any agent with file access.
        it(`${label}: never writes the key to PIXELZ_LOG_FILE`, async () => {
            const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pixelz-log-')), 'cli.log');
            await run(cmd, [...argv, 'get-contact'], {
                ...baseEnv(),
                PIXELZ_PLATFORM_EMAIL: AWKWARD_EMAIL,
                PIXELZ_PLATFORM_API_KEY: AWKWARD_KEY,
                PIXELZ_LOG_FILE: logFile,
            });
            // Node appends asynchronously; give the write a moment to land after exit.
            await new Promise(r => setTimeout(r, 200));
            const logged = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
            expect(logged).not.toBe('');
            expect(logged).not.toContain(AWKWARD_KEY);
            expect(logged).not.toContain(encodeURIComponent(AWKWARD_KEY));
            expect(logged).not.toContain(AWKWARD_EMAIL);
            expect(logged).not.toContain(encodeURIComponent(AWKWARD_EMAIL));
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
        PIXELZ_AUTOMATION_AUTH_URL: 'http://127.0.0.1:9/token',
        PIXELZ_AUTOMATION_BASE_URL: 'http://127.0.0.1:9/v1',
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
