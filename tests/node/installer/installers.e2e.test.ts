import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs the real install/uninstall wrappers non-interactively (flags only, stdin closed) for the
 * Node Skills track, which needs no network: it copies files and rewrites SKILL.md. Registered
 * agents, the real HOME and the real `claude` CLI are kept out of reach.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPTS = path.join(REPO_ROOT, 'scripts');
const PACKAGE_VERSION: string = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const fwd = (p: string) => p.replace(/\\/g, '/');

/** Git Bash on Windows: the `bash` first on PATH is often WSL's launcher, which cannot run these scripts. */
function findBash(): string | null {
    if (process.platform !== 'win32') {
        return spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0 ? 'bash' : null;
    }
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
        .filter((r): r is string => !!r);
    const candidates = roots.flatMap(r => [path.join(r, 'Git', 'bin', 'bash.exe'), path.join(r, 'Git', 'usr', 'bin', 'bash.exe')]);
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!/windowsapps|system32/i.test(dir)) candidates.push(path.join(dir, 'bash.exe'));
    }
    return candidates.find(c => fs.existsSync(c)) ?? null;
}

const BASH = findBash();
const PLACEHOLDER = '// placeholder created by installers.e2e.test.ts\n';
const sharedNode = path.join(REPO_ROOT, 'shared', 'node');
let createdShared = false;

// The CLIs' shared module may not exist yet in a checkout; a Skills install needs it, so
// provide a throwaway one and take it away again without touching anything real.
beforeAll(() => {
    if (fs.existsSync(sharedNode)) return;
    fs.mkdirSync(sharedNode, { recursive: true });
    fs.writeFileSync(path.join(sharedNode, 'pixelz-common.js'), PLACEHOLDER);
    createdShared = true;
});

afterAll(() => {
    if (!createdShared) return;
    const file = path.join(sharedNode, 'pixelz-common.js');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === PLACEHOLDER) {
        fs.rmSync(file);
        for (const dir of [sharedNode, path.dirname(sharedNode)]) {
            try { fs.rmdirSync(dir); } catch { /* not empty: someone else's files */ }
        }
    }
});

let root: string;
let home: string;
let target: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelz-e2e-'));
    home = path.join(root, 'home');
    target = path.join(root, 'my project');
    fs.mkdirSync(home, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

type Result = { code: number; stdout: string; stderr: string };
function exec(cmd: string, args: string[]): Promise<Result> {
    const env: NodeJS.ProcessEnv = {
        ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
        PIXELZ_CLAUDE_BIN: 'pixelz-test-no-such-claude',
    };
    return new Promise(resolve => {
        const child = execFile(cmd, args, { env }, (err, stdout, stderr) => {
            resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
        });
        child.stdin?.end(); // no terminal: a prompt would otherwise hang the test
    });
}

/** The real path, case-folded on Windows, so the expected CLI location compares reliably. */
const canon = (p: string) => (process.platform === 'win32' ? fwd(fs.realpathSync(p)).toLowerCase() : fs.realpathSync(p));

function assertInstalled() {
    const pixelz = path.join(target, '.pixelz');
    expect(fs.existsSync(path.join(pixelz, 'cli-tools', 'platform', 'node', 'cli.js'))).toBe(true);
    expect(fs.existsSync(path.join(pixelz, 'shared', 'node'))).toBe(true);
    expect(fs.readdirSync(path.join(pixelz, 'shared', 'node')).length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(pixelz, 'VERSION'), 'utf8')).toBe(`${PACKAGE_VERSION}\n`);
    expect(fs.existsSync(path.join(pixelz, '.env'))).toBe(true);
    expect(fs.readFileSync(path.join(pixelz, '.gitignore'), 'utf8').trim()).toBe('*');
    const md = fs.readFileSync(path.join(target, '.agents', 'skills', 'platform-upload-image', 'SKILL.md'), 'utf8');
    expect(md).not.toMatch(/node cli-tools\//);
    const m = md.match(/node "([^"]+\/\.pixelz\/cli-tools\/platform\/node\/cli\.js)" upload/);
    expect(m, 'SKILL.md should invoke the absolute .pixelz CLI path').not.toBeNull();
    expect(canon(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(m![1]))))))).toBe(canon(target));
}

function assertUninstalled() {
    expect(fs.existsSync(path.join(target, '.pixelz'))).toBe(false);
    const skills = path.join(target, '.agents', 'skills');
    expect(!fs.existsSync(skills) || fs.readdirSync(skills).length === 0).toBe(true);
}

describe('installers, non-interactive (Node Skills track, local scope)', () => {
    it.skipIf(!BASH)('bash: install.sh then uninstall.sh with flags only', async () => {
        const install = await exec(BASH!, [path.join(SCRIPTS, 'install.sh'), '--lang', 'node', '--track', 'skills',
            '--agent', 'universal', '--scope', 'local', '--target', fwd(target)]);
        expect(install.code, install.stdout + install.stderr).toBe(0);
        expect(install.stdout).toContain(`Pixelz AI Tools version: ${PACKAGE_VERSION}`);
        assertInstalled();

        const uninstall = await exec(BASH!, [path.join(SCRIPTS, 'uninstall.sh'), '--agent', 'universal', '--target', fwd(target)]);
        expect(uninstall.code, uninstall.stdout + uninstall.stderr).toBe(0);
        assertUninstalled();
    }, 120_000);

    it.skipIf(!BASH)('bash: exits 1 listing the flags instead of prompting when values are missing', async () => {
        const r = await exec(BASH!, [path.join(SCRIPTS, 'install.sh'), '--lang', 'node']);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('--track --agent --scope');
    }, 60_000);

    it.skipIf(!BASH)('bash: rejects an unknown agent and an agent without the chosen track', async () => {
        const base = [path.join(SCRIPTS, 'install.sh'), '--lang', 'node', '--scope', 'global'];
        const unknown = await exec(BASH!, [...base, '--track', 'skills', '--agent', 'nope']);
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toContain("unknown agent 'nope'");
        const noTrack = await exec(BASH!, [...base, '--track', 'mcp', '--agent', 'universal']);
        expect(noTrack.code).toBe(1);
        expect(noTrack.stderr).toContain('does not support the mcp track');
        const badScope = await exec(BASH!, [...base.slice(0, 3), '--scope', 'everywhere', '--track', 'skills', '--agent', 'claude']);
        expect(badScope.code).toBe(1);
        expect(badScope.stderr).toContain('--scope must be global or local');
    }, 60_000);

    it.skipIf(process.platform !== 'win32')('powershell: install.ps1 then uninstall.ps1 with parameters only', async () => {
        const ps = (script: string, ...args: string[]) => exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, script), ...args]);
        const install = await ps('install.ps1', '-Lang', 'node', '-Track', 'skills', '-Agent', 'universal', '-Scope', 'local', '-Target', target);
        expect(install.code, install.stdout + install.stderr).toBe(0);
        expect(install.stdout).toContain(`Pixelz AI Tools version: ${PACKAGE_VERSION}`);
        assertInstalled();

        const uninstall = await ps('uninstall.ps1', '-Agent', 'universal', '-Target', target);
        expect(uninstall.code, uninstall.stdout + uninstall.stderr).toBe(0);
        assertUninstalled();
    }, 120_000);

    it.skipIf(process.platform !== 'win32')('powershell: exits 1 listing the parameters instead of prompting when values are missing', async () => {
        const r = await exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'install.ps1'), '-Lang', 'node']);
        expect(r.code).toBe(1);
        expect(r.stdout).toContain('-Track -Agent -Scope');
    }, 60_000);
});
