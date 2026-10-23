#!/usr/bin/env node
// Agent registration helper used by scripts/install.* and scripts/uninstall.*.
//
// The installers own the menus and dependency installs; everything that touches an AI agent's
// own config lives here, driven by scripts/agents.json, so it can be tested. Python twin:
// scripts/agent_config.py — the two must behave identically (tests/node/installer asserts it).
// Node built-ins only: this runs before any `pnpm install`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AGENTS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'agents.json'), 'utf8')).agents;
const SERVERS = ['pixelz-platform', 'pixelz-automation'];
// Tests set these to exercise Windows paths on any OS, and to keep the real `claude` CLI
// (and the user's real Claude config) out of reach.
const PLATFORM = process.env.PIXELZ_INSTALL_PLATFORM || process.platform;
const CLAUDE = process.env.PIXELZ_CLAUDE_BIN || 'claude';

function fail(msg) {
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
}

function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) fail(`unexpected argument: ${argv[i]}`);
        const key = argv[i].slice(2);
        if (i + 1 >= argv.length) fail(`--${key} needs a value`);
        opts[key] = argv[++i];
    }
    return opts;
}

// Forward slashes everywhere we write: node and python accept them on Windows, and they need
// no escaping in JSON, TOML or a shell command line.
const slash = p => p.replace(/\\/g, '/');

function expand(spec, opts) {
    if (spec == null) return null;
    const tmpl = typeof spec === 'string' ? spec : (spec[PLATFORM === 'win32' ? 'win32' : 'posix'] ?? null);
    if (tmpl == null) return null;
    const home = os.homedir();
    const tokens = {
        home,
        target: opts.target,
        appdata: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        xdg_config: process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
        codex_home: process.env.CODEX_HOME || path.join(home, '.codex'),
        copilot_home: process.env.COPILOT_HOME || path.join(home, '.copilot'),
    };
    return slash(tmpl.replace(/\{(\w+)\}/g, (_, t) => {
        if (tokens[t] == null) fail(`--${t} is required for this agent and scope`);
        return tokens[t];
    }));
}

function agentOf(opts) {
    const agent = AGENTS[opts.agent];
    if (!agent) fail(`unknown agent '${opts.agent}' (expected one of: ${Object.keys(AGENTS).join(', ')})`);
    if (opts.scope !== 'global' && opts.scope !== 'local') fail('--scope must be global or local');
    if (opts.scope === 'local' && !opts.target) fail('--target is required for --scope local');
    return agent;
}

// ---------- Reading and writing the user's config files ----------
//
// These are the user's files, not ours, so every edit goes through one cautious path: decode
// strictly, refuse anything that would not survive a round-trip (the caller then prints the
// entries for a manual edit), keep the line endings, keep the ORIGINAL as a backup, and replace
// the file atomically.

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** {text (LF-normalized), eol} for an existing file, {text: '', eol: '\n'} for a missing one, or null if undecodable. */
function readConfig(file) {
    if (!fs.existsSync(file)) return { text: '', eol: '\n' };
    let buf = fs.readFileSync(file);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
    let text;
    // fatal: a cp1252 or UTF-16 file must be left alone, not rewritten with U+FFFD in it.
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
    return { text: text.replace(/\r\n/g, '\n'), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** False for values JSON.parse cannot carry back out unchanged: unsafe integers, Infinity. */
function roundTrips(v) {
    if (typeof v === 'number') return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v));
    if (Array.isArray(v)) return v.every(roundTrips);
    if (isPlainObject(v)) return Object.values(v).every(roundTrips);
    return true;
}

/** {data, eol} for a JSON object we can safely rewrite, or null. */
function readJson(file, key) {
    const cfg = readConfig(file);
    if (!cfg) return null;
    if (!cfg.text.trim()) return { data: {}, eol: cfg.eol };
    let data;
    try { data = JSON.parse(cfg.text); } catch { return null; }
    if (!isPlainObject(data) || !roundTrips(data)) return null;
    if (data[key] !== undefined && !isPlainObject(data[key])) return null;
    return { data, eol: cfg.eol };
}

