#!/bin/bash

# Where the user ran us from, before the cd below: a relative target path means what they typed.
ORIG_PWD="$PWD"

# Determine project root based on script location
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

echo "Pixelz AI Tools Uninstaller"
echo "========================="

# The agent helper exists in both languages; use whichever runtime is available. On Windows
# (Git Bash) `python3` is often the Microsoft Store placeholder, so probe that it really runs.
if command -v node &> /dev/null; then
    HELPER=(node "$SCRIPT_DIR/agent-config.mjs")
else
    for c in python3 python; do
        "$c" -c '' &> /dev/null && { HELPER=("$c" "$SCRIPT_DIR/agent_config.py"); break; }
    done
fi
[ ${#HELPER[@]} -gt 0 ] || { echo "Error: Node.js or Python 3 is required to run the uninstaller."; exit 1; }

AGENT_IDS=(); i=0
while IFS=$'\t' read -r id label; do
    i=$((i + 1)); AGENT_IDS+=("$id")
    echo "  $i) ${label%$'\r'}"
done < <("${HELPER[@]}" list)
read -p "Select AI Agent to uninstall for (1-$i): " AGENT_CHOICE
if ! [[ "$AGENT_CHOICE" =~ ^[0-9]+$ ]] || [ "$AGENT_CHOICE" -lt 1 ] || [ "$AGENT_CHOICE" -gt $i ]; then
    echo "Invalid agent"; exit 1
fi
AGENT="${AGENT_IDS[$((AGENT_CHOICE - 1))]}"

read -p "Uninstall from (global/local): " SCOPE_PREF
LOCAL_INSTALL=false
SCOPE_ARGS=(--scope global)
if [ "$(printf '%s' "$SCOPE_PREF" | tr '[:upper:]' '[:lower:]')" == "local" ]; then
    LOCAL_INSTALL=true
    read -p "Enter local target directory path: " TARGET_PATH
    if [ -z "$TARGET_PATH" ]; then
        echo "Error: No path provided."; exit 1
    fi
    # Same forgiving input as install.sh: quotes, trailing slash, ~, relative to where we ran.
    TARGET_PATH="${TARGET_PATH#\"}"; TARGET_PATH="${TARGET_PATH%\"}"
    TARGET_PATH="${TARGET_PATH/#\~/$HOME}"
    case "$TARGET_PATH" in /*|[A-Za-z]:*) ;; *) TARGET_PATH="$ORIG_PWD/$TARGET_PATH" ;; esac
    if [ ! -d "$TARGET_PATH" ]; then
        echo "Directory not found: $TARGET_PATH"; exit 1
    fi
    TARGET_PATH="$(cd "$TARGET_PATH" && pwd)"
    SCOPE_ARGS=(--scope local --target "$TARGET_PATH")
elif [ "$(printf '%s' "$SCOPE_PREF" | tr '[:upper:]' '[:lower:]')" != "global" ]; then
    echo "Please answer global or local."; exit 1
fi

# Both are safe to run whichever track was installed: each removes only Pixelz's own entries
# (the two pixelz-* MCP servers, the skill folders named in skills/) and leaves the rest.
HELPER_OK=true
"${HELPER[@]}" unregister-mcp --agent "$AGENT" "${SCOPE_ARGS[@]}" || HELPER_OK=false
"${HELPER[@]}" remove-skills --agent "$AGENT" "${SCOPE_ARGS[@]}" --src "$PROJECT_ROOT/skills" || HELPER_OK=false

if $LOCAL_INSTALL && [ -d "$TARGET_PATH/.pixelz" ]; then
    # .pixelz/ holds the project's .env and CLI tools for EVERY agent installed here, so it goes
    # only when nothing else still uses it - and never after a failed step above.
    STILL_USING="$("${HELPER[@]}" in-use --target "$TARGET_PATH" --src "$PROJECT_ROOT/skills" --exclude "$AGENT")" || HELPER_OK=false
    if ! $HELPER_OK; then
        echo "Kept $TARGET_PATH/.pixelz because a step above failed."
    elif [ -n "$STILL_USING" ]; then
        echo "Kept $TARGET_PATH/.pixelz: still used by $(echo $STILL_USING | tr -d '\r')."
    else
        echo "Removing $TARGET_PATH/.pixelz (CLI tools and its .env)..."
        rm -rf "$TARGET_PATH/.pixelz"
    fi
fi

if $LOCAL_INSTALL; then
    # Installs before the .pixelz/ layout copied these into the project root. They may be the
    # user's own files too, so they are listed rather than deleted.
    LEGACY=()
    for item in cli-tools node_modules package.json pnpm-lock.yaml pnpm-workspace.yaml requirements.txt .env; do
        [ -e "$TARGET_PATH/$item" ] && LEGACY+=("$item")
    done
    if [ ${#LEGACY[@]} -gt 0 ] && [ -d "$TARGET_PATH/cli-tools/platform" ]; then
        echo ""
        echo "NOTE: an older Pixelz install may have copied these into $TARGET_PATH:"
        printf '  %s\n' "${LEGACY[@]}"
        echo "Delete the ones that are not part of your own project."
    fi
fi

if $HELPER_OK; then
    echo "Uninstall complete."
else
    echo "Uninstall finished with errors - see the messages above."
    exit 1
fi
