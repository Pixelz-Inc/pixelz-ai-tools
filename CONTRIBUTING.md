# Contributing to Pixelz AI Tools

## Prerequisites

- Node.js v22.21+ (`process.loadEnvFile` is stable from 22.21)
- Python v3.10+
- pnpm v11+ and pip

Use pnpm, not npm: the supply-chain settings (7-day release quarantine, no install scripts,
exact pins) live in `pnpm-workspace.yaml`, which npm ignores.

## Building locally

**MCP Servers (Node.js — TypeScript):**
```bash
cd mcp-servers/platform/node && pnpm install && pnpm run build
cd mcp-servers/automation/node && pnpm install && pnpm run build
```

**MCP Servers (Python):** No build step — run directly with `python server.py`.

**CLI Tools:** No build step — run directly with `node cli.js` or `python cli.py`.

## Running tests

**Node.js (Vitest):** needs both MCP servers' dependencies installed (`pnpm install` in each) and
the Python CLI and server dependencies installed first — the suite spawns both CLIs, imports the
servers' `src/`, and compares the Node and Python servers' tool lists. See the README's Testing
section for the full one-time setup.
```bash
cd tests/node && pnpm install && pnpm exec vitest run
```

**Python (pytest):**
```bash
pip install -r tests/python/requirements.txt
python -m pytest tests/python/ -v
```

Tests run automatically on every push and pull request via GitHub Actions.

## Running the linters

**Python (ruff)** — correctness rules only (`E9`, `F`, `B`); see `ruff.toml`:
```bash
ruff check .
```

**CLI tools (TypeScript `checkJs`)** — type-checks the plain-JS CLIs with no extra dependency:
```bash
cd tests/node && pnpm exec tsc -p tsconfig.clitools.json
```

Both run in CI. The ruff rule set is deliberately narrow: the default set flags well over a
hundred import-ordering and style issues here, which would bury real defects in churn.

## Testing a change manually

1. Copy `.env.example` to `.env` and add your credentials.
2. For CLI tools: `node cli-tools/platform/node/cli.js list-templates`
3. For MCP servers: run the built server and connect via an MCP client.

## Project conventions

### Dual-language parity
Every component exists in both Node.js and Python. When you change behaviour in one language, apply the equivalent change in the other. This applies to:
- `mcp-servers/platform/` and `mcp-servers/automation/`
- `cli-tools/platform/` and `cli-tools/automation/`

Parity covers the *process* contract too, not just the API params — both language tracks must
exit non-zero on failure, send diagnostics to stderr (stdout stays clean for JSON), and
categorize errors with the same `[TIMEOUT]` / `[NETWORK_ERROR]` / `[HTTP_<status>]` /
`[AUTH_ERROR]` prefixes. `tests/node/platform/cliContract.test.ts` asserts this against both
languages; add to it rather than relying on review to catch a divergence.

### Auth Guard pattern
All tools must check for credentials before making any API call and return a structured `[AUTH_ERROR]` message if they are missing. Never log or expose credential values.

### `.env` path resolution
All tools load credentials from the `.env` three directories above their own file, which is the repository root (or `<project>/.pixelz/.env` for a local Skills install, where the CLI tools are copied into `.pixelz/cli-tools`). The `PIXELZ_DOTENV_PATH` environment variable overrides the path — the test suite uses it, and local MCP installs set it so the servers read the project's `.pixelz/.env`.

### Transparent file handling
Any tool that accepts an image input must silently detect local file paths, upload them to S3 via a presigned URL, and pass the resulting URL to the API (the DownloadUrl for Platform, the presigned upload URL for Automation). The caller should never need to handle this.

### No runtime dependencies in the CLIs
The Node CLIs (and the HTTP/env code in the Node MCP servers) use only Node built-ins: `fetch` for
HTTP, `fs.openAsBlob` for uploads, `process.loadEnvFile` for `.env`. Keep it that way — it is what
lets the Skills track run with nothing installed.

### Shared modules
Code that is not specific to one API or one tool lives once per language, in
`shared/node/pixelz-common.js` (CommonJS, built-ins only; `pixelz-common.d.ts` types it for the
TypeScript servers) and `shared/python/pixelz_common.py`: HTTP with retries, redaction, logging,
`.env` loading, local-file checks, upload allowlists, argument parsing and the validators both
tracks use. The CLIs and servers load it from `../../../shared/<lang>/` relative to themselves, and
a local Skills install copies it to `.pixelz/shared/<lang>/` — keep that relative layout. Put a fix
there rather than in a consumer whenever it applies to more than one of them.

### Input validation
Validate before any network call and report `[VALIDATION_ERROR] …`. Node MCP servers validate with
Zod schemas (and advertise the same rules in the hand-written JSON Schema); Python servers and
both CLIs use the shared validators. If you add a tool or change a parameter, change it in both
languages: `tests/node/platform/toolParity.test.ts` compares the two servers' tool lists and fails
on any difference in names, parameters, required fields, enums or annotations. Avoid `oneOf` /
`anyOf` in advertised tool schemas — some agent clients reject them; state the rule in the
description and enforce it in the handler.

### CLI flag syntax
Both `--key=value` and `--key value` (space-separated) must be supported, and the Node and Python
CLIs must reject the same inputs with the same first stderr line and exit code
(`tests/node/*/cliValidation.test.ts` asserts this). The Python CLIs define flags with argparse;
the Node CLIs declare the same flags in a spec table.

### Versions
The repo-root `package.json` `version` is the only version number: the servers report it, the
installers print it and stamp it into `.pixelz/VERSION`. Bump it and add a `CHANGELOG.md` entry
for any change a user would notice.

### Installers and agents
`scripts/install.*` and `scripts/uninstall.*` own the menus and dependency installs only. Everything
that touches an AI agent's config — where its skills and MCP config live, merging our entries into
the user's files, removing them again — is in `scripts/agent-config.mjs` and its Python twin
`scripts/agent_config.py`, driven by `scripts/agents.json`. To support a new agent, add an entry to
`agents.json`; `tests/node/installer/agentConfig.test.ts` then covers it for both helpers. Never write
agent config files from the shell scripts: Windows PowerShell 5.1 adds a byte-order mark, and the
helpers are what keeps the user's existing settings intact.

### Skill files
When adding a new API endpoint, add a corresponding `SKILL.md` in `skills/<api>-<method>/`. Every skill must include: command, detailed parameters, why to use it, async job tracking instructions (if applicable), and success criteria.

## Pull requests

- Keep Node and Python implementations in sync.
- Run the test suite before submitting.
- Test both CLI tools and MCP servers if you touch shared logic (auth, file handling).
- Update the relevant `SKILL.md` if the CLI interface changes.
