# Pixelz AI Tools

Connect the **Pixelz Platform** and **Pixelz Automation** APIs directly to your AI coding assistant. This monorepo provides integrations for **Claude Code**, **OpenAI Codex**, **GitHub Copilot**, **Cursor**, **Antigravity**, **Windsurf / Devin Desktop**, and **OpenCode** — plus a universal `.agents/skills` target — enabling automated image retouching workflows with zero-context security.

---

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | v22 or higher | `node --version` |
| pnpm | v11 or higher | `pnpm --version` |
| Python | v3.10 or higher | `python --version` |
| pip | any recent version | `pip --version` |

You only need Node.js **or** Python depending on your language choice during installation — not both.

---

## The Two Integration Tracks

This toolkit offers two paths for integration. During installation, you choose **one**:

### Track 1: MCP Servers (Native Tooling)

For AI agents that support the **Model Context Protocol (MCP)**. Exposes Pixelz endpoints as native tools the AI can call directly. Includes automatic local file handling, full parameter support, Zod input validation (Node.js), and real-time execution. Available in both **Node.js (TypeScript)** and **Python**.

Both servers implement the **2026-07-28** MCP specification (stateless core, `server/discover`,
cacheable list results) via MCP SDK v2 — `@modelcontextprotocol/server` 2.3.1 on Node.js and
`mcp` 2.3.0 on Python. Clients still speaking a 2025-era revision are served unchanged through
the legacy `initialize` handshake, so older agent CLIs keep working without any config change.

### Track 2: AI Agent Skills (High-Reliability Instructions)

For agents that use the **Agent Skills** standard (`SKILL.md`). Provides 22 procedural skill packages that give the AI deep knowledge of how to use Pixelz services. Uses the CLI tools (`cli.js`/`cli.py`) as internal execution engines. Available in both **Node.js** and **Python**.

The installer rewrites each skill's command to the **absolute** path of the CLI it installed, so skills work from any working directory — not just the repo root.

---

## Key Features

### Zero-Context Auth Guard
AI agents never see or handle your raw API keys. All tools load credentials internally from a `.env` file. If keys are missing, the tools return a structured `[AUTH_ERROR]` guiding the user to configure their environment.

### Transparent Local File Uploads
Provide a local file path (e.g., `/home/user/product.jpg`) or a public URL. The tools automatically detect local paths and perform a secure, multi-step S3 upload (presigned URL + binary PUT) internally. To the AI, the process is a single seamless step.

### Agentic Ergonomics
Every skill and tool is optimized for AI reliability:
- **Polling Guidance**: States expected job duration and instructs one check per turn rather than a wall-clock wait an agent cannot honor.
- **Exhaustive Enums**: All possible options provided (e.g., 17 model-crop anatomical locations).
- **Success Criteria**: Guides the AI on how to format output (Markdown tables for invoices, templates, etc.).

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/Pixelz-Inc/pixelz-ai-tools.git
cd pixelz-ai-tools
```

### 2. Run the Interactive Installer

The installer walks you through choosing your language, track, and AI agent. It handles all dependency installation, build steps, and agent registration automatically.

**Windows (PowerShell):**
```powershell
.\scripts\install.ps1
```
If PowerShell refuses to run scripts, use `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`. Windows PowerShell 5.1 and PowerShell 7 both work.

**Mac/Linux (Bash):**
```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

### 3. Configure Credentials

The installer creates a `.env` file from the included template and prints its location. Open it and fill in your API keys:

- **Global install**: `pixelz-ai-tools/.env` (the repository root).
- **Local install**: `<your project>/.pixelz/.env`.

You only need keys for the API(s) you intend to use (Platform, Automation, or both).

### What the Installer Does

1. Prompts you to choose a **language** (Node.js or Python), **track** (MCP or Skills), **AI agent**, and **install scope** (global or local).
2. Installs dependencies and builds servers (MCP track), or deploys the 22 skills (Skills track).
3. Creates the `.env` file from the template.
4. **Registers everything with your agent** — no manual config editing. MCP servers are added to the agent's own config file (or via `claude mcp add` for Claude Code). Your existing settings and servers are kept, the previous file is saved next to it as `<file>.pixelz-backup`, and a file the installer cannot parse (for example JSON with comments) is left untouched with the entries printed for you to paste.

