#!/bin/bash

# Where the user ran us from, before the cd below: a relative target path means what they typed.
ORIG_PWD="$PWD"

# Determine project root based on script location
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT" || exit 1

# NOTE: deliberately no `set -e` here. show_menu communicates the chosen index through its
# exit status (`return $selected`, read back as $?), and `((selected--))` returns 1 when the
# result is 0 — under `set -e` either would abort the installer mid-menu. Failure points are
# guarded individually with `|| { echo ...; exit 1; }` instead.

# The pip version CI pins. Installed first inside the venv so the 7-day release quarantine
# (--uploaded-prior-to, pip 26.0+) is enforceable whatever pip the system Python ships.
PINNED_PIP="26.2.1"

usage() {
    cat <<'EOF'
Usage: install.sh [--lang node|python] [--track mcp|skills] [--agent ID]
                  [--scope global|local] [--target PATH] [--help]

Any value given as a flag skips its prompt; anything missing is asked for interactively.
Without a terminal (CI, scripts, AI agents) every value must be given as a flag.

  --lang    node | python
  --track   mcp (Track 1, MCP servers) | skills (Track 2, Agent Skills + CLI)
  --agent   an id from scripts/agents.json: claude, codex, copilot, cursor, antigravity,
            windsurf, opencode, universal (universal: skills track only)
  --scope   global (your user account) | local (one project folder)
  --target  project folder for --scope local; implies --scope local when --scope is omitted

Example: ./scripts/install.sh --lang node --track skills --agent claude --scope global
EOF
}

die_usage() {
    echo "Error: $1" >&2
    echo "Run with --help for the list of flags." >&2
    exit 1
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

LANG_PREF=""; TRACK=""; AGENT=""; SCOPE=""; TARGET_PATH=""
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --lang|--track|--agent|--scope|--target)
            [ $# -ge 2 ] || die_usage "$1 needs a value"
            case "$1" in
                --lang) LANG_PREF="$(lower "$2")" ;;
                --track) TRACK="$(lower "$2")" ;;
                --agent) AGENT="$2" ;;
                --scope) SCOPE="$(lower "$2")" ;;
                --target) TARGET_PATH="$2" ;;
            esac
            shift 2 ;;
        *) die_usage "unknown option '$1'" ;;
    esac
done
case "$LANG_PREF" in ""|node|python) ;; *) die_usage "--lang must be node or python (got '$LANG_PREF')" ;; esac
case "$TRACK" in ""|mcp|skills) ;; *) die_usage "--track must be mcp or skills (got '$TRACK')" ;; esac
case "$SCOPE" in ""|global|local) ;; *) die_usage "--scope must be global or local (got '$SCOPE')" ;; esac
[ -z "$SCOPE" ] && [ -n "$TARGET_PATH" ] && SCOPE="local"
[ "$SCOPE" == "global" ] && [ -n "$TARGET_PATH" ] && die_usage "--target only applies to --scope local"

