#!/usr/bin/env python3
"""Agent registration helper used by scripts/install.* and scripts/uninstall.*.

The installers own the menus and dependency installs; everything that touches an AI agent's
own config lives here, driven by scripts/agents.json, so it can be tested. Node twin:
scripts/agent-config.mjs — the two must behave identically (tests/node/installer asserts it).
Standard library only: this runs before any `pip install`.
"""
import json
import os
import re
import shutil
import subprocess
import sys

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'agents.json'), encoding='utf-8') as _f:
    AGENTS = json.load(_f)['agents']
SERVERS = ['pixelz-platform', 'pixelz-automation']
# Tests set these to exercise Windows paths on any OS, and to keep the real `claude` CLI
# (and the user's real Claude config) out of reach.
PLATFORM = os.environ.get('PIXELZ_INSTALL_PLATFORM') or sys.platform
CLAUDE = os.environ.get('PIXELZ_CLAUDE_BIN') or 'claude'


def fail(msg):
    sys.stderr.write(f'Error: {msg}\n')
    sys.exit(1)


def parse_args(argv):
    opts = {}
    i = 0
    while i < len(argv):
        if not argv[i].startswith('--'):
            fail(f'unexpected argument: {argv[i]}')
        key = argv[i][2:]
        if i + 1 >= len(argv):
            fail(f'--{key} needs a value')
        opts[key] = argv[i + 1]
        i += 2
    return opts


def slash(p):
    # Forward slashes everywhere we write: node and python accept them on Windows, and they
    # need no escaping in JSON, TOML or a shell command line.
    return p.replace('\\', '/')


def expand(spec, opts):
    if spec is None:
        return None
    tmpl = spec if isinstance(spec, str) else spec.get('win32' if PLATFORM == 'win32' else 'posix')
    if tmpl is None:
        return None
    home = os.path.expanduser('~')
    tokens = {
        'home': home,
        'target': opts.get('target'),
        'appdata': os.environ.get('APPDATA') or os.path.join(home, 'AppData', 'Roaming'),
        'xdg_config': os.environ.get('XDG_CONFIG_HOME') or os.path.join(home, '.config'),
        'codex_home': os.environ.get('CODEX_HOME') or os.path.join(home, '.codex'),
        'copilot_home': os.environ.get('COPILOT_HOME') or os.path.join(home, '.copilot'),
    }

    def sub(m):
        if tokens.get(m.group(1)) is None:
            fail(f'--{m.group(1)} is required for this agent and scope')
        return tokens[m.group(1)]
    return slash(re.sub(r'\{(\w+)\}', sub, tmpl))


def agent_of(opts):
    agent = AGENTS.get(opts.get('agent'))
    if not agent:
        fail(f"unknown agent '{opts.get('agent')}' (expected one of: {', '.join(AGENTS)})")
    if opts.get('scope') not in ('global', 'local'):
        fail('--scope must be global or local')
    if opts['scope'] == 'local' and not opts.get('target'):
        fail('--target is required for --scope local')
    return agent


# ---------- JSON config files ----------

