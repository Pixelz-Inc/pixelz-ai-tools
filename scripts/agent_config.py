#!/usr/bin/env python3
"""Agent registration helper used by scripts/install.* and scripts/uninstall.*.

The installers own the menus and dependency installs; everything that touches an AI agent's
own config lives here, driven by scripts/agents.json, so it can be tested. Node twin:
scripts/agent-config.mjs — the two must behave identically (tests/node/installer asserts it).
Standard library only: this runs before any `pip install`.
"""
import json
import math
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
# Paths can hold characters the console code page lacks (e.g. a Vietnamese user name); printing
# them must not crash the helper after it has already written the config.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')


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


# ---------- Reading and writing the user's config files ----------
#
# These are the user's files, not ours, so every edit goes through one cautious path: decode
# strictly, refuse anything that would not survive a round-trip (the caller then prints the
# entries for a manual edit), keep the line endings, keep the ORIGINAL as a backup, and replace
# the file atomically.

MAX_SAFE_INTEGER = 2 ** 53 - 1


def read_config(file):
    """(text LF-normalized, eol) for an existing file, ('', '\\n') for a missing one, or None if undecodable."""
    if not os.path.exists(file):
        return '', '\n'
    with open(file, 'rb') as f:
        raw = f.read()
    try:
        # Strict: a cp1252 or UTF-16 file must be left alone, not rewritten or crashed on.
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return None
    return text.replace('\r\n', '\n'), ('\r\n' if '\r\n' in text else '\n')


def _round_trips(v):
    """False for values the Node twin cannot carry back out unchanged: unsafe integers, Infinity/NaN."""
    if isinstance(v, bool):
        return True
    if isinstance(v, int):
        return abs(v) <= MAX_SAFE_INTEGER
    if isinstance(v, float):
        return math.isfinite(v)
    if isinstance(v, list):
        return all(_round_trips(x) for x in v)
    if isinstance(v, dict):
        return all(_round_trips(x) for x in v.values())
    return True


def _reject_constant(name):
    raise ValueError(f'non-standard JSON constant {name}')


def read_json(file, key):
    """(data, eol) for a JSON object we can safely rewrite, or None."""
    cfg = read_config(file)
    if cfg is None:
        return None
    text, eol = cfg
    if not text.strip():
        return {}, eol
    try:
        data = json.loads(text, parse_constant=_reject_constant)
    except ValueError:
        return None
    if not isinstance(data, dict) or not _round_trips(data):
        return None
    if key in data and not isinstance(data[key], dict):
        return None
    return data, eol


def write_text(file, text, eol):
    os.makedirs(os.path.dirname(file), exist_ok=True)
    # Replace the link's TARGET: replacing the link itself would turn a dotfile-managed
    # symlink into a plain file.
    real = os.path.realpath(file) if os.path.exists(file) else file
    # Only the first write makes a backup, so reinstalling never overwrites the user's original.
    backup = f'{file}.pixelz-backup'
    if os.path.exists(real) and not os.path.exists(backup):
        shutil.copy2(real, backup)  # copy2 keeps the mode: these files may hold other servers' tokens
    tmp = f'{real}.pixelz-tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(text.replace('\n', eol))
    # The temp file gets default permissions; keep the config's own (it may be 0600 with tokens in it).
    if os.path.exists(real):
        shutil.copymode(real, tmp)
    os.replace(tmp, real)


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


def left_untouched(file, fmt, entries):
    print(f'WARNING: {file} could not be updated safely (not plain UTF-8 JSON/TOML, or it already holds Pixelz entries in a form this installer does not edit), so it was left untouched. Add these entries by hand:')
    print(manual_snippet(fmt, entries))


def remove_by_hand(file):
    print(f'WARNING: {file} could not be edited safely, so it was left untouched. Remove the pixelz-platform and pixelz-automation entries by hand.')


