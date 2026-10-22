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

// ---------- JSON config files ----------

function readJson(file) {
    if (!fs.existsSync(file)) return {};
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    if (!text.trim()) return {};
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

function writeText(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Keep the user's previous version: these are their files, not ours.
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.pixelz-backup`);
    fs.writeFileSync(file, text, 'utf8');
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

function mergeJson(file, format, entries) {
    const data = readJson(file);
    if (data === null) {
        // Never clobber a file we cannot parse (JSONC comments, a hand edit in progress, ...).
        console.log(`WARNING: ${file} is not plain JSON, so it was left untouched. Add these entries by hand:`);
        console.log(manualSnippet(format, entries));
        return;
    }
    const key = keyFor(format);
    data[key] = { ...(data[key] && typeof data[key] === 'object' ? data[key] : {}), ...entries };
    writeText(file, JSON.stringify(data, null, 2) + '\n');
    console.log(`MCP servers written to: ${file}`);
}

function unmergeJson(file, format) {
    const data = readJson(file);
    if (!fs.existsSync(file) || data === null) return;
    const key = keyFor(format);
    if (!data[key] || !SERVERS.some(s => s in data[key])) return;
    for (const s of SERVERS) delete data[key][s];
    if (Object.keys(data[key]).length === 0) delete data[key];
    if (Object.keys(data).length === 0) {
        fs.rmSync(file);
        console.log(`Removed ${file} (it held only Pixelz entries).`);
    } else {
        writeText(file, JSON.stringify(data, null, 2) + '\n');
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

/** Drop our [mcp_servers.pixelz-*] tables (and their sub-tables), keeping everything else verbatim. */
function stripTomlTables(text) {
    const ours = new Set(SERVERS.flatMap(s => [`mcp_servers.${s}`, `mcp_servers.${s}.env`]));
    const out = [];
    let skipping = false;
    for (const line of text.split(/\r?\n/)) {
        const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/);
        if (header) skipping = ours.has(header[1].replace(/["'\s]/g, ''));
        if (!skipping) out.push(line);
    }
    return out.join('\n').replace(/\n+$/, '');
}

function mergeToml(file, entries) {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '') : '';
    const kept = stripTomlTables(existing);
    writeText(file, (kept ? kept + '\n\n' : '') + tomlBlock(entries).replace(/\n+$/, '\n'));
    console.log(`MCP servers written to: ${file}`);
}

function unmergeToml(file) {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const kept = stripTomlTables(text);
    if (kept === text.replace(/\n+$/, '')) return;
    if (!kept.trim()) {
        fs.rmSync(file);
        console.log(`Removed ${file} (it held only Pixelz entries).`);
    } else {
        writeText(file, kept + '\n');
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

function runClaude(args, quiet) {
    const stdio = quiet ? 'ignore' : 'inherit';
    // The Windows claude shim is a .cmd, which cannot be spawned without a shell; with a shell,
    // arguments are not quoted for us, so quote any that contain spaces.
    if (PLATFORM === 'win32') {
        const line = [CLAUDE, ...args].map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
        return spawnSync(line, { stdio, shell: true }).status;
    }
    return spawnSync(CLAUDE, args, { stdio }).status;
}

function registerMcp(opts) {
    const agent = agentOf(opts);
    for (const k of ['cmd', 'platform', 'automation']) if (!opts[k]) fail(`--${k} is required`);
    const spec = mcpTarget(agent, opts);
    const scripts = { 'pixelz-platform': opts.platform, 'pixelz-automation': opts.automation };

    if (spec.cli === 'claude') {
        if (!onPath(CLAUDE)) {
            console.log('WARNING: the `claude` CLI was not found on PATH. Register the servers by hand:');
            for (const [name, script] of Object.entries(scripts)) {
                const env = opts.dotenv ? ` -e PIXELZ_DOTENV_PATH="${slash(opts.dotenv)}"` : '';
                console.log(`  claude mcp add --scope user${env} --transport stdio ${name} -- ${opts.cmd} "${slash(script)}"`);
            }
            return;
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
            if (!onPath(CLAUDE)) continue;
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
        if (removed) console.log(`Removed ${removed} Pixelz skills from: ${dir}`);
    }
    if (opts.scope === 'global') {
        for (const f of (agent.legacy_files ?? []).map(s => expand(s, opts)).filter(Boolean)) {
            if (fs.existsSync(f)) { fs.rmSync(f); console.log(`Removed ${f}`); }
        }
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
    'register-mcp': registerMcp, 'unregister-mcp': unregisterMcp,
};
if (!actions[action]) fail(`unknown action '${action}' (expected: ${Object.keys(actions).join(', ')})`);
actions[action](opts);