**Local installs** put everything they need — CLI tools, their dependencies, and the `.env` — in a single `.pixelz/` folder inside your project. Your own `package.json`, lockfile and `requirements.txt` are never touched, and `.pixelz/` ignores itself in git so the `.env` cannot be committed by accident.

### Supported Agents

| Agent | Skills (global · local) | MCP servers (global · local) |
|---|---|---|
| Claude Code | `~/.claude/skills` · `.claude/skills` | `claude mcp add --scope user` · `.mcp.json` |
| OpenAI Codex | `~/.agents/skills` · `.agents/skills` | `~/.codex/config.toml` · `.codex/config.toml` ¹ |
| GitHub Copilot (CLI and VS Code) | `~/.copilot/skills` · `.github/skills` | `~/.copilot/mcp-config.json` · `.github/mcp.json` ¹ |
| Cursor | `~/.cursor/skills` · `.cursor/skills` | `~/.cursor/mcp.json` · `.cursor/mcp.json` |
| Antigravity (formerly Gemini CLI) | `~/.gemini/antigravity-cli/skills` · `.agents/skills` | `~/.gemini/config/mcp_config.json` · `.agents/mcp_config.json` |
| Windsurf / Devin Desktop | `~/.codeium/windsurf/skills` · `.windsurf/skills` | `~/.config/devin/mcp_config.json` (Windows: `%APPDATA%\devin\mcp_config.json`) ² |
| OpenCode | `~/.config/opencode/skills` · `.opencode/skills` | `~/.config/opencode/opencode.json` · `opencode.json` |
| Universal (skills only) | `~/.agents/skills` · `.agents/skills` — read by Codex, Copilot, Cursor, OpenCode and Windsurf | — |

`~` is your home folder (`%USERPROFILE%` on Windows). ¹ The agent loads project-level servers only after you mark the project as trusted. ² Windsurf has no project-level MCP config, so a local install registers the servers for your user account (pointing at the project's `.env`).

**Gemini CLI users:** Google moved individual users from Gemini CLI to Antigravity CLI on 2026-06-18, so the installer now targets Antigravity. Uninstalling for Antigravity also removes Pixelz entries an earlier version of this installer added to Gemini CLI.

---

## Project Structure

```
pixelz-ai-tools/
├── mcp-servers/          # Track 1: MCP server integrations (Node.js & Python)
│   ├── platform/         #   Platform API server
│   └── automation/       #   Automation API server
├── skills/               # Track 2: 22 AI Agent Skill packages (SKILL.md)
├── cli-tools/            # CLI utilities supporting the Skills track (Node.js & Python)
│   ├── platform/         #   Platform API CLI
│   └── automation/       #   Automation API CLI
├── scripts/              # Interactive installers and uninstallers
│   ├── agents.json       #   Where each AI agent reads skills and MCP config
│   └── agent-config.mjs  #   Registers/unregisters with agents (Python twin: agent_config.py)
├── tests/                # Test suite
│   ├── node/             #   Vitest tests for Node.js components
│   └── python/           #   pytest tests for Python components
├── .env.example          # Credential template
└── .github/workflows/    # CI: build and test on every push/PR
```

---

## Testing

```bash
# One-time setup: the Node suite spawns the CLIs (both languages) and imports the built servers
pnpm install
(cd mcp-servers/platform/node && pnpm install && pnpm run build)
(cd mcp-servers/automation/node && pnpm install && pnpm run build)
python -m pip install --uploaded-prior-to P7D -r requirements.txt -r tests/python/requirements.txt \
  -r mcp-servers/platform/python/requirements.txt -r mcp-servers/automation/python/requirements.txt

# Node.js (includes the cross-language CLI and installer tests)
cd tests/node && pnpm install && pnpm exec vitest run

# Python
python -m pytest tests/python/ -v
```

**Linters:**
```bash
ruff check .                                              # Python (correctness rules)
cd tests/node && pnpm exec tsc -p tsconfig.clitools.json  # CLI tools (type-check)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full development setup.

---

## Uninstallation

```bash
./scripts/uninstall.sh    # Mac/Linux
.\scripts\uninstall.ps1   # Windows
```

The uninstaller removes only what Pixelz added: the two `pixelz-*` MCP servers from the agent's config, the 22 Pixelz skill folders (your other skills stay), and — for a local install — the project's `.pixelz/` folder. It also cleans up locations that earlier versions of the installer used.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions, testing, and project conventions.

---

## License

[MIT](LICENSE)