function writeText(file, text, eol) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Only the first write makes a backup, so reinstalling never overwrites the user's original.
    const backup = `${file}.pixelz-backup`;
    if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
    const tmp = `${file}.pixelz-tmp`;
    fs.writeFileSync(tmp, text.replace(/\n/g, eol), 'utf8');
    fs.renameSync(tmp, file);
}

function entryFor(format, cmd, script, dotenv) {
    const env = dotenv ? { PIXELZ_DOTENV_PATH: slash(dotenv) } : undefined;
    switch (format) {
        case 'opencode':
            return { type: 'local', command: [cmd, slash(script)], enabled: true, ...(env && { environment: env }) };
        case 'copilot':
            return { type: 'local', command: cmd, args: [slash(script)], ...(env && { env }), tools: ['*'] };
        default:
            return { command: cmd, args: [slash(script)], ...(env && { env }) };
    }
}

const keyFor = format => (format === 'opencode' ? 'mcp' : 'mcpServers');

function manualSnippet(format, entries) {
    if (format === 'codex-toml') return tomlBlock(entries);
    return JSON.stringify({ [keyFor(format)]: entries }, null, 2);
}

function leftUntouched(file, format, entries) {
    console.log(`WARNING: ${file} could not be updated safely (not plain UTF-8 JSON/TOML, or it already holds Pixelz entries in a form this installer does not edit), so it was left untouched. Add these entries by hand:`);
    console.log(manualSnippet(format, entries));
}

function removeByHand(file) {
    console.log(`WARNING: ${file} could not be edited safely, so it was left untouched. Remove the pixelz-platform and pixelz-automation entries by hand.`);
}

function mergeJson(file, format, entries) {
    const key = keyFor(format);
    const cfg = readJson(file, key);
    if (!cfg) return leftUntouched(file, format, entries);
    cfg.data[key] = { ...(cfg.data[key] ?? {}), ...entries };
    writeText(file, JSON.stringify(cfg.data, null, 2) + '\n', cfg.eol);
    console.log(`MCP servers written to: ${file}`);
}

function unmergeJson(file, format) {
    if (!fs.existsSync(file)) return;
    const key = keyFor(format);
    const cfg = readJson(file, key);
    if (!cfg) {
        if (fs.readFileSync(file).includes('pixelz-')) removeByHand(file);
        return;
    }
    const servers = cfg.data[key];
    if (!servers || !SERVERS.some(s => s in servers)) return;
    for (const s of SERVERS) delete servers[s];
    if (Object.keys(servers).length === 0) delete cfg.data[key];
    if (Object.keys(cfg.data).length === 0) {
        fs.rmSync(file);
        console.log(`Removed ${file} (it held only Pixelz entries).`);
    } else {
        writeText(file, JSON.stringify(cfg.data, null, 2) + '\n', cfg.eol);
        console.log(`Pixelz MCP servers removed from: ${file}`);
    }
}

// ---------- Codex config.toml ----------

const tomlStr = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function tomlBlock(entries) {
    let out = '';
    for (const [name, e] of Object.entries(entries)) {
        out += `[mcp_servers.${name}]\ncommand = ${tomlStr(e.command)}\nargs = [${e.args.map(tomlStr).join(', ')}]\n`;
        if (e.env) {
            out += `\n[mcp_servers.${name}.env]\n`;
            for (const [k, v] of Object.entries(e.env)) out += `${k} = ${tomlStr(v)}\n`;
        }
        out += '\n';
    }
    return out;
}