def merge_json(file, fmt, entries):
    key = key_for(fmt)
    cfg = read_json(file, key)
    if cfg is None:
        return left_untouched(file, fmt, entries)
    data, eol = cfg
    data[key] = {**data.get(key, {}), **entries}
    write_text(file, dump_json(data), eol)
    print(f'MCP servers written to: {file}')


def unmerge_json(file, fmt):
    if not os.path.exists(file):
        return
    key = key_for(fmt)
    cfg = read_json(file, key)
    if cfg is None:
        with open(file, 'rb') as f:
            if b'pixelz-' in f.read():
                remove_by_hand(file)
        return
    data, eol = cfg
    servers = data.get(key)
    if not servers or not any(s in servers for s in SERVERS):
        return
    for s in SERVERS:
        servers.pop(s, None)
    if not servers:
        del data[key]
    if not data:
        os.remove(file)
        print(f'Removed {file} (it held only Pixelz entries).')
    else:
        write_text(file, dump_json(data), eol)
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


def _is_our_table(name):
    return any(name == f'mcp_servers.{s}' or name.startswith(f'mcp_servers.{s}.') for s in SERVERS)


# A pixelz-* server written any other way (inline table, dotted key) - we do not edit those.
OTHER_FORM = re.compile(r'''^\s*(?:mcp_servers\s*\.\s*)?(?:(["'])pixelz-(?:platform|automation)\1|pixelz-(?:platform|automation))\s*[.=]''', re.M)


def strip_toml_tables(text):
    """Drop our [mcp_servers.pixelz-*] tables and all their sub-tables; keep everything else verbatim."""
    out = []
    skipping = False
    pending = []  # comment/blank lines inside one of our tables, which may belong to the next table
    for line in text.split('\n'):
        header = re.match(r'^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$', line)
        if header:
            ours = _is_our_table(re.sub(r'["\'\s]', '', header.group(1)))
            # Comments directly above the next (not ours) table are its own: keep them.
            if skipping and not ours:
                out.extend(pending)
            pending = []
            skipping = ours
        elif skipping:
            if re.match(r'^\s*(#.*)?$', line):
                pending.append(line)
            else:
                pending = []
            continue
        if not skipping:
            out.append(line)
    if skipping:
        out.extend(pending)
    return re.sub(r'\n+$', '', '\n'.join(out))


def read_text(file):
    with open(file, encoding='utf-8-sig', newline='') as f:
        return f.read()


def merge_toml(file, entries):
    cfg = read_config(file)
    kept = strip_toml_tables(cfg[0]) if cfg else None
    if cfg is None or OTHER_FORM.search(kept):
        return left_untouched(file, 'codex-toml', entries)
    write_text(file, (kept + '\n\n' if kept else '') + re.sub(r'\n+$', '\n', toml_block(entries)), cfg[1])
    print(f'MCP servers written to: {file}')


def unmerge_toml(file):
    if not os.path.exists(file):
        return
    cfg = read_config(file)
    if cfg is None:
        return remove_by_hand(file)
    text, eol = cfg
    kept = strip_toml_tables(text)
    if OTHER_FORM.search(kept):
        print(f'WARNING: {file} also defines pixelz-platform/pixelz-automation in a form this uninstaller does not edit. Remove those entries by hand.')
    if kept == re.sub(r'\n+$', '', text):
        return
    if not kept.strip():
        os.remove(file)
        print(f'Removed {file} (it held only Pixelz entries).')
    else:
        write_text(file, kept + '\n', eol)
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


# The Windows claude shim is a .cmd, which only cmd.exe can start. cmd.exe treats & | < > ^ as
# operators outside double quotes and expands %VAR% even inside them, so every argument is
# quoted and a % makes the installer fall back to printing the commands.
def cmd_unsafe(args):
    return PLATFORM == 'win32' and any('%' in a for a in args)


