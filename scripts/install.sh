#!/bin/bash

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

# 1. Language Preference
show_menu "Choose Programming Language:" "Node.js" "Python"
LANG_IDX=$?
[ $LANG_IDX -eq 0 ] && LANG_PREF="node" || LANG_PREF="python"

# 2. Track Preference
show_menu "Select Installation Track:" "MCP Servers (Track 1 - Direct Tooling)" "AI Agent Skills (Track 2 - CLI Powered Instructions)"
TRACK_IDX=$?
TRACK_CHOICE=$((TRACK_IDX + 1))

# 3. AI Agent Preference
show_menu "Select AI Agent:" "Gemini" "Claude" "Windsurf" "OpenCode"
AGENT_IDX=$?
case $AGENT_IDX in
    0) AGENT="gemini"; AGENT_DIR="$HOME/.gemini" ;;
    1) AGENT="claude"; AGENT_DIR="$HOME/.claude" ;;
    # Windsurf (now Devin Desktop) and OpenCode never read ~/.windsurf or ~/.opencode; these are
    # their documented global skill roots (docs.devin.ai/desktop/cascade/skills, opencode.ai/docs/skills).
    2) AGENT="windsurf"; AGENT_DIR="$HOME/.codeium/windsurf" ;;
    3) AGENT="opencode"; AGENT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode" ;;
esac

# 4. Scope Preference
LOCAL_INSTALL=false
show_menu "Install Scope:" "Global (Standard User Directory)" "Local (Custom Project Folder)"
SCOPE_IDX=$?
if [ $SCOPE_IDX -eq 1 ]; then
    LOCAL_INSTALL=true
    echo -n "Enter local target directory path: "
    read TARGET_PATH
    if [ -z "$TARGET_PATH" ]; then
        echo "Error: No path provided."; exit 1
    fi
    mkdir -p "$TARGET_PATH" || { echo "Error: Failed to create directory '$TARGET_PATH'."; exit 1; }
    TARGET_PATH="$(cd "$TARGET_PATH" && pwd)"
    AGENT_DIR="$TARGET_PATH/.$AGENT"
fi

# Verify the toolchain for the chosen language before doing any work
if [ "$LANG_PREF" == "node" ]; then
    require_cmd node "Node.js"
    require_cmd pnpm "Node.js"
else
    require_cmd python3 "Python"
    require_cmd pip "Python"
fi

# Create agent config dir
mkdir -p "$AGENT_DIR" || { echo "Error: Failed to create '$AGENT_DIR'."; exit 1; }

clear
echo -e "\033[36mPixelz AI Tools Installer\033[0m"
echo "-----------------------"