const isOurTable = name => SERVERS.some(s => name === `mcp_servers.${s}` || name.startsWith(`mcp_servers.${s}.`));
// A pixelz-* server written any other way (inline table, dotted key) - we do not edit those.
const OTHER_FORM = /^\s*(?:mcp_servers\s*\.\s*)?["']?pixelz-(?:platform|automation)["']?\s*[.=]/m;

/** Drop our [mcp_servers.pixelz-*] tables and all their sub-tables; keep everything else verbatim. */
function stripTomlTables(text) {
    const out = [];
    let skipping = false;
    let pending = []; // comment/blank lines inside one of our tables, which may belong to the next table
    for (const line of text.split('\n')) {
        const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/);
        if (header) {
            const ours = isOurTable(header[1].replace(/["'\s]/g, ''));
            // Comments directly above the next (not ours) table are its own: keep them.
            if (skipping && !ours) out.push(...pending);
            pending = [];
            skipping = ours;
        } else if (skipping) {
            if (/^\s*(#.*)?$/.test(line)) pending.push(line); else pending = [];
            continue;
        }
        if (!skipping) out.push(line);
    }
    if (skipping) out.push(...pending);
    return out.join('\n').replace(/\n+$/, '');
}

function mergeToml(file, entries) {
    const cfg = readConfig(file);
    const kept = cfg && stripTomlTables(cfg.text);
    if (!cfg || OTHER_FORM.test(kept)) return leftUntouched(file, 'codex-toml', entries);
    writeText(file, (kept ? kept + '\n\n' : '') + tomlBlock(entries).replace(/\n+$/, '\n'), cfg.eol);
    console.log(`MCP servers written to: ${file}`);
}

function unmergeToml(file) {
    if (!fs.existsSync(file)) return;
    const cfg = readConfig(file);
    if (!cfg) return removeByHand(file);
    const kept = stripTomlTables(cfg.text);
    if (OTHER_FORM.test(kept)) removeByHand(file);
    if (kept === cfg.text.replace(/\n+$/, '')) return;
    if (!kept.trim()) {
        fs.rmSync(file);
        console.log(`Removed ${file} (it held only Pixelz entries).`);
    } else {
        writeText(file, kept + '\n', cfg.eol);
        console.log(`Pixelz MCP servers removed from: ${file}`);
    }
}

// ---------- MCP registration ----------

function mcpTarget(agent, opts) {
    const spec = agent.mcp?.[opts.scope];
    if (spec) return spec;
    // An agent with no project-level MCP config (e.g. Windsurf) falls back to its user config.
    if (opts.scope === 'local' && agent.mcp?.global) {
        console.log(`NOTE: ${agent.label} has no project-level MCP config; registering for your user account instead.`);
        return agent.mcp.global;
    }
    fail(`${agent.label} does not support the MCP track`);
}

function onPath(cmd) {
    const probe = spawnSync(PLATFORM === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', shell: false });
    return probe.status === 0;
}

// The Windows claude shim is a .cmd, which only cmd.exe can start. cmd.exe treats & | < > ^ as
// operators outside double quotes and expands %VAR% even inside them, so every argument is
// quoted and a % makes the installer fall back to printing the commands.
const cmdUnsafe = args => PLATFORM === 'win32' && args.some(a => a.includes('%'));

function runClaude(args, quiet) {
    const stdio = quiet ? 'ignore' : 'inherit';
    if (PLATFORM === 'win32') {
        const line = [CLAUDE, ...args].map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
        return spawnSync(line, { stdio, shell: true }).status;
    }
    return spawnSync(CLAUDE, args, { stdio }).status;
}

function printClaudeCommands(reason, lines) {
    console.log(`WARNING: ${reason}. Run these by hand:`);
    for (const l of lines) console.log(`  ${l}`);
}

function registerMcp(opts) {
    const agent = agentOf(opts);
    for (const k of ['cmd', 'platform', 'automation']) if (!opts[k]) fail(`--${k} is required`);
    const spec = mcpTarget(agent, opts);
    const scripts = { 'pixelz-platform': opts.platform, 'pixelz-automation': opts.automation };

    if (spec.cli === 'claude') {
        const manual = Object.entries(scripts).map(([name, script]) => {
            const env = opts.dotenv ? ` -e PIXELZ_DOTENV_PATH="${slash(opts.dotenv)}"` : '';
            return `claude mcp add --scope user${env} --transport stdio ${name} -- ${opts.cmd} "${slash(script)}"`;
        });
        if (!onPath(CLAUDE)) return printClaudeCommands('the `claude` CLI was not found on PATH', manual);
        if (cmdUnsafe([opts.cmd, opts.platform, opts.automation, opts.dotenv ?? ''])) {
            return printClaudeCommands('a path contains %, which cmd.exe would expand', manual);
        }
        for (const [name, script] of Object.entries(scripts)) {
            runClaude(['mcp', 'remove', '--scope', 'user', name], true);
            // -e takes several values and would swallow the name; --transport after it ends the list.
            const env = opts.dotenv ? ['-e', `PIXELZ_DOTENV_PATH=${slash(opts.dotenv)}`] : [];
            if (runClaude(['mcp', 'add', '--scope', 'user', ...env, '--transport', 'stdio', name, '--', opts.cmd, slash(script)], false) !== 0) {
                fail(`claude mcp add ${name} failed`);
            }
        }
        console.log('MCP servers registered with Claude Code (scope: user).');
        return;
    }

    const file = expand(spec.file, opts);
    const entries = Object.fromEntries(Object.entries(scripts).map(([n, s]) => [n, entryFor(spec.format, opts.cmd, s, opts.dotenv)]));
    if (spec.format === 'codex-toml') mergeToml(file, entries);
    else mergeJson(file, spec.format, entries);
    if (spec.note) console.log(`NOTE: ${spec.note}`);
}

function unregisterMcp(opts) {
    const agent = agentOf(opts);
    const targets = [];
    const spec = agent.mcp?.[opts.scope] ?? (opts.scope === 'local' ? agent.mcp?.global : null);
    if (spec) targets.push(spec);
    if (opts.scope === 'global') targets.push(...(agent.legacy_mcp ?? []));
    for (const t of targets) {
        if (t.cli === 'claude') {
            if (!onPath(CLAUDE)) {
                printClaudeCommands('the `claude` CLI was not found on PATH', SERVERS.map(n => `claude mcp remove --scope user ${n}`));
                continue;
            }
            for (const name of SERVERS) {
                runClaude(['mcp', 'remove', '--scope', 'user', name], true);
            }
            console.log('Pixelz MCP servers removed from Claude Code (scope: user).');
        } else {
            const file = expand(t.file, opts);
            if (file == null) continue;
            if (t.format === 'codex-toml') unmergeToml(file); else unmergeJson(file, t.format);
        }
    }
}

// ---------- Skills ----------

function skillsDir(agent, opts) {
    const dir = expand(agent.skills?.[opts.scope], opts);
    if (!dir) fail(`${agent.label} does not support the Skills track`);
    return dir;
}

function skillNames(src) {
    if (!src || !fs.existsSync(src)) fail('--src must point at the repository skills/ directory');
    return fs.readdirSync(src, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
}

function installSkills(opts) {
    const agent = agentOf(opts);
    for (const k of ['src', 'cli-root', 'runtime']) if (!opts[k]) fail(`--${k} is required`);
    const dest = skillsDir(agent, opts);
    const lang = opts.runtime === 'node' ? 'node' : 'python';
    const ext = lang === 'node' ? 'js' : 'py';
    const cliRoot = slash(opts['cli-root']);
    // Skills run in the agent's working directory (the user's project), so the relative
    // `cli-tools/...` invocation in the source SKILL.md must become an absolute, quoted path.
    const rewrite = text => text
        .replaceAll('node cli-tools/automation/node/cli.js', `${opts.runtime} "${cliRoot}/automation/${lang}/cli.${ext}"`)
        .replaceAll('node cli-tools/platform/node/cli.js', `${opts.runtime} "${cliRoot}/platform/${lang}/cli.${ext}"`);
    const names = skillNames(opts.src);
    for (const name of names) {
        const to = path.join(dest, name);
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(path.join(opts.src, name), to, { recursive: true });
        const skillMd = path.join(to, 'SKILL.md');
        if (fs.existsSync(skillMd)) fs.writeFileSync(skillMd, rewrite(fs.readFileSync(skillMd, 'utf8')), 'utf8');
    }
    console.log(`${names.length} skills deployed to: ${dest}`);
    console.log(`Skills invoke the CLI at: ${cliRoot}`);
}

function removeSkills(opts) {
    const agent = agentOf(opts);
    const names = skillNames(opts.src);
    const dirs = [];
    if (agent.skills?.[opts.scope]) dirs.push(skillsDir(agent, opts));
    if (opts.scope === 'global') dirs.push(...(agent.legacy_skills ?? []).map(s => expand(s, opts)).filter(Boolean));
    for (const dir of dirs) {
        // Only Pixelz's own skill folders: the directory also holds the user's other skills.
        let removed = 0;
        for (const name of names) {
            const p = path.join(dir, name);
            if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed++; }
        }
        if (removed) {
            console.log(`Removed ${removed} Pixelz skills from: ${dir}`);
            // e.g. .agents/skills is read by Codex, the Universal target and Antigravity (local).
            const sharers = Object.entries(AGENTS)
                .filter(([id, a]) => id !== opts.agent && a.skills?.[opts.scope] && expand(a.skills[opts.scope], { ...opts, agent: id }) === dir)
                .map(([, a]) => a.label);
            if (sharers.length) console.log(`NOTE: ${dir} is shared with ${sharers.join(', ')}; their Pixelz skills were removed too. Reinstall for them if you still use them.`);
        }
    }
    if (opts.scope === 'global') {
        for (const f of (agent.legacy_files ?? []).map(s => expand(s, opts)).filter(Boolean)) {
            if (fs.existsSync(f)) { fs.rmSync(f); console.log(`Removed ${f}`); }
        }
    }
}

/**
 * Print the agents (other than --exclude) whose Pixelz install in --target still needs the
 * project's .pixelz/ folder: Pixelz skills in their local skills dir, or an MCP config that points
 * at <target>/.pixelz/. Uninstall deletes the folder only when this prints nothing.
 */
function inUse(opts) {
    if (!opts.target) fail('--target is required');
    const names = skillNames(opts.src);
    const marker = `${slash(opts.target).replace(/\/+$/, '')}/.pixelz/`;
    for (const [id, a] of Object.entries(AGENTS)) {
        if (id === opts.exclude) continue;
        const o = { ...opts, agent: id, scope: 'local' };
        const dir = expand(a.skills?.local, o);
        let used = !!dir && names.some(n => fs.existsSync(path.join(dir, n)));
        for (const spec of [a.mcp?.local, a.mcp?.global]) {
            if (used || !spec?.file) continue;
            const file = expand(spec.file, o);
            used = !!file && fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(marker);
        }
        if (used) console.log(id);
    }
}

function list(opts) {
    for (const [id, a] of Object.entries(AGENTS)) {
        if (opts.track === 'mcp' && !a.mcp) continue;
        if (opts.track === 'skills' && !a.skills) continue;
        console.log(`${id}\t${a.label}`);
    }
}

const [action, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
const actions = {
    list, 'skills-dir': o => console.log(skillsDir(agentOf(o), o)),
    'install-skills': installSkills, 'remove-skills': removeSkills,
    'register-mcp': registerMcp, 'unregister-mcp': unregisterMcp, 'in-use': inUse,
};
if (!actions[action]) fail(`unknown action '${action}' (expected: ${Object.keys(actions).join(', ')})`);
actions[action](opts);