def run_claude(args, quiet):
    out = subprocess.DEVNULL if quiet else None
    if PLATFORM == 'win32':
        line = ' '.join('"' + a.replace('"', '\\"') + '"' for a in [CLAUDE, *args])
        return subprocess.run(line, shell=True, stdout=out, stderr=out).returncode
    return subprocess.run([CLAUDE, *args], stdout=out, stderr=out).returncode


def print_claude_commands(reason, lines):
    print(f'WARNING: {reason}. Run these by hand:')
    for line in lines:
        print(f'  {line}')


def register_mcp(opts):
    agent = agent_of(opts)
    for k in ('cmd', 'platform', 'automation'):
        if not opts.get(k):
            fail(f'--{k} is required')
    spec = mcp_target(agent, opts)
    scripts = {'pixelz-platform': opts['platform'], 'pixelz-automation': opts['automation']}
    dotenv = opts.get('dotenv')

    if spec.get('cli') == 'claude':
        env_flag = f' -e PIXELZ_DOTENV_PATH="{slash(dotenv)}"' if dotenv else ''
        manual = [f"claude mcp add --scope user{env_flag} --transport stdio {name} -- {opts['cmd']} \"{slash(script)}\""
                  for name, script in scripts.items()]
        if not on_path(CLAUDE):
            return print_claude_commands('the `claude` CLI was not found on PATH', manual)
        if cmd_unsafe([opts['cmd'], opts['platform'], opts['automation'], dotenv or '']):
            return print_claude_commands('a path contains %, which cmd.exe would expand', manual)
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
                print_claude_commands('the `claude` CLI was not found on PATH',
                                      [f'claude mcp remove --scope user {n}' for n in SERVERS])
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
            # e.g. .agents/skills is read by Codex, the Universal target and Antigravity (local).
            sharers = [a['label'] for agent_id, a in AGENTS.items()
                       if agent_id != opts['agent'] and (a.get('skills') or {}).get(opts['scope'])
                       and expand(a['skills'][opts['scope']], {**opts, 'agent': agent_id}) == d]
            if sharers:
                print(f"NOTE: {d} is shared with {', '.join(sharers)}; their Pixelz skills were removed too. Reinstall for them if you still use them.")
    if opts['scope'] == 'global':
        for f in (expand(s, opts) for s in agent.get('legacy_files') or []):
            if f and os.path.exists(f):
                os.remove(f)
                print(f'Removed {f}')


def in_use(opts):
    """Print the agents (other than --exclude) whose Pixelz install in --target still needs the
    project's .pixelz/ folder: Pixelz skills in their local skills dir, or an MCP config that points
    at <target>/.pixelz/. Uninstall deletes the folder only when this prints nothing."""
    if not opts.get('target'):
        fail('--target is required')
    names = skill_names(opts.get('src'))
    # Windows paths are case-insensitive, and the user may type the target differently than at install.
    def fold(s):
        return s.lower() if PLATFORM == 'win32' else s
    marker = fold(slash(os.path.abspath(opts['target'])).rstrip('/') + '/.pixelz/')
    for agent_id, a in AGENTS.items():
        if agent_id == opts.get('exclude'):
            continue
        o = {**opts, 'agent': agent_id, 'scope': 'local'}
        d = expand((a.get('skills') or {}).get('local'), o)
        used = bool(d) and any(os.path.exists(os.path.join(d, n)) for n in names)
        for spec in ((a.get('mcp') or {}).get('local'), (a.get('mcp') or {}).get('global')):
            if used or not spec or not spec.get('file'):
                continue
            file = expand(spec['file'], o)
            if file and os.path.exists(file):
                with open(file, 'rb') as f:
                    used = marker in fold(f.read().decode('utf-8', 'replace'))
        if used:
            print(agent_id)


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
        'register-mcp': register_mcp, 'unregister-mcp': unregister_mcp, 'in-use': in_use,
    }
    if action not in actions:
        fail(f"unknown action '{action}' (expected: {', '.join(actions)})")
    actions[action](opts)


if __name__ == '__main__':
    main()