def read_json(file):
    if not os.path.exists(file):
        return {}
    with open(file, encoding='utf-8-sig') as f:
        text = f.read()
    if not text.strip():
        return {}
    try:
        data = json.loads(text)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def write_text(file, text):
    os.makedirs(os.path.dirname(file), exist_ok=True)
    # Keep the user's previous version: these are their files, not ours.
    if os.path.exists(file):
        shutil.copyfile(file, f'{file}.pixelz-backup')
    with open(file, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def dump_json(data):
    # Matches JSON.stringify(data, null, 2) so both helpers write byte-identical files.
    return json.dumps(data, indent=2, ensure_ascii=False) + '\n'


def entry_for(fmt, cmd, script, dotenv):
    env = {'PIXELZ_DOTENV_PATH': slash(dotenv)} if dotenv else None
    if fmt == 'opencode':
        e = {'type': 'local', 'command': [cmd, slash(script)], 'enabled': True}
        if env:
            e['environment'] = env
        return e
    if fmt == 'copilot':
        e = {'type': 'local', 'command': cmd, 'args': [slash(script)]}
        if env:
            e['env'] = env
        e['tools'] = ['*']
        return e
    e = {'command': cmd, 'args': [slash(script)]}
    if env:
        e['env'] = env
    return e


def key_for(fmt):
    return 'mcp' if fmt == 'opencode' else 'mcpServers'


def manual_snippet(fmt, entries):
    if fmt == 'codex-toml':
        return toml_block(entries)
    return json.dumps({key_for(fmt): entries}, indent=2, ensure_ascii=False)


def merge_json(file, fmt, entries):
    data = read_json(file)
    if data is None:
        # Never clobber a file we cannot parse (JSONC comments, a hand edit in progress, ...).
        print(f'WARNING: {file} is not plain JSON, so it was left untouched. Add these entries by hand:')
        print(manual_snippet(fmt, entries))
        return
    key = key_for(fmt)
    current = data.get(key) if isinstance(data.get(key), dict) else {}
    data[key] = {**current, **entries}
    write_text(file, dump_json(data))
    print(f'MCP servers written to: {file}')


def unmerge_json(file, fmt):
    data = read_json(file)
    if not os.path.exists(file) or data is None:
        return
    key = key_for(fmt)
    if not isinstance(data.get(key), dict) or not any(s in data[key] for s in SERVERS):
        return
    for s in SERVERS:
        data[key].pop(s, None)
    if not data[key]:
        del data[key]
    if not data:
        os.remove(file)
        print(f'Removed {file} (it held only Pixelz entries).')
    else:
        write_text(file, dump_json(data))
        print(f'Pixelz MCP servers removed from: {file}')


# ---------- Codex config.toml ----------

def toml_str(s):
    return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'


def toml_block(entries):
    out = ''
    for name, e in entries.items():
        out += f"[mcp_servers.{name}]\ncommand = {toml_str(e['command'])}\nargs = [{', '.join(toml_str(a) for a in e['args'])}]\n"
        if e.get('env'):
            out += f'\n[mcp_servers.{name}.env]\n'
            for k, v in e['env'].items():
                out += f'{k} = {toml_str(v)}\n'
        out += '\n'
    return out


def strip_toml_tables(text):
    """Drop our [mcp_servers.pixelz-*] tables (and their sub-tables), keeping everything else verbatim."""
    ours = {t for s in SERVERS for t in (f'mcp_servers.{s}', f'mcp_servers.{s}.env')}
    out = []
    skipping = False
    for line in re.split(r'\r?\n', text):
        header = re.match(r'^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$', line)
        if header:
            skipping = re.sub(r'["\'\s]', '', header.group(1)) in ours
        if not skipping:
            out.append(line)
    return re.sub(r'\n+$', '', '\n'.join(out))


def read_text(file):
    with open(file, encoding='utf-8-sig', newline='') as f:
        return f.read()


def merge_toml(file, entries):
    existing = read_text(file) if os.path.exists(file) else ''
    kept = strip_toml_tables(existing)
    write_text(file, (kept + '\n\n' if kept else '') + re.sub(r'\n+$', '\n', toml_block(entries)))
    print(f'MCP servers written to: {file}')


def unmerge_toml(file):
    if not os.path.exists(file):
        return
    text = read_text(file)
    kept = strip_toml_tables(text)
    if kept == re.sub(r'\n+$', '', text):
        return
    if not kept.strip():
        os.remove(file)
        print(f'Removed {file} (it held only Pixelz entries).')
    else:
        write_text(file, kept + '\n')
        print(f'Pixelz MCP servers removed from: {file}')


# ---------- MCP registration ----------

def mcp_target(agent, opts):
    spec = (agent.get('mcp') or {}).get(opts['scope'])
    if spec:
        return spec
    # An agent with no project-level MCP config (e.g. Windsurf) falls back to its user config.
    if opts['scope'] == 'local' and (agent.get('mcp') or {}).get('global'):
        print(f"NOTE: {agent['label']} has no project-level MCP config; registering for your user account instead.")
        return agent['mcp']['global']
    fail(f"{agent['label']} does not support the MCP track")


def on_path(cmd):
    return shutil.which(cmd) is not None


def run_claude(args, quiet):
    # The Windows claude shim is a .cmd, which subprocess cannot launch without a shell.
    out = subprocess.DEVNULL if quiet else None
    if PLATFORM == 'win32':
        return subprocess.run(subprocess.list2cmdline([CLAUDE, *args]), shell=True, stdout=out, stderr=out).returncode
    return subprocess.run([CLAUDE, *args], stdout=out, stderr=out).returncode


def register_mcp(opts):
    agent = agent_of(opts)
    for k in ('cmd', 'platform', 'automation'):
        if not opts.get(k):
            fail(f'--{k} is required')
    spec = mcp_target(agent, opts)
    scripts = {'pixelz-platform': opts['platform'], 'pixelz-automation': opts['automation']}
    dotenv = opts.get('dotenv')

    if spec.get('cli') == 'claude':
        if not on_path(CLAUDE):
            print('WARNING: the `claude` CLI was not found on PATH. Register the servers by hand:')
            for name, script in scripts.items():
                env = f' -e PIXELZ_DOTENV_PATH="{slash(dotenv)}"' if dotenv else ''
                print(f"  claude mcp add --scope user{env} --transport stdio {name} -- {opts['cmd']} \"{slash(script)}\"")
            return
        for name, script in scripts.items():
            run_claude(['mcp', 'remove', '--scope', 'user', name], quiet=True)
            # -e takes several values and would swallow the name; --transport after it ends the list.
            env = ['-e', f'PIXELZ_DOTENV_PATH={slash(dotenv)}'] if dotenv else []
            if run_claude(['mcp', 'add', '--scope', 'user', *env, '--transport', 'stdio', name, '--', opts['cmd'], slash(script)], quiet=False) != 0:
                fail(f'claude mcp add {name} failed')
        print('MCP servers registered with Claude Code (scope: user).')
        return

    file = expand(spec['file'], opts)
    entries = {n: entry_for(spec['format'], opts['cmd'], s, dotenv) for n, s in scripts.items()}
    if spec['format'] == 'codex-toml':
        merge_toml(file, entries)
    else:
        merge_json(file, spec['format'], entries)
    if spec.get('note'):
        print(f"NOTE: {spec['note']}")


def unregister_mcp(opts):
    agent = agent_of(opts)
    mcp = agent.get('mcp') or {}
    targets = []
    spec = mcp.get(opts['scope']) or (mcp.get('global') if opts['scope'] == 'local' else None)
    if spec:
        targets.append(spec)
    if opts['scope'] == 'global':
        targets.extend(agent.get('legacy_mcp') or [])
    for t in targets:
        if t.get('cli') == 'claude':
            if not on_path(CLAUDE):
                continue
            for name in SERVERS:
                run_claude(['mcp', 'remove', '--scope', 'user', name], quiet=True)
            print('Pixelz MCP servers removed from Claude Code (scope: user).')
        else:
            file = expand(t['file'], opts)
            if file is None:
                continue
            if t['format'] == 'codex-toml':
                unmerge_toml(file)
            else:
                unmerge_json(file, t['format'])


# ---------- Skills ----------

def skills_dir(agent, opts):
    d = expand((agent.get('skills') or {}).get(opts['scope']), opts)
    if not d:
        fail(f"{agent['label']} does not support the Skills track")
    return d


def skill_names(src):
    if not src or not os.path.isdir(src):
        fail('--src must point at the repository skills/ directory')
    return sorted(n for n in os.listdir(src) if os.path.isdir(os.path.join(src, n)))


def install_skills(opts):
    agent = agent_of(opts)
    for k in ('src', 'cli-root', 'runtime'):
        if not opts.get(k):
            fail(f'--{k} is required')
    dest = skills_dir(agent, opts)
    runtime = opts['runtime']
    lang, ext = ('node', 'js') if runtime == 'node' else ('python', 'py')
    cli_root = slash(opts['cli-root'])
    names = skill_names(opts['src'])
    for name in names:
        to = os.path.join(dest, name)
        shutil.rmtree(to, ignore_errors=True)
        shutil.copytree(os.path.join(opts['src'], name), to)
        skill_md = os.path.join(to, 'SKILL.md')
        if os.path.exists(skill_md):
            # Skills run in the agent's working directory (the user's project), so the relative
            # `cli-tools/...` invocation in the source SKILL.md must become an absolute, quoted path.
            text = read_text(skill_md)
            text = text.replace('node cli-tools/automation/node/cli.js', f'{runtime} "{cli_root}/automation/{lang}/cli.{ext}"')
            text = text.replace('node cli-tools/platform/node/cli.js', f'{runtime} "{cli_root}/platform/{lang}/cli.{ext}"')
            with open(skill_md, 'w', encoding='utf-8', newline='') as f:
                f.write(text)
    print(f'{len(names)} skills deployed to: {dest}')
    print(f'Skills invoke the CLI at: {cli_root}')


def remove_skills(opts):
    agent = agent_of(opts)
    names = skill_names(opts.get('src'))
    dirs = []
    if (agent.get('skills') or {}).get(opts['scope']):
        dirs.append(skills_dir(agent, opts))
    if opts['scope'] == 'global':
        dirs.extend(d for d in (expand(s, opts) for s in agent.get('legacy_skills') or []) if d)
    for d in dirs:
        # Only Pixelz's own skill folders: the directory also holds the user's other skills.
        removed = 0
        for name in names:
            p = os.path.join(d, name)
            if os.path.exists(p):
                shutil.rmtree(p, ignore_errors=True)
                removed += 1
        if removed:
            print(f'Removed {removed} Pixelz skills from: {d}')
    if opts['scope'] == 'global':
        for f in (expand(s, opts) for s in agent.get('legacy_files') or []):
            if f and os.path.exists(f):
                os.remove(f)
                print(f'Removed {f}')


def list_agents(opts):
    for agent_id, a in AGENTS.items():
        if opts.get('track') == 'mcp' and not a.get('mcp'):
            continue
        if opts.get('track') == 'skills' and not a.get('skills'):
            continue
        print(f"{agent_id}\t{a['label']}")


def main():
    if len(sys.argv) < 2:
        fail('missing action')
    action, opts = sys.argv[1], parse_args(sys.argv[2:])
    actions = {
        'list': list_agents, 'skills-dir': lambda o: print(skills_dir(agent_of(o), o)),
        'install-skills': install_skills, 'remove-skills': remove_skills,
        'register-mcp': register_mcp, 'unregister-mcp': unregister_mcp,
    }
    if action not in actions:
        fail(f"unknown action '{action}' (expected: {', '.join(actions)})")
    actions[action](opts)


if __name__ == '__main__':
    main()
