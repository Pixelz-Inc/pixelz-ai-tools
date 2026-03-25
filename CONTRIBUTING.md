# Contributing to Pixelz AI Tools

## Prerequisites

- Node.js v18+
- Python v3.10+
- npm and pip

## Building locally

**MCP Servers (Node.js — TypeScript):**
```bash
cd mcp-servers/platform/node && npm install && npm run build
cd mcp-servers/automation/node && npm install && npm run build
```

**MCP Servers (Python):** No build step — run directly with `python server.py`.

**CLI Tools:** No build step — run directly with `node cli.js` or `python cli.py`.

## Running tests

**Node.js (Vitest):**
```bash
cd tests/node && npm install && npx vitest run
```

**Python (pytest):**
```bash
pip install -r tests/python/requirements.txt
python -m pytest tests/python/ -v
```

Tests run automatically on every push and pull request via GitHub Actions.

## Testing a change manually

1. Copy `.env.example` to `.env` and add your credentials.
2. For CLI tools: `node cli-tools/platform/node/cli.js list-templates`
3. For MCP servers: run the built server and connect via an MCP client.

## Project conventions

### Dual-language parity
Every component exists in both Node.js and Python. When you change behaviour in one language, apply the equivalent change in the other. This applies to:
- `mcp-servers/platform/` and `mcp-servers/automation/`
- `cli-tools/platform/` and `cli-tools/automation/`

### Auth Guard pattern
All tools must check for credentials before making any API call and return a structured `[AUTH_ERROR]` message if they are missing. Never log or expose credential values.

### `.env` path resolution
All tools load credentials from the root `.env` file. The `PIXELZ_DOTENV_PATH` environment variable can override the default path — this is used by the test suite and by Skills track installations where CLI tools may be copied to a different directory.

### Transparent file handling
Any tool that accepts an image input must silently detect local file paths, upload them to S3 via a presigned URL, and pass the resulting download URL (Platform) or file ID (Automation) to the API. The caller should never need to handle this.

### Input validation
Node.js MCP servers validate all tool arguments at runtime using Zod schemas. If you add a new tool or modify parameters, update the corresponding schema.

### CLI flag syntax
Both `--key=value` and `--key value` (space-separated) must be supported. The Node CLI `parseArgs()` function handles this; preserve that behaviour.

### Skill files
When adding a new API endpoint, add a corresponding `SKILL.md` in `skills/<api>-<method>/`. Every skill must include: command, detailed parameters, why to use it, async job tracking instructions (if applicable), and success criteria.

## Pull requests

- Keep Node and Python implementations in sync.
- Run the test suite before submitting.
- Test both CLI tools and MCP servers if you touch shared logic (auth, file handling).
- Update the relevant `SKILL.md` if the CLI interface changes.
