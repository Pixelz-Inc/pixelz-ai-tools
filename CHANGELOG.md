# Changelog

The version is the `version` field of the repo-root `package.json`. The MCP servers report it,
the installers print it, and a local install records it in `.pixelz/VERSION`.

To update an existing install: `git pull`, then re-run the installer with the same choices.

## 2.2.0 — 2026-11-16

- **Minimum versions raised: Node.js 24.11 and Python 3.12** (were 22.21 and 3.10). Python 3.10
  reached end of life in October 2026 and Node 22 does in April 2027; the new minimums are
  supported until April 2028 (Node 24) and October 2028 (Python 3.12). CI now tests Node 24 and
  26 and Python 3.12 and 3.14. The installers warn on an older Node and refuse an older Python.
- Dependencies: `@modelcontextprotocol/server` 2.4.0, `zod` 4.6.7, `@types/node` 24.19.2,
  `python-dotenv` 1.2.4, `ruff` 0.17.4, `responses` 0.26.3, and the `setup-python` /
  `pnpm/action-setup` actions. Clears every `pnpm audit` advisory: the MCP SDK's nested `zod`
  is deduplicated to 4.6.7, and the test runner moves to `vitest` 4.1.12 with `vite` 7.3.7 and
  `esbuild` 0.28.2 pinned (test tooling only; nothing users install). Dependabot now opens one grouped PR per ecosystem and no longer
  proposes major `@types/node` bumps.

## 2.1.0 — 2026-11-16

### Changed behaviour you may notice

- **Python installs use a virtual environment.** The installers no longer `pip install` into the
  system Python (which fails on Homebrew/Debian/Ubuntu and pushed exact pins into your global
  packages). Global installs use `<repo>/.venv`, local installs `<project>/.pixelz/venv`, and the
  agent is registered with that interpreter. Re-run the installer to move an existing install over.
- **Local uploads must be image files.** The Automation API accepts JPG, JPEG, PNG and WEBP only.
  The Platform tools accept common image and camera-raw extensions; set
  `PIXELZ_UPLOAD_ANY_FILE_TYPE=true` in `.env` if Pixelz accepts a format the list misses. Public
  URLs are not checked.
- **CLI argument errors are strict and identical in Node and Python.** A missing argument, a flag
  without a value, a non-numeric number or malformed JSON is now `[VALIDATION_ERROR]` (exit 1)
  before anything is sent. An unknown command exits 2 with usage on stderr; it used to print usage
  and exit 0 in Node.
- **Node `stack` no longer takes the template as a second positional argument** — use
  `--template <ID>`, as the skills and the Python CLI always have.
- **New error code `[UPLOAD_UNAVAILABLE]`** when the Automation account is not enabled for direct
  file uploads (HTTP 403 from the upload endpoint).
- **Local-file and ID errors carry `[VALIDATION_ERROR]`** (`Local file not found`, `Not a regular
  file`, `File too large`, `Invalid <id>`); they were uncategorised in the MCP servers and
  `[API_ERROR]` in the CLIs.
- The Python Platform server is now named `pixelz-platform-mcp`, matching the Node server.

### Added

- Non-interactive installers: `install.sh --lang --track --agent --scope --target` and
  `install.ps1 -Lang -Track -Agent -Scope -Target` (same for the uninstallers). Without a terminal,
  missing values are an error instead of a prompt nobody can answer.
- MCP tool annotations on every tool (`readOnlyHint`, `destructiveHint` on `delete_image`), so
  clients can auto-approve reads and prompt for destructive or billable calls.
- The full Platform image status table (20 codes) in `get_image_status` and the
  `platform-get-image-status` skill, including the codes that need user action: 12 (download
  failed), 90 (rejected by Pixelz) and 95 (awaiting your reply).
- Cost notes in tool descriptions and skills: Platform submissions create a billable order;
  Automation jobs state their token cost.
- Validation the APIs require but the tools did not check: `model_crop` needs at least one crop
  location; colour markers need integer coordinates and exactly one of `swatch_color_code` /
  `swatch_image`.
- `.github/dependabot.yml` (7-day cooldown) and a weekly `audit.yml` workflow (`pnpm audit`,
  `pip-audit`).
- CI: Node 22 and 24, Python 3.10 and 3.12, a Windows run of the Node suite, shellcheck and
  PSScriptAnalyzer for the installers, and a check that the four `pnpm-workspace.yaml` copies
  stay identical.

### Fixed

- Node and Python MCP servers disagreed in several places; they now validate the same things,
  send the same request bodies, omit the same unset parameters, and log the same fields. The Node
  servers used to write every tool call's full arguments (comments, callback URLs, local paths) to
  the log file; they now log identifiers only, as Python did.
- A cross-language test now compares both servers' tool lists (names, parameters, required
  fields, enums, annotations) so this drift fails CI.
- Node CLI: `status`/`delete`/`get-template` without an ID requested `/…/undefined`; `--feather 0`
  was dropped; `--comment true` was sent as a boolean.
- Automation uploads used a registry-dependent MIME lookup in Python and a fixed table in Node;
  both use the same table now.
- `[TIMEOUT]` reported "90 seconds" even for uploads with a longer, size-based limit.
- A log file that cannot be written no longer fails the tool call in Python.
- The Node test suite timed out intermittently on Windows (5 s default per test); the limit is 30 s.
- A local install inside a project whose `package.json` says `"type": "module"` could not load
  the CommonJS CLIs.

### Internal

- The HTTP, retry, redaction, logging, upload and argument-parsing code that was copied into all
  eight tools now lives once per language in `shared/node/` and `shared/python/`. Local installs
  copy it to `.pixelz/shared/`.
- One version number everywhere (the servers reported 2.0.0 while `package.json` said 1.0.0).
