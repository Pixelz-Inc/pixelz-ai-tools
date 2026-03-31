# Pixelz AI Tools

Connect the **Pixelz Platform** and **Pixelz Automation** APIs directly to your AI coding assistant. This monorepo provides integrations for **Claude Code**, **Gemini CLI**, **Windsurf**, and **OpenCode**, enabling automated image retouching workflows with zero-context security.

---

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | v18 or higher | `node --version` |
| pnpm | v10 or higher | `pnpm --version` |
| Python | v3.10 or higher | `python --version` |
| pip | any recent version | `pip --version` |

You only need Node.js **or** Python depending on your language choice during installation — not both.

---

## The Two Integration Tracks

This toolkit offers two paths for integration. During installation, you choose **one**:

### Track 1: MCP Servers (Native Tooling)

For AI agents that support the **Model Context Protocol (MCP)**. Exposes Pixelz endpoints as native tools the AI can call directly. Includes automatic local file handling, full parameter support, Zod input validation (Node.js), and real-time execution. Available in both **Node.js (TypeScript)** and **Python**.

### Track 2: AI Agent Skills (High-Reliability Instructions)

For agents that use the **Agent Skills** standard (`SKILL.md`). Provides 21 procedural skill packages that give the AI deep knowledge of how to use Pixelz services. Uses the CLI tools (`cli.js`/`cli.py`) as internal execution engines. Available in both **Node.js** and **Python**.

---

## Key Features

### Zero-Context Auth Guard
AI agents never see or handle your raw API keys. All tools load credentials internally from a `.env` file. If keys are missing, the tools return a structured `[AUTH_ERROR]` guiding the user to configure their environment.

### Transparent Local File Uploads
Provide a local file path (e.g., `/home/user/product.jpg`) or a public URL. The tools automatically detect local paths and perform a secure, multi-step S3 upload (presigned URL + binary PUT) internally. To the AI, the process is a single seamless step.

### Agentic Ergonomics
Every skill and tool is optimized for AI reliability:
- **Wait Heuristics**: Appropriate polling intervals for async operations.
- **Exhaustive Enums**: All possible options provided (e.g., 17 model-crop anatomical locations).
- **Success Criteria**: Guides the AI on how to format output (Markdown tables for invoices, templates, etc.).

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/niclas-pix/pixelz-ai-tools.git
cd pixelz-ai-tools
```

### 2. Run the Interactive Installer

The installer walks you through choosing your language, track, and AI agent. It handles all dependency installation, build steps, and agent registration automatically.

**Windows (PowerShell):**
```powershell
.\scripts\install.ps1
```

**Mac/Linux (Bash):**
```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

### 3. Configure Credentials

The installer creates a `.env` file from the included template. Open it and fill in your API keys:

- **Global install**: the `.env` is created in the project root (`pixelz-ai-tools/.env`).
- **Local install**: the `.env` is created in your chosen target directory.

You only need keys for the API(s) you intend to use (Platform, Automation, or both).

### What the Installer Does

1. Prompts you to choose a **language** (Node.js or Python), **track** (MCP or Skills), **AI agent**, and **install scope** (global or local).
2. Installs dependencies and builds servers (MCP track) or deploys skill packages (Skills track).
3. Creates the `.env` file from the template.
4. **Claude and Gemini**: Registers MCP servers directly via their CLI — no manual configuration needed.
5. **Windsurf and OpenCode**: Writes a `pixelz_config.json` file that you merge into your agent's MCP config.

---

## Manual MCP Setup (Windsurf / OpenCode)

After the installer runs, it places a `pixelz_config.json` in your agent's config directory. Merge its `mcpServers` entries into your agent's MCP configuration file. Refer to your agent's documentation for the exact location.

---

## Project Structure

```
pixelz-ai-tools/
├── mcp-servers/          # Track 1: MCP server integrations (Node.js & Python)
│   ├── platform/         #   Platform API server
│   └── automation/       #   Automation API server
├── skills/               # Track 2: 21 AI Agent Skill packages (SKILL.md)
├── cli-tools/            # CLI utilities supporting the Skills track (Node.js & Python)
│   ├── platform/         #   Platform API CLI
│   └── automation/       #   Automation API CLI
├── scripts/              # Interactive installers and uninstallers
├── tests/                # Test suite
│   ├── node/             #   Vitest tests for Node.js components
│   └── python/           #   pytest tests for Python components
├── .env.example          # Credential template
└── .github/workflows/    # CI: build and test on every push/PR
```

---

## Testing

```bash
# Node.js
cd tests/node && pnpm install && pnpm exec vitest run

# Python
pip install -r tests/python/requirements.txt
python -m pytest tests/python/ -v
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full development setup.

---

## Uninstallation

To remove deployed skills and configuration from your AI agent's directory:

```bash
./scripts/uninstall.sh    # Mac/Linux
.\scripts\uninstall.ps1   # Windows
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions, testing, and project conventions.

---

## License

[MIT](LICENSE)
