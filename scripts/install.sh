#!/bin/bash

# Determine project root based on script location
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

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
    2) AGENT="windsurf"; AGENT_DIR="$HOME/.windsurf" ;;
    3) AGENT="opencode"; AGENT_DIR="$HOME/.opencode" ;;
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

# Create agent config dir
mkdir -p "$AGENT_DIR"

clear
echo -e "\033[36mPixelz AI Tools Installer\033[0m"
echo "-----------------------"

if [ "$TRACK_CHOICE" == "1" ]; then
    echo "Installing MCP Server Track..."

    # Set up .env in project root if not already present
    if [ ! -f "$PROJECT_ROOT/.env" ]; then
        cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
        echo "Created .env from .env.example — fill in your credentials before running any tools."
        echo ""
    fi

    if [ "$LANG_PREF" == "node" ]; then
        pnpm install || { echo "Root pnpm install failed."; exit 1; }
        (cd "$PROJECT_ROOT/mcp-servers/platform/node" && pnpm install && pnpm run build) \
            || { echo "Platform MCP build failed."; exit 1; }
        (cd "$PROJECT_ROOT/mcp-servers/automation/node" && pnpm install && pnpm run build) \
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
            gemini mcp add -s user pixelz-platform "$MCP_CMD" "$PLATFORM_PATH"
            gemini mcp add -s user pixelz-automation "$MCP_CMD" "$AUTOMATION_PATH"
            echo "MCP servers registered with Gemini."
        else
            echo "Gemini CLI not found — manual setup required."
            echo "Config written to: $CONFIG_FILE"
            echo "Merge the 'mcpServers' entries into your Gemini MCP config."
        fi
    else
        # Windsurf, OpenCode — JSON config only
        echo "MCP config written to: $CONFIG_FILE"
        echo "Next step: merge its 'mcpServers' entries into your agent's MCP config file."
    fi

elif [ "$TRACK_CHOICE" == "2" ]; then
    echo "Installing AI Agent Skills Track..."

    if $LOCAL_INSTALL; then
        # Copy CLI tools to the local target so skills can invoke them from there
        mkdir -p "$TARGET_PATH/cli-tools"
        cp -r "$PROJECT_ROOT/cli-tools/." "$TARGET_PATH/cli-tools/"

        if [ "$LANG_PREF" == "node" ]; then
            cp "$PROJECT_ROOT/package.json" "$TARGET_PATH/package.json"
            cp "$PROJECT_ROOT/.npmrc" "$TARGET_PATH/.npmrc"
            [ -f "$PROJECT_ROOT/pnpm-lock.yaml" ] && \
                cp "$PROJECT_ROOT/pnpm-lock.yaml" "$TARGET_PATH/pnpm-lock.yaml"
            (cd "$TARGET_PATH" && pnpm install) \
                || { echo "pnpm install in local target failed."; exit 1; }
        else
            cp "$PROJECT_ROOT/requirements.txt" "$TARGET_PATH/requirements.txt"
            pip install -r "$TARGET_PATH/requirements.txt" \
                || { echo "pip install failed."; exit 1; }
        fi

        # Set up .env in the local target (skills load dotenv from their working directory)
        if [ ! -f "$TARGET_PATH/.env" ]; then
            cp "$PROJECT_ROOT/.env.example" "$TARGET_PATH/.env"
            echo "Created $TARGET_PATH/.env from .env.example — fill in your credentials before running any tools."
            echo ""
        fi

        echo "CLI tools installed to: $TARGET_PATH/cli-tools"
    else
        # Global install: CLI tools stay in project root; install root dependencies
        if [ ! -f "$PROJECT_ROOT/.env" ]; then
            cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
            echo "Created .env from .env.example — fill in your credentials before running any tools."
            echo ""
        fi

        if [ "$LANG_PREF" == "node" ]; then
            pnpm install || { echo "pnpm install failed."; exit 1; }
        else
            pip install -r requirements.txt || { echo "pip install failed."; exit 1; }
        fi
    fi

    mkdir -p "$AGENT_DIR/skills"
    cp -r skills/* "$AGENT_DIR/skills/"

    # Patch CLI commands in copied skills to match the selected language
    if [ "$LANG_PREF" == "python" ]; then
        find "$AGENT_DIR/skills" -name "SKILL.md" | while read -r f; do
            tmp=$(mktemp)
            sed \
                -e 's|node cli-tools/automation/node/cli\.js|python3 cli-tools/automation/python/cli.py|g' \
                -e 's|node cli-tools/platform/node/cli\.js|python3 cli-tools/platform/python/cli.py|g' \
                "$f" > "$tmp" && mv "$tmp" "$f"
        done
        echo "Skills patched to use Python CLI."
    fi

    echo "Skills deployed to: $AGENT_DIR/skills"
fi

echo ""
echo "Installation Finished!"
