#!/bin/bash

# Determine project root based on script location
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

echo "Pixelz AI Tools Uninstaller"
echo "========================="

echo "Select AI Agent to uninstall for: 1) Gemini, 2) Claude, 3) Windsurf, 4) OpenCode"
read -p "Choice (1-4): " AGENT_CHOICE
case $AGENT_CHOICE in
    1) AGENT="gemini"; AGENT_DIR="$HOME/.gemini" ;;
    2) AGENT="claude"; AGENT_DIR="$HOME/.claude" ;;
    3) AGENT="windsurf"; AGENT_DIR="$HOME/.windsurf" ;;
    4) AGENT="opencode"; AGENT_DIR="$HOME/.opencode" ;;
    *) echo "Invalid agent"; exit 1 ;;
esac

read -p "Uninstall from (global/local): " SCOPE_PREF
LOCAL_INSTALL=false
if [ "$SCOPE_PREF" == "local" ]; then
    LOCAL_INSTALL=true
    read -p "Enter local target directory path: " TARGET_PATH
    if [ -z "$TARGET_PATH" ]; then
        echo "Error: No path provided."; exit 1
    fi
    if [ ! -d "$TARGET_PATH" ]; then
        echo "Directory not found: $TARGET_PATH"; exit 1
    fi
    TARGET_PATH="$(cd "$TARGET_PATH" && pwd)"
    AGENT_DIR="$TARGET_PATH/.$AGENT"
fi

if [ -d "$AGENT_DIR" ]; then
    echo "Cleaning up $AGENT_DIR..."
    rm -rf "$AGENT_DIR/skills"
    rm -f "$AGENT_DIR/pixelz_config.json"
    echo "Agent config cleaned."
else
    echo "No installation found at $AGENT_DIR."
fi

# For local installs, also remove the CLI tools and npm/pip files that were copied in
if $LOCAL_INSTALL; then
    for item in cli-tools node_modules package.json package-lock.json requirements.txt; do
        target="$TARGET_PATH/$item"
        if [ -e "$target" ]; then
            echo "Removing $target..."
            rm -rf "$target"
        fi
    done
fi

echo "Uninstall complete."
