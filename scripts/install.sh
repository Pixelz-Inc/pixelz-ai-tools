#!/bin/bash

# Where the user ran us from, before the cd below: a relative target path means what they typed.
ORIG_PWD="$PWD"

# Determine project root based on script location
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# NOTE: deliberately no `set -e` here. show_menu communicates the chosen index through its
# exit status (`return $selected`, read back as $?), and `((selected--))` returns 1 when the
# result is 0 — under `set -e` either would abort the installer mid-menu. Failure points are
# guarded individually with `|| { echo ...; exit 1; }` instead.

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
show_menu "Choose Programming Language:" "Node.js" "Python"
if [ $? -eq 0 ]; then
    LANG_PREF="node"; RUNTIME="node"
    require_cmd node "Node.js"
    # process.loadEnvFile and fs.openAsBlob are stable from 22.21; earlier 22.x mostly works.
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 21) ? 0 : 1)' \
        || echo "WARNING: Node.js $(node --version) is older than the supported v22.21."
    HELPER=(node "$SCRIPT_DIR/agent-config.mjs")
else
    LANG_PREF="python"
    PY="$(find_python)"
    [ -n "$PY" ] || { echo "Error: Python 3.10+ is required for the Python track but none was found (on Windows, 'python3' may be the Microsoft Store placeholder)."; exit 1; }
    RUNTIME="$PY"
    # `-m pip` rather than `pip`: the dependencies must land in the interpreter the tools run with.
    "$PY" -m pip --version &> /dev/null || { echo "Error: pip is not available for $PY."; exit 1; }
    HELPER=("$PY" "$SCRIPT_DIR/agent_config.py")
    # 7-day release quarantine, as pnpm-workspace.yaml does for Node. The requirements files pin
    # only direct dependencies, so this is what holds the transitive ones (mcp pulls in ~30) back.
    if "$PY" -m pip install --help 2>/dev/null | grep -q -- --uploaded-prior-to; then
        export PIP_UPLOADED_PRIOR_TO="$("$PY" -c 'import datetime as d; print((d.datetime.now(d.timezone.utc) - d.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
    else
        echo "WARNING: pip older than 26.0 cannot enforce the 7-day release quarantine."
        echo "         Upgrade with: $PY -m pip install --upgrade pip"
        sleep 3
    fi
fi

# 2. Track Preference
show_menu "Select Installation Track:" "MCP Servers (Track 1 - Direct Tooling)" "AI Agent Skills (Track 2 - CLI Powered Instructions)"
[ $? -eq 0 ] && TRACK="mcp" || TRACK="skills"

# 3. AI Agent Preference — the list comes from scripts/agents.json, filtered to this track.
AGENT_IDS=(); AGENT_LABELS=()
while IFS=$'\t' read -r id label; do
    AGENT_IDS+=("$id"); AGENT_LABELS+=("${label%$'\r'}")
done < <("${HELPER[@]}" list --track "$TRACK")
[ ${#AGENT_IDS[@]} -gt 0 ] || { echo "Error: could not read the agent list."; exit 1; }
show_menu "Select AI Agent:" "${AGENT_LABELS[@]}"
AGENT="${AGENT_IDS[$?]}"

# 4. Scope Preference
LOCAL_INSTALL=false
show_menu "Install Scope:" "Global (Standard User Directory)" "Local (Custom Project Folder)"
if [ $? -eq 1 ]; then
    LOCAL_INSTALL=true
    echo -n "Enter local target directory path: "
    read TARGET_PATH
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

clear
echo -e "\033[36mPixelz AI Tools Installer\033[0m"
echo "-----------------------"

ensure_env "$ENV_FILE"

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
        "$PY" -m pip install -r requirements.txt || { echo "pip install (root) failed."; exit 1; }
        "$PY" -m pip install -r mcp-servers/platform/python/requirements.txt \
            || { echo "pip install (platform) failed."; exit 1; }
        "$PY" -m pip install -r mcp-servers/automation/python/requirements.txt \
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
        # Only the selected language's tree — the skills are patched to one language, so
        # shipping the other is dead weight the user would have to trust and update.
        for api in platform automation; do
            mkdir -p "$PIXELZ_DIR/cli-tools/$api/$LANG_PREF"
            cp -r "$PROJECT_ROOT/cli-tools/$api/$LANG_PREF/." "$PIXELZ_DIR/cli-tools/$api/$LANG_PREF/" \
                || { echo "Error: Failed to copy $api CLI tools."; exit 1; }
        done

        # The Node CLIs use only Node built-ins, so there is nothing to install for them.
        # Python packages go into the interpreter, so nothing about them belongs in .pixelz/.
        if [ "$LANG_PREF" == "python" ]; then
            "$PY" -m pip install -r "$PROJECT_ROOT/requirements.txt" || { echo "pip install failed."; exit 1; }
        fi
        # The CLIs load .env from three levels above cli.js, i.e. $PIXELZ_DIR/.env.
        CLI_ROOT="$PIXELZ_DIR/cli-tools"
    else
        if [ "$LANG_PREF" == "python" ]; then
            "$PY" -m pip install -r requirements.txt || { echo "pip install failed."; exit 1; }
        fi
        CLI_ROOT="$PROJECT_ROOT/cli-tools"
    fi

    "${HELPER[@]}" install-skills --agent "$AGENT" "${SCOPE_ARGS[@]}" \
        --src "$PROJECT_ROOT/skills" --cli-root "$CLI_ROOT" --runtime "$RUNTIME" \
        || { echo "Skill deployment failed."; exit 1; }
fi

echo ""
echo "Credentials: $ENV_FILE"
echo "Installation Finished!"