# Never sit waiting on a prompt nobody can answer (the arrow-key menu needs a terminal).
MISSING=()
[ -z "$LANG_PREF" ] && MISSING+=(--lang)
[ -z "$TRACK" ] && MISSING+=(--track)
[ -z "$AGENT" ] && MISSING+=(--agent)
[ -z "$SCOPE" ] && MISSING+=(--scope)
[ "$SCOPE" == "local" ] && [ -z "$TARGET_PATH" ] && MISSING+=(--target)
if [ ${#MISSING[@]} -gt 0 ] && [ ! -t 0 ]; then
    echo "Error: no terminal to prompt on, so these must be given as flags: ${MISSING[*]}" >&2
    echo "" >&2
    usage >&2
    exit 1
fi
PROMPTED=false

# Fail early with an actionable message rather than a bare "command not found" partway in.
require_cmd() {
    command -v "$1" &> /dev/null || {
        echo "Error: '$1' is required for the $2 track but was not found on PATH."
        echo "Install it and re-run this script."
        exit 1
    }
}

# Arrow Key Selection Function
show_menu() {
    local title=$1
    shift
    local options=("$@")
    local selected=0
    local key

    # Hide cursor
    tput civis 2>/dev/null
    trap 'tput cnorm 2>/dev/null; exit 1' SIGINT SIGTERM

    while true; do
        clear
        echo -e "\033[36mPixelz AI Tools Installer\033[0m"
        echo "Project Root: $PROJECT_ROOT"
        echo "-----------------------"
        echo -e "\033[33m$title\033[0m\n"

        for i in "${!options[@]}"; do
            if [ $i -eq $selected ]; then
                echo -e "\033[47m\033[30m > ${options[$i]} \033[0m"
            else
                echo "   ${options[$i]}"
            fi
        done

        # Read key press (handle arrow keys)
        read -rsn1 key
        if [[ $key == $'\x1b' ]]; then
            read -rsn2 key
            if [[ $key == "[A" ]]; then # Up
                ((selected--))
                [ $selected -lt 0 ] && selected=$((${#options[@]} - 1))
            elif [[ $key == "[B" ]]; then # Down
                ((selected++))
                [ $selected -ge ${#options[@]} ] && selected=0
            fi
        elif [[ $key == "" ]]; then # Enter
            break
        fi
    done

    tput cnorm 2>/dev/null
    trap - SIGINT SIGTERM
    return $selected
}

# Copy .env.example to $1 unless a .env is already there.
ensure_env() {
    if [ ! -f "$1" ]; then
        cp "$PROJECT_ROOT/.env.example" "$1" || { echo "Error: could not create $1."; exit 1; }
        chmod 600 "$1"
        echo "Created $1 from .env.example — fill in your credentials before running any tools."
        echo ""
    fi
}

# The first Python 3.10+ that actually runs. On Windows (Git Bash) `python3` is often the
# Microsoft Store placeholder: on PATH, but it only opens the Store.
find_python() {
    local c
    for c in python3 python; do
        "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' &> /dev/null && { echo "$c"; return; }
    done
}

# The interpreter inside venv $1: bin/ on POSIX, Scripts/ on Windows (also under Git Bash).
venv_python() {
    local p
    for p in "$1/bin/python" "$1/Scripts/python.exe"; do
        [ -f "$p" ] && { echo "$p"; return; }
    done
}

# Create (or reuse) the venv in $1 and leave its interpreter in VENV_PY. The system Python is
# never written to: Homebrew/Debian/Ubuntu refuse that (PEP 668), and the exact pins would
# otherwise land in the user's global site-packages.
setup_venv() {
    local dir="$1"
    VENV_PY="$(venv_python "$dir")"
    if [ -z "$VENV_PY" ] || ! "$VENV_PY" -c pass &> /dev/null; then
        echo "Creating Python virtual environment: $dir"
        "$PY" -m venv "$dir" || {
            echo "Error: could not create the virtual environment."
            echo "On Debian/Ubuntu install the venv module first: sudo apt install python3-venv"
            exit 1
        }
        VENV_PY="$(venv_python "$dir")"
    else
        echo "Using Python virtual environment: $dir"
    fi
    [ -n "$VENV_PY" ] && "$VENV_PY" -c pass &> /dev/null || { echo "Error: the virtual environment in $dir has no working python."; exit 1; }

    # Before the quarantine is set: pip itself is an exact, CI-vetted pin, and may be newer than 7 days.
    "$VENV_PY" -m pip install --quiet --disable-pip-version-check "pip==$PINNED_PIP" \
        || echo "WARNING: could not install pip==$PINNED_PIP into the virtual environment."
    # 7-day release quarantine, as pnpm-workspace.yaml does for Node. The requirements files pin
    # only direct dependencies, so this is what holds the transitive ones (mcp pulls in ~30) back.
    if "$VENV_PY" -m pip install --help 2>/dev/null | grep -q -- --uploaded-prior-to; then
        export PIP_UPLOADED_PRIOR_TO="$("$VENV_PY" -c 'import datetime as d; print((d.datetime.now(d.timezone.utc) - d.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
    else
        echo "WARNING: pip older than 26.0 cannot enforce the 7-day release quarantine."
        echo "         Upgrade with: $VENV_PY -m pip install --upgrade pip"
        [ -t 0 ] && sleep 3
    fi
}

# Accept a path the way people paste it: quoted, with a trailing slash, starting with ~, or
# relative to the directory they ran the installer from.
normalize_path() {
    local p="$1"
    p="${p#\"}"; p="${p%\"}"; p="${p#\'}"; p="${p%\'}"
    p="${p/#\~/$HOME}"
    case "$p" in /*|[A-Za-z]:*) ;; *) p="$ORIG_PWD/$p" ;; esac
    [ "$p" != "/" ] && p="${p%/}"
    printf '%s' "$p"
}

# 1. Language Preference — checked right away, because the agent helper runs on it.
if [ -z "$LANG_PREF" ]; then
    PROMPTED=true
    show_menu "Choose Programming Language:" "Node.js" "Python"
    [ $? -eq 0 ] && LANG_PREF="node" || LANG_PREF="python"
fi
if [ "$LANG_PREF" == "node" ]; then
    RUNTIME="node"
    require_cmd node "Node.js"
    # process.loadEnvFile and fs.openAsBlob are stable from 22.21; earlier 22.x mostly works.
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 21) ? 0 : 1)' \
        || echo "WARNING: Node.js $(node --version) is older than the supported v22.21."
    HELPER=(node "$SCRIPT_DIR/agent-config.mjs")
else
    PY="$(find_python)"
    [ -n "$PY" ] || { echo "Error: Python 3.10+ is required for the Python track but none was found (on Windows, 'python3' may be the Microsoft Store placeholder)."; exit 1; }
    # The tools run from a virtual environment created once the scope is known; this
    # interpreter only runs the helper and creates it.
    HELPER=("$PY" "$SCRIPT_DIR/agent_config.py")
fi

# 2. Track Preference
if [ -z "$TRACK" ]; then
    PROMPTED=true
    show_menu "Select Installation Track:" "MCP Servers (Track 1 - Direct Tooling)" "AI Agent Skills (Track 2 - CLI Powered Instructions)"
    [ $? -eq 0 ] && TRACK="mcp" || TRACK="skills"
fi

# 3. AI Agent Preference — the list comes from scripts/agents.json, filtered to this track.
AGENT_IDS=(); AGENT_LABELS=()
while IFS=$'\t' read -r id label; do
    AGENT_IDS+=("$id"); AGENT_LABELS+=("${label%$'\r'}")
done < <("${HELPER[@]}" list --track "$TRACK")
[ ${#AGENT_IDS[@]} -gt 0 ] || { echo "Error: could not read the agent list."; exit 1; }
if [ -n "$AGENT" ]; then
    FOUND=false
    for id in "${AGENT_IDS[@]}"; do [ "$id" == "$AGENT" ] && FOUND=true; done
    if ! $FOUND; then
        if "${HELPER[@]}" list | cut -f1 | tr -d '\r' | grep -qx -- "$AGENT"; then
            echo "Error: agent '$AGENT' does not support the $TRACK track." >&2
        else
            echo "Error: unknown agent '$AGENT'." >&2
        fi
        echo "Agents for the $TRACK track: ${AGENT_IDS[*]}" >&2
        exit 1
    fi
else
    PROMPTED=true
    show_menu "Select AI Agent:" "${AGENT_LABELS[@]}"
    AGENT="${AGENT_IDS[$?]}"
fi

# 4. Scope Preference
if [ -z "$SCOPE" ]; then
    PROMPTED=true
    show_menu "Install Scope:" "Global (Standard User Directory)" "Local (Custom Project Folder)"
    [ $? -eq 1 ] && SCOPE="local" || SCOPE="global"
fi
LOCAL_INSTALL=false
if [ "$SCOPE" == "local" ]; then
    LOCAL_INSTALL=true
    if [ -z "$TARGET_PATH" ]; then
        PROMPTED=true
        echo -n "Enter local target directory path: "
        read TARGET_PATH
    fi
    if [ -z "$TARGET_PATH" ]; then
        echo "Error: No path provided."; exit 1
    fi
    TARGET_PATH="$(normalize_path "$TARGET_PATH")"
    mkdir -p "$TARGET_PATH" || { echo "Error: Failed to create directory '$TARGET_PATH'."; exit 1; }
    TARGET_PATH="$(cd "$TARGET_PATH" && pwd)"
    # Everything a local install needs lives in .pixelz/, so the user's own package.json,
    # lockfile and requirements.txt are never overwritten, and uninstall can remove it whole.
    PIXELZ_DIR="$TARGET_PATH/.pixelz"
    mkdir -p "$PIXELZ_DIR" || { echo "Error: Failed to create '$PIXELZ_DIR'."; exit 1; }
    # Ignore the folder's contents in the user's repo: it holds a .env with API keys.
    echo "*" > "$PIXELZ_DIR/.gitignore"
    SCOPE_ARGS=(--scope local --target "$TARGET_PATH")
    ENV_FILE="$PIXELZ_DIR/.env"
else
    SCOPE_ARGS=(--scope global)
    ENV_FILE="$PROJECT_ROOT/.env"
fi

if $PROMPTED; then clear; fi
echo -e "\033[36mPixelz AI Tools Installer\033[0m"
echo "-----------------------"

VERSION="$("${HELPER[@]}" version | tr -d '\r')"
[ -n "$VERSION" ] || { echo "Error: could not read the version."; exit 1; }
# Prints "Updating ... from X to Y" when an older install is being replaced.
$LOCAL_INSTALL && { "${HELPER[@]}" stamp-version --target "$TARGET_PATH" || { echo "Error: could not write $PIXELZ_DIR/VERSION."; exit 1; }; }

ensure_env "$ENV_FILE"

if [ "$LANG_PREF" == "python" ]; then
    if $LOCAL_INSTALL; then setup_venv "$PIXELZ_DIR/venv"; else setup_venv "$PROJECT_ROOT/.venv"; fi
    RUNTIME="$VENV_PY"
fi

if [ "$TRACK" == "mcp" ]; then
    echo "Installing MCP Server Track..."

    if [ "$LANG_PREF" == "node" ]; then
        # Only the MCP servers have npm dependencies (the SDK and zod); the CLIs have none.
        require_cmd pnpm "Node.js MCP"
        (cd "$PROJECT_ROOT/mcp-servers/platform/node" && pnpm install --frozen-lockfile && pnpm run build) \
            || { echo "Platform MCP build failed."; exit 1; }
        (cd "$PROJECT_ROOT/mcp-servers/automation/node" && pnpm install --frozen-lockfile && pnpm run build) \
            || { echo "Automation MCP build failed."; exit 1; }
        PLATFORM_PATH="$PROJECT_ROOT/mcp-servers/platform/node/build/index.js"
        AUTOMATION_PATH="$PROJECT_ROOT/mcp-servers/automation/node/build/index.js"
    else
        "$VENV_PY" -m pip install -r requirements.txt || { echo "pip install (root) failed."; exit 1; }
        "$VENV_PY" -m pip install -r mcp-servers/platform/python/requirements.txt \
            || { echo "pip install (platform) failed."; exit 1; }
        "$VENV_PY" -m pip install -r mcp-servers/automation/python/requirements.txt \
            || { echo "pip install (automation) failed."; exit 1; }
        PLATFORM_PATH="$PROJECT_ROOT/mcp-servers/platform/python/server.py"
        AUTOMATION_PATH="$PROJECT_ROOT/mcp-servers/automation/python/server.py"
    fi

    # A local install keeps its own credentials, so point the servers at that .env.
    DOTENV_ARGS=()
    $LOCAL_INSTALL && DOTENV_ARGS=(--dotenv "$ENV_FILE")
    "${HELPER[@]}" register-mcp --agent "$AGENT" "${SCOPE_ARGS[@]}" --cmd "$RUNTIME" \
        --platform "$PLATFORM_PATH" --automation "$AUTOMATION_PATH" "${DOTENV_ARGS[@]}" \
        || { echo "MCP registration failed."; exit 1; }

else
    echo "Installing AI Agent Skills Track..."

    if $LOCAL_INSTALL; then
        # The CLIs load the shared module from ../../../shared/<lang>/ relative to cli.js / cli.py.
        SHARED_SRC="$PROJECT_ROOT/shared/$LANG_PREF"
        [ -d "$SHARED_SRC" ] || { echo "Error: $SHARED_SRC is missing - the CLI tools cannot run without it. Update your checkout (git pull) and re-run."; exit 1; }

        # Only the selected language's tree — the skills are patched to one language, so
        # shipping the other is dead weight the user would have to trust and update. Replaced
        # rather than merged, so files removed upstream do not linger across updates.
        for api in platform automation; do
            rm -rf "$PIXELZ_DIR/cli-tools/$api/$LANG_PREF"
            mkdir -p "$PIXELZ_DIR/cli-tools/$api/$LANG_PREF"
            cp -r "$PROJECT_ROOT/cli-tools/$api/$LANG_PREF/." "$PIXELZ_DIR/cli-tools/$api/$LANG_PREF/" \
                || { echo "Error: Failed to copy $api CLI tools."; exit 1; }
        done
        rm -rf "$PIXELZ_DIR/shared/$LANG_PREF"
        mkdir -p "$PIXELZ_DIR/shared/$LANG_PREF"
        cp -r "$SHARED_SRC/." "$PIXELZ_DIR/shared/$LANG_PREF/" || { echo "Error: Failed to copy the shared module."; exit 1; }

        # The Node CLIs use only Node built-ins, so there is nothing to install for them.
        if [ "$LANG_PREF" == "python" ]; then
            "$VENV_PY" -m pip install -r "$PROJECT_ROOT/requirements.txt" || { echo "pip install failed."; exit 1; }
        fi
        # The CLIs load .env from three levels above cli.js, i.e. $PIXELZ_DIR/.env.
        CLI_ROOT="$PIXELZ_DIR/cli-tools"
    else
        if [ "$LANG_PREF" == "python" ]; then
            "$VENV_PY" -m pip install -r requirements.txt || { echo "pip install failed."; exit 1; }
        fi
        CLI_ROOT="$PROJECT_ROOT/cli-tools"
    fi

    "${HELPER[@]}" install-skills --agent "$AGENT" "${SCOPE_ARGS[@]}" \
        --src "$PROJECT_ROOT/skills" --cli-root "$CLI_ROOT" --runtime "$RUNTIME" \
        || { echo "Skill deployment failed."; exit 1; }
fi

echo ""
echo "Credentials: $ENV_FILE"
echo "Pixelz AI Tools version: $VERSION"
echo "Installation Finished!"
