import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The installers had no automated coverage, and it showed: uninstall deleted the user's whole
 * skills directory, OpenCode got a config key it ignores, Windsurf/OpenCode skills landed in
 * directories neither tool reads. Everything that touches an agent's config now goes through
 * scripts/agent-config.mjs / agent_config.py, so it is asserted here — for both helpers, which
 * must write byte-identical files — against a throwaway HOME.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKILLS_SRC = path.join(REPO_ROOT, 'skills');
const AGENTS: Record<string, any> = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts/agents.json'), 'utf8')).agents;
const SKILL_COUNT = fs.readdirSync(SKILLS_SRC, { withFileTypes: true }).filter(d => d.isDirectory()).length;

const helpers = [
    { label: 'node', cmd: process.execPath, script: path.join(REPO_ROOT, 'scripts/agent-config.mjs') },
    { label: 'python', cmd: 'python', script: path.join(REPO_ROOT, 'scripts/agent_config.py') },
] as const;

let home: string;
let target: string;

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelz-agents-'));
    home = path.join(root, 'home');
    target = path.join(root, 'project');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
});

type Result = { code: number; stdout: string; stderr: string };
function run(h: (typeof helpers)[number], args: string[], platform = 'linux'): Promise<Result> {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
        PIXELZ_INSTALL_PLATFORM: platform,
        // Never reach the real Claude Code CLI, which would edit the developer's own config.
        PIXELZ_CLAUDE_BIN: 'pixelz-test-no-such-claude',
    };
    for (const k of ['XDG_CONFIG_HOME', 'CODEX_HOME', 'COPILOT_HOME']) delete env[k];
    return new Promise(resolve => {
        execFile(h.cmd, [h.script, ...args], { env }, (err, stdout, stderr) => {
            resolve({ code: err && typeof err.code === 'number' ? err.code : 0, stdout, stderr });
        });
    });
}

const fwd = (p: string) => p.replace(/\\/g, '/');
const MCP = ['--cmd', 'node', '--platform', '/opt/pixelz/platform.js', '--automation', '/opt/pixelz/automation.js'];

/** Every file under dir, as {relative path: content}. */
function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (e.isFile()) {
            const full = path.join(e.parentPath, e.name);
            out[fwd(path.relative(dir, full))] = fs.readFileSync(full, 'utf8');
        }
    }
    return out;
}

/** Resolve a {home}/... template the way the helpers do, for the given platform. */
function resolve(spec: any, platform: string): string | null {
    const t = typeof spec === 'string' ? spec : spec?.[platform === 'win32' ? 'win32' : 'posix'];
    if (!t) return null;
    return fwd(t
        .replace('{home}', home).replace('{target}', target)
        .replace('{appdata}', path.join(home, 'AppData', 'Roaming'))
        .replace('{xdg_config}', path.join(home, '.config'))
        .replace('{codex_home}', path.join(home, '.codex'))
        .replace('{copilot_home}', path.join(home, '.copilot')));
}

const fileAgents = Object.entries(AGENTS).filter(([, a]) => a.mcp?.global?.file);

describe('agent helper — Node and Python twins agree', () => {
    it('list the same agents for each track', async () => {
        for (const track of ['mcp', 'skills', '']) {
            const args = track ? ['list', '--track', track] : ['list'];
            const [n, p] = await Promise.all(helpers.map(h => run(h, args)));
            expect(n.code).toBe(0);
            expect(p.stdout.replace(/\r/g, '')).toBe(n.stdout);
        }
    }, 60_000);

    for (const [id] of fileAgents) {
        for (const platform of ['linux', 'win32']) {
            it(`${id} (${platform}): register-mcp writes byte-identical config`, async () => {
                const snaps: Record<string, string>[] = [];
                for (const h of helpers) {
                    fs.rmSync(home, { recursive: true, force: true });
                    fs.mkdirSync(home, { recursive: true });
                    const r = await run(h, ['register-mcp', '--agent', id, '--scope', 'global', ...MCP], platform);
                    expect(r.stderr).toBe('');
                    expect(r.code).toBe(0);
                    snaps.push(snapshot(home));
                }
                expect(Object.keys(snaps[0]).length).toBeGreaterThan(0);
                expect(snaps[1]).toEqual(snaps[0]);
            }, 60_000);
        }
    }

    it('install-skills deploys byte-identical skills', async () => {
        const snaps: Record<string, string>[] = [];
        for (const h of helpers) {
            fs.rmSync(home, { recursive: true, force: true });
            fs.mkdirSync(home, { recursive: true });
            await run(h, ['install-skills', '--agent', 'claude', '--scope', 'global', '--src', SKILLS_SRC,
                '--cli-root', '/opt/pixelz/cli-tools', '--runtime', 'node']);
            snaps.push(snapshot(home));
        }
        expect(snaps[1]).toEqual(snaps[0]);
    }, 60_000);
});

