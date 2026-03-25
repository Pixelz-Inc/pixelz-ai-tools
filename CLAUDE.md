# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Pixelz AI Tools connects the Pixelz Platform and Automation APIs to AI coding assistants (Claude Code, Gemini CLI, Windsurf, OpenCode). It exposes image retouching workflows via two integration tracks users choose between at install time.

## Build Commands

### MCP Servers (Node.js — TypeScript)
```bash
cd mcp-servers/platform/node && npm install && npm run build
cd mcp-servers/automation/node && npm install && npm run build
```
`npm run build` compiles TypeScript via `tsc` into `build/`. Start with `npm start` (runs `node build/index.js`).

### MCP Servers (Python)
No build step — run directly via `python server.py`.

### CLI Tools
No build step — run directly:
```bash
node cli-tools/platform/node/cli.js <command> [args]
node cli-tools/automation/node/cli.js <command> [args]
python cli-tools/platform/python/cli.py <command> [args]
python cli-tools/automation/python/cli.py <command> [args]
```

### Installation Scripts
```bash
bash scripts/install.sh         # Interactive Mac/Linux installer
pwsh scripts/install.ps1        # Interactive Windows installer
```

### Tests
```bash
cd tests/node && npm install && npx vitest run   # Node.js tests (Vitest)
cd tests/python && python -m pytest              # Python tests (pytest)
```

## Architecture: Two Tracks

Users install **one track** at setup time:

### Track 1 — MCP Servers
Native Model Context Protocol integration. AI agents call Pixelz API endpoints as tools directly. Two independent servers:
- **Platform server** (`mcp-servers/platform/`): image CRUD, templates, white-glove, stack, invoices
- **Automation server** (`mcp-servers/automation/`): background removal, color matching, masking, trimap, model crop, async job tracking

Each server is a stdio daemon. Tools are registered with full Zod parameter schemas (Node.js) or FastMCP decorators (Python).

### Track 2 — Skills (SKILL.md files)
Agent Skills standard — procedural `SKILL.md` files installed to the agent's skills directory (e.g., `~/.claude/skills/`). Each skill delegates execution to the CLI tools. There are 21 skills under `skills/`, named `<api>-<action>/SKILL.md`.

## Authentication

**Zero AI credential exposure** — agents never see keys. All credentials are loaded from the root `.env` file at tool/CLI startup. Missing credentials produce structured `[AUTH_ERROR]` messages.

Copy `.env.example` to `.env` and populate:
- `PIXELZ_PLATFORM_EMAIL`, `PIXELZ_PLATFORM_API_KEY`
- `PIXELZ_AUTOMATION_CLIENT_ID`, `PIXELZ_AUTOMATION_CLIENT_SECRET`

**Platform API:** Credentials passed as query params to `https://api.pixelz.com/REST.svc/JSON`.

**Automation API:** OAuth 2.0 Client Credentials via Keycloak (`https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token`). Tokens expire in 1 hour. The CLI tools request new tokens automatically; they are not cached to disk.

## Transparent File Handling

A key shared pattern in both MCP servers and CLI tools: when a local file path is provided as input, it is automatically uploaded to S3 via a presigned URL before the API call. The caller (AI or user) only sees a single seamless step.

Flow: detect local path → request presigned URL from API → binary PUT to S3 → receive download URL → pass download URL to processing endpoint.

## Dual Language Parity

Every component exists in both Node.js and Python with identical functionality:
- `mcp-servers/{platform,automation}/node/` ↔ `mcp-servers/{platform,automation}/python/`
- `cli-tools/{platform,automation}/node/` ↔ `cli-tools/{platform,automation}/python/`

When adding or modifying a feature, both implementations must stay in sync.

## Key Reference Files

| File | Purpose |
|------|---------|
| `requirements.md` | Master blueprint — authoritative design decisions |
| `pixelz-automation-api.json` | Full OpenAPI 3.0 spec for the Automation API |
| `PixelzPlatformAPIdocs.txt` | Platform API reference |
| `.env.example` | Credential template |
| `skills/automation-workflow/SKILL.md` | Orchestration skill showing how skills chain together |