if [ "$TRACK_CHOICE" == "1" ]; then
    echo "Installing MCP Server Track..."

    # Set up .env in project root if not already present
    if [ ! -f "$PROJECT_ROOT/.env" ]; then
        cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
        chmod 600 "$PROJECT_ROOT/.env"
        echo "Created .env from .env.example — fill in your credentials before running any tools."
        echo ""
    fi

    if [ "$LANG_PREF" == "node" ]; then
        pnpm install --frozen-lockfile || { echo "Root pnpm install failed."; exit 1; }
        (cd "$PROJECT_ROOT/mcp-servers/platform/node" && pnpm install --frozen-lockfile && pnpm run build) \
            || { echo "Platform MCP build failed."; exit 1; }
        (cd "$PROJECT_ROOT/mcp-servers/automation/node" && pnpm install --frozen-lockfile && pnpm run build) \
            || { echo "Automation MCP build failed."; exit 1; }
    else
        pip install -r requirements.txt || { echo "pip install (root) failed."; exit 1; }
        pip install -r mcp-servers/platform/python/requirements.txt \
            || { echo "pip install (platform) failed."; exit 1; }
        pip install -r mcp-servers/automation/python/requirements.txt \
            || { echo "pip install (automation) failed."; exit 1; }
    fi

    # Build server paths
    if [ "$LANG_PREF" == "node" ]; then
        PLATFORM_PATH="$PROJECT_ROOT/mcp-servers/platform/node/build/index.js"
        AUTOMATION_PATH="$PROJECT_ROOT/mcp-servers/automation/node/build/index.js"
        MCP_CMD="node"
    else
        PLATFORM_PATH="$PROJECT_ROOT/mcp-servers/platform/python/server.py"
        AUTOMATION_PATH="$PROJECT_ROOT/mcp-servers/automation/python/server.py"
        MCP_CMD="python3"
    fi

    # Always write JSON config as reference and for agents without a CLI
    CONFIG_FILE="$AGENT_DIR/pixelz_config.json"
    cat > "$CONFIG_FILE" <<EOF
{
  "mcpServers": {
    "pixelz-platform":   { "command": "$MCP_CMD", "args": ["$PLATFORM_PATH"] },
    "pixelz-automation": { "command": "$MCP_CMD", "args": ["$AUTOMATION_PATH"] }
  }
}
EOF

    # Agent-specific CLI registration
    if [ "$AGENT" == "claude" ]; then
        if [ "$LOCAL_INSTALL" == "true" ]; then
            # Write .mcp.json directly into the target directory — Claude Code reads this
            # by directory traversal, avoiding path-matching issues with --scope local.
            # PIXELZ_DOTENV_PATH tells the server exactly where to find credentials.
            DOTENV_PATH="$TARGET_PATH/.env"
            cat > "$TARGET_PATH/.mcp.json" <<EOF
{
  "mcpServers": {
    "pixelz-platform":   { "command": "$MCP_CMD", "args": ["$PLATFORM_PATH"],   "env": { "PIXELZ_DOTENV_PATH": "$DOTENV_PATH" } },
    "pixelz-automation": { "command": "$MCP_CMD", "args": ["$AUTOMATION_PATH"], "env": { "PIXELZ_DOTENV_PATH": "$DOTENV_PATH" } }
  }
}
EOF
            echo "MCP servers configured in: $TARGET_PATH/.mcp.json"
        elif command -v claude &>/dev/null; then
            claude mcp remove --scope user pixelz-platform 2>/dev/null || true
            claude mcp remove --scope user pixelz-automation 2>/dev/null || true
            claude mcp add --scope user pixelz-platform -- "$MCP_CMD" "$PLATFORM_PATH"
            claude mcp add --scope user pixelz-automation -- "$MCP_CMD" "$AUTOMATION_PATH"
            echo "MCP servers registered with Claude (scope: user)."
        else
            echo "Claude CLI not found — manual setup required."
            echo "Config written to: $CONFIG_FILE"
            echo "Merge the 'mcpServers' entries into your Claude MCP config."
        fi
    elif [ "$AGENT" == "gemini" ]; then
        if command -v gemini &>/dev/null; then
            gemini mcp remove -s user pixelz-platform 2>/dev/null || true
            gemini mcp remove -s user pixelz-automation 2>/dev/null || true
            gemini mcp add -s user pixelz-platform "$MCP_CMD" "$PLATFORM_PATH"
            gemini mcp add -s user pixelz-automation "$MCP_CMD" "$AUTOMATION_PATH"
            echo "MCP servers registered with Gemini."
        else
            echo "Gemini CLI not found — manual setup required."
            echo "Config written to: $CONFIG_FILE"
            echo "Merge the 'mcpServers' entries into your Gemini MCP config."
        fi
    elif [ "$AGENT" == "opencode" ]; then
        # OpenCode ignores `mcpServers`: it reads `mcp` entries of type "local", with the
        # command and its arguments as a single array (opencode.ai/docs/mcp-servers).
        cat > "$CONFIG_FILE" <<EOF
{
  "mcp": {
    "pixelz-platform":   { "type": "local", "command": ["$MCP_CMD", "$PLATFORM_PATH"],   "enabled": true },
    "pixelz-automation": { "type": "local", "command": ["$MCP_CMD", "$AUTOMATION_PATH"], "enabled": true }
  }
}
EOF
        echo "MCP config written to: $CONFIG_FILE"
        echo "Next step: merge its 'mcp' entries into ~/.config/opencode/opencode.json"
        echo "(or opencode.json in your project)."
    else
        # Windsurf / Devin Desktop has no CLI to register servers and no project-level MCP file.
        echo "MCP config written to: $CONFIG_FILE"
        echo "Next step: merge its 'mcpServers' entries into ~/.config/devin/mcp_config.json"
        echo "(Devin Desktop) or ~/.codeium/windsurf/mcp_config.json (older Windsurf builds)."
    fi