for (const h of helpers) {
    describe(`agent helper (${h.label})`, () => {
        for (const [id, agent] of fileAgents) {
            it(`${id}: registers both servers where the agent reads them`, async () => {
                const spec = agent.mcp.global;
                const r = await run(h, ['register-mcp', '--agent', id, '--scope', 'global', ...MCP]);
                expect(r.code).toBe(0);
                const file = resolve(spec.file, 'linux')!;
                const text = fs.readFileSync(file, 'utf8');
                expect(text.charCodeAt(0)).not.toBe(0xfeff);
                if (spec.format === 'codex-toml') {
                    expect(text).toContain('[mcp_servers.pixelz-platform]');
                    expect(text).toContain('args = ["/opt/pixelz/automation.js"]');
                } else {
                    const servers = JSON.parse(text)[spec.format === 'opencode' ? 'mcp' : 'mcpServers'];
                    expect(Object.keys(servers).sort()).toEqual(['pixelz-automation', 'pixelz-platform']);
                    const e = servers['pixelz-platform'];
                    if (spec.format === 'opencode') expect(e).toMatchObject({ type: 'local', command: ['node', '/opt/pixelz/platform.js'] });
                    else expect(e).toMatchObject({ command: 'node', args: ['/opt/pixelz/platform.js'] });
                }
            }, 30_000);

            it(`${id}: keeps the user's other servers and settings, and unregister removes only ours`, async () => {
                const spec = agent.mcp.global;
                const file = resolve(spec.file, 'linux')!;
                fs.mkdirSync(path.dirname(file), { recursive: true });
                const original = spec.format === 'codex-toml'
                    ? 'model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine"\nargs = []\n'
                    : JSON.stringify({ theme: 'dark', [spec.format === 'opencode' ? 'mcp' : 'mcpServers']: { mine: { command: 'mine' } } }, null, 2) + '\n';
                fs.writeFileSync(file, original);

                await run(h, ['register-mcp', '--agent', id, '--scope', 'global', ...MCP]);
                // Twice: re-running the installer must not duplicate entries.
                await run(h, ['register-mcp', '--agent', id, '--scope', 'global', ...MCP]);
                const merged = fs.readFileSync(file, 'utf8');
                expect(merged).toContain('mine');
                expect(merged.split('pixelz-platform').length - 1).toBe(1);
                expect(fs.existsSync(`${file}.pixelz-backup`)).toBe(true);

                const r = await run(h, ['unregister-mcp', '--agent', id, '--scope', 'global']);
                expect(r.code).toBe(0);
                const after = fs.readFileSync(file, 'utf8');
                expect(after).not.toContain('pixelz');
                if (spec.format === 'codex-toml') expect(after.trim()).toBe(original.trim());
                else expect(JSON.parse(after)).toEqual(JSON.parse(original));
            }, 30_000);
        }

        it('never overwrites a config file it cannot parse', async () => {
            const [id, agent] = fileAgents.find(([, a]) => a.mcp.global.format !== 'codex-toml')!;
            const file = resolve(agent.mcp.global.file, 'linux')!;
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const jsonc = '{\n  // my comment\n  "mcpServers": {}\n}\n';
            fs.writeFileSync(file, jsonc);
            const r = await run(h, ['register-mcp', '--agent', id, '--scope', 'global', ...MCP]);
            expect(r.code).toBe(0);
            expect(r.stdout).toContain('WARNING');
            expect(r.stdout).toContain('pixelz-platform');
            expect(fs.readFileSync(file, 'utf8')).toBe(jsonc);
        }, 30_000);

        it('claude local: writes .mcp.json with the local .env path', async () => {
            const dotenv = path.join(target, '.pixelz', '.env');
            await run(h, ['register-mcp', '--agent', 'claude', '--scope', 'local', '--target', target, ...MCP, '--dotenv', dotenv]);
            const cfg = JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'));
            expect(cfg.mcpServers['pixelz-platform'].env).toEqual({ PIXELZ_DOTENV_PATH: fwd(dotenv) });
        }, 30_000);

        it('claude global without the CLI: prints the commands instead of failing', async () => {
            const r = await run(h, ['register-mcp', '--agent', 'claude', '--scope', 'global', ...MCP]);
            expect(r.code).toBe(0);
            expect(r.stdout).toContain('claude mcp add --scope user --transport stdio pixelz-platform -- node "/opt/pixelz/platform.js"');
            expect(snapshot(home)).toEqual({});
        }, 30_000);

        it('install-skills: deploys every skill with an absolute, quoted CLI path', async () => {
            const dir = resolve(AGENTS.claude.skills.global, 'linux')!;
            const r = await run(h, ['install-skills', '--agent', 'claude', '--scope', 'global', '--src', SKILLS_SRC,
                '--cli-root', '/opt/my pixelz/cli-tools', '--runtime', 'python3']);
            expect(r.code).toBe(0);
            const md = fs.readFileSync(path.join(dir, 'platform-upload-image', 'SKILL.md'), 'utf8');
            expect(md).toContain('python3 "/opt/my pixelz/cli-tools/platform/python/cli.py" upload');
            const all = Object.values(snapshot(dir)).join('\n');
            expect(all).not.toMatch(/node cli-tools\//);
            expect(fs.readdirSync(dir)).toHaveLength(SKILL_COUNT);
        }, 30_000);

        it("remove-skills: removes only Pixelz skills, never the user's own", async () => {
            const dir = resolve(AGENTS.claude.skills.global, 'linux')!;
            fs.mkdirSync(path.join(dir, 'my-own-skill'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'my-own-skill', 'SKILL.md'), 'mine');
            await run(h, ['install-skills', '--agent', 'claude', '--scope', 'global', '--src', SKILLS_SRC,
                '--cli-root', '/x', '--runtime', 'node']);
            const r = await run(h, ['remove-skills', '--agent', 'claude', '--scope', 'global', '--src', SKILLS_SRC]);
            expect(r.code).toBe(0);
            expect(fs.readdirSync(dir)).toEqual(['my-own-skill']);
        }, 30_000);

        it('every agent resolves a skills directory for both scopes', async () => {
            for (const [id, agent] of Object.entries(AGENTS)) {
                if (!agent.skills) continue;
                for (const scope of ['global', 'local']) {
                    const r = await run(h, ['skills-dir', '--agent', id, '--scope', scope, '--target', target]);
                    expect(r.code, `${id} ${scope}: ${r.stderr}`).toBe(0);
                    expect(r.stdout.trim()).toBe(resolve(agent.skills[scope], 'linux'));
                }
            }
        }, 60_000);

        it('windsurf: uses %APPDATA% on Windows, and falls back to the user config for a local install', async () => {
            await run(h, ['register-mcp', '--agent', 'windsurf', '--scope', 'global', ...MCP], 'win32');
            expect(fs.existsSync(path.join(home, 'AppData', 'Roaming', 'devin', 'mcp_config.json'))).toBe(true);
            const r = await run(h, ['register-mcp', '--agent', 'windsurf', '--scope', 'local', '--target', target, ...MCP]);
            expect(r.stdout).toContain('no project-level MCP config');
            expect(fs.existsSync(path.join(home, '.config', 'devin', 'mcp_config.json'))).toBe(true);
        }, 30_000);

        it('uninstall also cleans up where older installer versions wrote', async () => {
            // Old Gemini CLI registration, old skills dir and the old reference config.
            fs.mkdirSync(path.join(home, '.gemini', 'skills', 'platform-upload-image'), { recursive: true });
            fs.mkdirSync(path.join(home, '.gemini', 'skills', 'my-own-skill'), { recursive: true });
            fs.writeFileSync(path.join(home, '.gemini', 'pixelz_config.json'), '{}');
            fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
                theme: 'x', mcpServers: { 'pixelz-platform': { command: 'node' }, mine: { command: 'm' } },
            }));
            await run(h, ['unregister-mcp', '--agent', 'antigravity', '--scope', 'global']);
            await run(h, ['remove-skills', '--agent', 'antigravity', '--scope', 'global', '--src', SKILLS_SRC]);
            expect(fs.readdirSync(path.join(home, '.gemini', 'skills'))).toEqual(['my-own-skill']);
            expect(fs.existsSync(path.join(home, '.gemini', 'pixelz_config.json'))).toBe(false);
            const settings = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
            expect(settings).toEqual({ theme: 'x', mcpServers: { mine: { command: 'm' } } });
        }, 30_000);

        // ---- data safety: these are the user's files ----

        it('keeps the ORIGINAL file as the backup, even after a second install', async () => {
            const file = path.join(home, '.cursor', 'mcp.json');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const original = '{\r\n    "theme": "mine"\r\n}\r\n';
            fs.writeFileSync(file, original);
            await run(h, ['register-mcp', '--agent', 'cursor', '--scope', 'global', ...MCP]);
            await run(h, ['register-mcp', '--agent', 'cursor', '--scope', 'global', ...MCP]);
            expect(fs.readFileSync(`${file}.pixelz-backup`, 'utf8')).toBe(original);
            // ...and the rewrite keeps the file's CRLF line endings.
            const now = fs.readFileSync(file, 'utf8');
            expect(now).toContain('\r\n');
            expect(now.replace(/\r\n/g, '')).not.toContain('\n');
        }, 30_000);

        for (const [what, bytes] of [
            ['a cp1252 file', Buffer.from('{"note": "caf\xe9"}', 'latin1')],
            ['a UTF-16 file', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a": 1}', 'utf16le')])],
            ['mcpServers that is not an object', Buffer.from('{"mcpServers": "oops"}')],
            ['an integer JavaScript would round', Buffer.from('{"id": 12345678901234567890}')],
        ] as const) {
            it(`leaves ${what} untouched and prints the entries instead`, async () => {
                const file = path.join(home, '.cursor', 'mcp.json');
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, bytes);
                const r = await run(h, ['register-mcp', '--agent', 'cursor', '--scope', 'global', ...MCP]);
                expect(r.code).toBe(0);
                expect(r.stdout).toContain('WARNING');
                expect(fs.readFileSync(file).equals(bytes)).toBe(true);
                const u = await run(h, ['unregister-mcp', '--agent', 'cursor', '--scope', 'global']);
                expect(u.code, u.stderr).toBe(0);
                expect(fs.readFileSync(file).equals(bytes)).toBe(true);
            }, 30_000);
        }

        describe('codex config.toml', () => {
            const file = () => path.join(home, '.codex', 'config.toml');
            const write = (text: string) => { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), text); };

            it('leaves a pixelz server written as an inline table alone', async () => {
                const original = '[mcp_servers]\npixelz-platform = { command = "x" }\n';
                write(original);
                const r = await run(h, ['register-mcp', '--agent', 'codex', '--scope', 'global', ...MCP]);
                expect(r.stdout).toContain('WARNING');
                expect(fs.readFileSync(file(), 'utf8')).toBe(original);
            }, 30_000);

            it('does not mistake a string that starts with a pixelz name for a server', async () => {
                write('[profiles.x]\nflags = [\n  "pixelz-automation=on",\n]\n');
                const r = await run(h, ['register-mcp', '--agent', 'codex', '--scope', 'global', ...MCP]);
                expect(r.stdout).not.toContain('WARNING');
                const text = fs.readFileSync(file(), 'utf8');
                expect(text).toContain('"pixelz-automation=on"');
                expect(text).toContain('[mcp_servers.pixelz-platform]');
            }, 30_000);

            it("keeps the comments above the user's next table", async () => {
                await run(h, ['register-mcp', '--agent', 'codex', '--scope', 'global', ...MCP]);
                fs.appendFileSync(file(), '\n# my github server\n[mcp_servers.github]\ncommand = "gh"\n');
                await run(h, ['register-mcp', '--agent', 'codex', '--scope', 'global', ...MCP]);
                const text = fs.readFileSync(file(), 'utf8');
                expect(text).toMatch(/# my github server\n\[mcp_servers\.github\]/);
                expect(text.split('[mcp_servers.pixelz-platform]').length - 1).toBe(1);
            }, 30_000);

            it('removes sub-tables a user added under our servers', async () => {
                await run(h, ['register-mcp', '--agent', 'codex', '--scope', 'global', ...MCP]);
                fs.appendFileSync(file(), '\n[mcp_servers.pixelz-platform.env_http_headers]\nX = "1"\n');
                await run(h, ['unregister-mcp', '--agent', 'codex', '--scope', 'global']);
                expect(fs.existsSync(file()) ? fs.readFileSync(file(), 'utf8') : '').not.toContain('pixelz');
            }, 30_000);
        });

        it("in-use: reports another agent still using the project's .pixelz/", async () => {
            const cliRoot = path.join(target, '.pixelz', 'cli-tools');
            await run(h, ['install-skills', '--agent', 'claude', '--scope', 'local', '--target', target, '--src', SKILLS_SRC, '--cli-root', cliRoot, '--runtime', 'node']);
            await run(h, ['register-mcp', '--agent', 'cursor', '--scope', 'local', '--target', target, ...MCP, '--dotenv', path.join(target, '.pixelz', '.env')]);
            const both = await run(h, ['in-use', '--target', target, '--src', SKILLS_SRC]);
            expect(both.stdout.trim().split(/\r?\n/).sort()).toEqual(['claude', 'cursor']);
            const others = await run(h, ['in-use', '--target', target, '--src', SKILLS_SRC, '--exclude', 'claude']);
            expect(others.stdout.trim()).toBe('cursor');
            await run(h, ['unregister-mcp', '--agent', 'cursor', '--scope', 'local', '--target', target]);
            const none = await run(h, ['in-use', '--target', target, '--src', SKILLS_SRC, '--exclude', 'claude']);
            expect(none.stdout.trim()).toBe('');
        }, 60_000);

        it('in-use: matches the target case-insensitively on Windows', async () => {
            // Installed as one spelling, uninstalled as another: a miss here deleted .pixelz/.
            await run(h, ['register-mcp', '--agent', 'windsurf', '--scope', 'local', '--target', target, ...MCP,
                '--dotenv', path.join(target, '.pixelz', '.env')], 'win32');
            const r = await run(h, ['in-use', '--target', target.toUpperCase(), '--src', SKILLS_SRC], 'win32');
            expect(r.stdout.trim()).toBe('windsurf');
        }, 30_000);

        // POSIX-only: Windows needs privileges for symlinks and has no 0600 mode bits.
        it.skipIf(process.platform === 'win32')('writes through a symlinked config instead of replacing the link', async () => {
            const real = path.join(home, 'dotfiles', 'mcp.json');
            fs.mkdirSync(path.dirname(real), { recursive: true });
            fs.writeFileSync(real, '{"theme": "mine"}\n');
            const link = path.join(home, '.cursor', 'mcp.json');
            fs.mkdirSync(path.dirname(link), { recursive: true });
            fs.symlinkSync(real, link);
            await run(h, ['register-mcp', '--agent', 'cursor', '--scope', 'global', ...MCP]);
            expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
            expect(fs.readFileSync(real, 'utf8')).toContain('pixelz-platform');
        }, 30_000);

        it.skipIf(process.platform === 'win32')("keeps a private config's permissions", async () => {
            const file = path.join(home, '.cursor', 'mcp.json');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '{"mcpServers": {"other": {"command": "x", "env": {"TOKEN": "s3cret"}}}}\n');
            fs.chmodSync(file, 0o600);
            await run(h, ['register-mcp', '--agent', 'cursor', '--scope', 'global', ...MCP]);
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }, 30_000);

        it('remove-skills says when the folder is shared with other agents', async () => {
            await run(h, ['install-skills', '--agent', 'universal', '--scope', 'global', '--src', SKILLS_SRC, '--cli-root', '/x', '--runtime', 'node']);
            const r = await run(h, ['remove-skills', '--agent', 'universal', '--scope', 'global', '--src', SKILLS_SRC]);
            expect(r.stdout).toContain('is shared with OpenAI Codex');
        }, 30_000);

        it('rejects an unknown agent', async () => {
            const r = await run(h, ['skills-dir', '--agent', 'nope', '--scope', 'global']);
            expect(r.code).toBe(1);
            expect(r.stderr).toContain("unknown agent 'nope'");
        }, 30_000);
    });
}