elif [ "$TRACK_CHOICE" == "2" ]; then
    echo "Installing AI Agent Skills Track..."

    if $LOCAL_INSTALL; then
        # Copy CLI tools to the local target so skills can invoke them from there.
        # Only the selected language's tree — the skills are patched to one language, so
        # shipping the other is dead weight the user would have to trust and update.
        for api in platform automation; do
            mkdir -p "$TARGET_PATH/cli-tools/$api/$LANG_PREF"
            cp -r "$PROJECT_ROOT/cli-tools/$api/$LANG_PREF/." "$TARGET_PATH/cli-tools/$api/$LANG_PREF/" \
                || { echo "Error: Failed to copy $api CLI tools."; exit 1; }
        done

        if [ "$LANG_PREF" == "node" ]; then
            cp "$PROJECT_ROOT/package.json" "$TARGET_PATH/package.json"
            # Carry the supply-chain settings into the local install too. This is
            # pnpm-workspace.yaml (not .npmrc) — pnpm 11 reads only auth/registry from .npmrc.
            cp "$PROJECT_ROOT/pnpm-workspace.yaml" "$TARGET_PATH/pnpm-workspace.yaml"
            [ -f "$PROJECT_ROOT/pnpm-lock.yaml" ] && \
                cp "$PROJECT_ROOT/pnpm-lock.yaml" "$TARGET_PATH/pnpm-lock.yaml"
            (cd "$TARGET_PATH" && pnpm install --frozen-lockfile) \
                || { echo "pnpm install in local target failed."; exit 1; }
        else
            cp "$PROJECT_ROOT/requirements.txt" "$TARGET_PATH/requirements.txt"
            pip install -r "$TARGET_PATH/requirements.txt" \
                || { echo "pip install failed."; exit 1; }
        fi

        # Set up .env in the local target (skills load dotenv from their working directory)
        if [ ! -f "$TARGET_PATH/.env" ]; then
            cp "$PROJECT_ROOT/.env.example" "$TARGET_PATH/.env"
            chmod 600 "$TARGET_PATH/.env"
            echo "Created $TARGET_PATH/.env from .env.example — fill in your credentials before running any tools."
            echo ""
        fi

        echo "CLI tools installed to: $TARGET_PATH/cli-tools"
    else
        # Global install: CLI tools stay in project root; install root dependencies
        if [ ! -f "$PROJECT_ROOT/.env" ]; then
            cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
            chmod 600 "$PROJECT_ROOT/.env"
            echo "Created .env from .env.example — fill in your credentials before running any tools."
            echo ""
        fi

        if [ "$LANG_PREF" == "node" ]; then
            pnpm install --frozen-lockfile || { echo "pnpm install failed."; exit 1; }
        else
            pip install -r requirements.txt || { echo "pip install failed."; exit 1; }
        fi
    fi

    mkdir -p "$AGENT_DIR/skills"
    # Remove previously deployed Pixelz skills first, so skills dropped upstream don't
    # linger in the agent's directory across reinstalls.
    for d in "$PROJECT_ROOT"/skills/*/; do
        rm -rf "$AGENT_DIR/skills/$(basename "$d")"
    done
    cp -r "$PROJECT_ROOT"/skills/* "$AGENT_DIR/skills/"

    # Rewrite each skill's CLI command to an ABSOLUTE path, and to the chosen language.
    #
    # Skills are read by the agent and run in the agent's working directory — the user's
    # own project — not in this repo. The relative `cli-tools/...` path in the source
    # SKILL.md therefore resolves only when cwd happens to be the project root, so a
    # global install produced "Cannot find module" for every skill. CLI_ROOT is wherever
    # cli-tools actually landed for this install scope.
    if [ "$LOCAL_INSTALL" == "true" ]; then
        CLI_ROOT="$TARGET_PATH/cli-tools"
    else
        CLI_ROOT="$PROJECT_ROOT/cli-tools"
    fi

    if [ "$LANG_PREF" == "python" ]; then
        NEW_PLATFORM="python3 $CLI_ROOT/platform/python/cli.py"
        NEW_AUTOMATION="python3 $CLI_ROOT/automation/python/cli.py"
    else
        NEW_PLATFORM="node $CLI_ROOT/platform/node/cli.js"
        NEW_AUTOMATION="node $CLI_ROOT/automation/node/cli.js"
    fi

    # Escape the replacement for sed: & means "whole match", and \ and | are special here.
    sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
    SED_PLATFORM="$(sed_escape "$NEW_PLATFORM")"
    SED_AUTOMATION="$(sed_escape "$NEW_AUTOMATION")"

    find "$AGENT_DIR/skills" -name "SKILL.md" | while read -r f; do
        tmp=$(mktemp)
        sed \
            -e "s|node cli-tools/automation/node/cli\.js|$SED_AUTOMATION|g" \
            -e "s|node cli-tools/platform/node/cli\.js|$SED_PLATFORM|g" \
            "$f" > "$tmp" && mv "$tmp" "$f"
    done

    echo "Skills deployed to: $AGENT_DIR/skills"
    echo "Skills invoke the CLI at: $CLI_ROOT"
fi

echo ""
echo "Installation Finished!"
