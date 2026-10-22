# Determine project root based on script location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Push-Location $ProjectRoot

function Show-Menu {
    param (
        [string]$Title,
        [string[]]$Options
    )

    Write-Host ""
    Write-Host "Pixelz AI Tools Installer" -ForegroundColor Cyan
    Write-Host "Project Root: $ProjectRoot"
    Write-Host "-----------------------"
    Write-Host $Title -ForegroundColor Yellow
    Write-Host ""

    for ($i = 0; $i -lt $Options.Count; $i++) {
        Write-Host "  $($i + 1)) $($Options[$i])"
    }

    Write-Host ""
    $valid = 1..$Options.Count
    do {
        $input = Read-Host "Enter number (1-$($Options.Count))"
        $parsed = 0
        $ok = [int]::TryParse($input, [ref]$parsed) -and $valid -contains $parsed
        if (-not $ok) {
            Write-Host "Please enter a number between 1 and $($Options.Count)." -ForegroundColor Red
        }
    } while (-not $ok)

    return $parsed - 1
}

# 1. Language Preference
$langIdx = Show-Menu "Choose Programming Language:" @("Node.js", "Python")
$langPref = if ($langIdx -eq 0) { "node" } else { "python" }

# 2. Track Preference
$trackIdx = Show-Menu "Select Installation Track:" @("MCP Servers (Track 1 - Direct Tooling)", "AI Agent Skills (Track 2 - CLI Powered Instructions)")
$trackChoice = $trackIdx + 1

# 3. AI Agent Preference
$agentIdx = Show-Menu "Select AI Agent:" @("Gemini", "Claude", "Windsurf", "OpenCode")
switch ($agentIdx) {
    0 { $agent = "gemini";   $agentDir = "$HOME\.gemini" }
    1 { $agent = "claude";   $agentDir = "$HOME\.claude" }
    # Windsurf (now Devin Desktop) and OpenCode never read ~\.windsurf or ~\.opencode; these are
    # their documented global skill roots (docs.devin.ai/desktop/cascade/skills, opencode.ai/docs/skills).
    2 { $agent = "windsurf"; $agentDir = "$HOME\.codeium\windsurf" }
    3 { $agent = "opencode"; $agentDir = "$HOME\.config\opencode" }
}

# 4. Scope Preference
$localInstall = $false
$scopeIdx = Show-Menu "Install Scope:" @("Global (Standard User Directory)", "Local (Custom Project Folder)")
if ($scopeIdx -eq 1) {
    $localInstall = $true
    Write-Host "`nEnter local target directory path: " -NoNewline
    $targetPath = Read-Host
    if ([string]::IsNullOrWhiteSpace($targetPath)) {
        Write-Error "No path provided."
        Pop-Location
        exit 1
    }
    $targetPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($targetPath)
    if (!(Test-Path $targetPath)) {
        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
    }
    $agentDir = Join-Path $targetPath ".$agent"
}

# Create agent config dir
if (!(Test-Path $agentDir)) {
    New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
}

Write-Host ""
Write-Host "-----------------------"

if ($trackChoice -eq 1) {
    Write-Host "Installing MCP Server Track..." -ForegroundColor Green

    # Set up .env in project root if not already present
    $envFile = Join-Path $ProjectRoot ".env"
    if (!(Test-Path $envFile)) {
        Copy-Item (Join-Path $ProjectRoot ".env.example") $envFile
        Write-Host "Created .env from .env.example - fill in your credentials before running any tools."
        Write-Host ""
    }

    if ($langPref -eq "node") {
        pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Root pnpm install failed."
            Pop-Location
            exit 1
        }

        Push-Location (Join-Path $ProjectRoot "mcp-servers\platform\node")
        pnpm install --frozen-lockfile
        pnpm run build
        $buildOk = $LASTEXITCODE
        Pop-Location
        if ($buildOk -ne 0) {
            Write-Error "Platform MCP build failed."
            Pop-Location
            exit 1
        }

        Push-Location (Join-Path $ProjectRoot "mcp-servers\automation\node")
        pnpm install --frozen-lockfile
        pnpm run build
        $buildOk = $LASTEXITCODE
        Pop-Location
        if ($buildOk -ne 0) {
            Write-Error "Automation MCP build failed."
            Pop-Location
            exit 1
        }
    } else {
        pip install -r requirements.txt
        if ($LASTEXITCODE -ne 0) {
            Write-Error "pip install (root) failed."
            Pop-Location
            exit 1
        }
        pip install -r mcp-servers\platform\python\requirements.txt
        if ($LASTEXITCODE -ne 0) {
            Write-Error "pip install (platform) failed."
            Pop-Location
            exit 1
        }
        pip install -r mcp-servers\automation\python\requirements.txt
        if ($LASTEXITCODE -ne 0) {
            Write-Error "pip install (automation) failed."
            Pop-Location
            exit 1
        }
    }

    # Build server paths - use forward slashes so JSON and CLI args are portable
    if ($langPref -eq "node") {
        $platformPath   = (Join-Path $ProjectRoot "mcp-servers\platform\node\build\index.js").Replace('\', '/')
        $automationPath = (Join-Path $ProjectRoot "mcp-servers\automation\node\build\index.js").Replace('\', '/')
        $mcpCmd = "node"
    } else {
        $platformPath   = (Join-Path $ProjectRoot "mcp-servers\platform\python\server.py").Replace('\', '/')
        $automationPath = (Join-Path $ProjectRoot "mcp-servers\automation\python\server.py").Replace('\', '/')
        $mcpCmd = "python"
    }

    # Always write JSON config as reference and for agents without a CLI
    $configFile = Join-Path $agentDir "pixelz_config.json"
    $config = [ordered]@{
        mcpServers = [ordered]@{
            "pixelz-platform"   = [ordered]@{ command = $mcpCmd; args = @($platformPath) }
            "pixelz-automation" = [ordered]@{ command = $mcpCmd; args = @($automationPath) }
        }
    }
    $config | ConvertTo-Json -Depth 5 | Out-File $configFile -Encoding UTF8

    # Agent-specific CLI registration
    if ($agent -eq "claude") {
        if ($localInstall) {
            # Write .mcp.json directly into the target directory — Claude Code reads this
            # by directory traversal, avoiding path-casing issues with --scope local.
            # PIXELZ_DOTENV_PATH tells the server exactly where to find credentials.
            $dotenvPath = (Join-Path $targetPath ".env").Replace('\', '/')
            $mcpConfig = [ordered]@{
                mcpServers = [ordered]@{
                    "pixelz-platform"   = [ordered]@{ command = $mcpCmd; args = @($platformPath);   env = [ordered]@{ PIXELZ_DOTENV_PATH = $dotenvPath } }
                    "pixelz-automation" = [ordered]@{ command = $mcpCmd; args = @($automationPath); env = [ordered]@{ PIXELZ_DOTENV_PATH = $dotenvPath } }
                }
            }
            $mcpJsonFile = Join-Path $targetPath ".mcp.json"
            $mcpConfig | ConvertTo-Json -Depth 5 | Out-File $mcpJsonFile -Encoding UTF8
            Write-Host "MCP servers configured in: $mcpJsonFile"
        } elseif (Get-Command claude -ErrorAction SilentlyContinue) {
            claude mcp remove --scope user pixelz-platform 2>$null
            claude mcp remove --scope user pixelz-automation 2>$null
            claude mcp add --scope user pixelz-platform -- $mcpCmd $platformPath
            claude mcp add --scope user pixelz-automation -- $mcpCmd $automationPath
            Write-Host "MCP servers registered with Claude (scope: user)."
        } else {
            Write-Host "Claude CLI not found — manual setup required."
            Write-Host "Config written to: $configFile"
            Write-Host "Merge the 'mcpServers' entries into your Claude MCP config."
        }
    } elseif ($agent -eq "gemini") {
        if (Get-Command gemini -ErrorAction SilentlyContinue) {
            gemini mcp remove -s user pixelz-platform 2>$null
            gemini mcp remove -s user pixelz-automation 2>$null
            gemini mcp add -s user pixelz-platform $mcpCmd $platformPath
            gemini mcp add -s user pixelz-automation $mcpCmd $automationPath
            Write-Host "MCP servers registered with Gemini."
        } else {
            Write-Host "Gemini CLI not found — manual setup required."
            Write-Host "Config written to: $configFile"
            Write-Host "Merge the 'mcpServers' entries into your Gemini MCP config."
        }
    } elseif ($agent -eq "opencode") {
        # OpenCode ignores `mcpServers`: it reads `mcp` entries of type "local", with the
        # command and its arguments as a single array (opencode.ai/docs/mcp-servers).
        $openCodeConfig = [ordered]@{
            mcp = [ordered]@{
                "pixelz-platform"   = [ordered]@{ type = "local"; command = @($mcpCmd, $platformPath);   enabled = $true }
                "pixelz-automation" = [ordered]@{ type = "local"; command = @($mcpCmd, $automationPath); enabled = $true }
            }
        }
        $openCodeConfig | ConvertTo-Json -Depth 5 | Out-File $configFile -Encoding UTF8
        Write-Host "MCP config written to: $configFile"
        Write-Host "Next step: merge its 'mcp' entries into $HOME\.config\opencode\opencode.json"
        Write-Host "(or opencode.json in your project)."
    } else {
        # Windsurf / Devin Desktop has no CLI to register servers and no project-level MCP file.
        Write-Host "MCP config written to: $configFile"
        Write-Host "Next step: merge its 'mcpServers' entries into $env:APPDATA\devin\mcp_config.json"
        Write-Host "(Devin Desktop) or $HOME\.codeium\windsurf\mcp_config.json (older Windsurf builds)."
    }

} elseif ($trackChoice -eq 2) {
    Write-Host "Installing AI Agent Skills Track..." -ForegroundColor Green

    if ($localInstall) {
        # Copy CLI tools to the local target so skills can invoke them from there.
        # Only the selected language's tree - the skills are patched to one language, so
        # shipping the other is dead weight the user would have to trust and update.
        foreach ($api in @("platform", "automation")) {
            $langDest = Join-Path $targetPath "cli-tools\$api\$langPref"
            if (!(Test-Path $langDest)) { New-Item -ItemType Directory -Path $langDest -Force | Out-Null }
            Copy-Item -Path (Join-Path $ProjectRoot "cli-tools\$api\$langPref\*") -Destination $langDest -Recurse -Force
        }

        if ($langPref -eq "node") {
            Copy-Item (Join-Path $ProjectRoot "package.json") (Join-Path $targetPath "package.json") -Force
            # Carry the supply-chain settings into the local install too. This is
            # pnpm-workspace.yaml (not .npmrc) — pnpm 11 reads only auth/registry from .npmrc.
            Copy-Item (Join-Path $ProjectRoot "pnpm-workspace.yaml") (Join-Path $targetPath "pnpm-workspace.yaml") -Force
            $lockFile = Join-Path $ProjectRoot "pnpm-lock.yaml"
            if (Test-Path $lockFile) {
                Copy-Item $lockFile (Join-Path $targetPath "pnpm-lock.yaml") -Force
            }
            Push-Location $targetPath
            pnpm install --frozen-lockfile
            $installOk = $LASTEXITCODE
            Pop-Location
            if ($installOk -ne 0) {
                Write-Error "pnpm install in local target failed."
                Pop-Location
                exit 1
            }
        } else {
            Copy-Item (Join-Path $ProjectRoot "requirements.txt") (Join-Path $targetPath "requirements.txt") -Force
            pip install -r (Join-Path $targetPath "requirements.txt")
            if ($LASTEXITCODE -ne 0) {
                Write-Error "pip install failed."
                Pop-Location
                exit 1
            }
        }

        # Set up .env in the local target (skills load dotenv from their working directory)
        $localEnvFile = Join-Path $targetPath ".env"
        if (!(Test-Path $localEnvFile)) {
            Copy-Item (Join-Path $ProjectRoot ".env.example") $localEnvFile
            Write-Host "Created $localEnvFile from .env.example - fill in your credentials before running any tools."
            Write-Host ""
        }

        Write-Host "CLI tools installed to: $(Join-Path $targetPath 'cli-tools')"
    } else {
        # Global install: CLI tools stay in project root; install root dependencies
        $envFile = Join-Path $ProjectRoot ".env"
        if (!(Test-Path $envFile)) {
            Copy-Item (Join-Path $ProjectRoot ".env.example") $envFile
            Write-Host "Created .env from .env.example - fill in your credentials before running any tools."
            Write-Host ""
        }

        if ($langPref -eq "node") {
            pnpm install --frozen-lockfile
            if ($LASTEXITCODE -ne 0) {
                Write-Error "pnpm install failed."
                Pop-Location
                exit 1
            }
        } else {
            pip install -r requirements.txt
            if ($LASTEXITCODE -ne 0) {
                Write-Error "pip install failed."
                Pop-Location
                exit 1
            }
        }
    }

    $skillsDir = Join-Path $agentDir "skills"
    if (!(Test-Path $skillsDir)) {
        New-Item -ItemType Directory -Path $skillsDir -Force | Out-Null
    }
    # Remove previously deployed Pixelz skills first, so skills dropped upstream don't
    # linger in the agent's directory across reinstalls.
    Get-ChildItem -Path (Join-Path $ProjectRoot "skills") -Directory | ForEach-Object {
        $stale = Join-Path $skillsDir $_.Name
        if (Test-Path $stale) { Remove-Item $stale -Recurse -Force }
    }
    Copy-Item -Path (Join-Path $ProjectRoot "skills\*") -Destination $skillsDir -Recurse -Force

    # Rewrite each skill's CLI command to an ABSOLUTE path, and to the chosen language.
    #
    # Skills are read by the agent and run in the agent's working directory - the user's
    # own project - not in this repo. The relative `cli-tools/...` path in the source
    # SKILL.md therefore resolves only when cwd happens to be the project root, so a
    # global install produced "Cannot find module" for every skill. $cliRoot is wherever
    # cli-tools actually landed for this install scope.
    if ($localInstall) {
        $cliRoot = Join-Path $targetPath "cli-tools"
    } else {
        $cliRoot = Join-Path $ProjectRoot "cli-tools"
    }

    if ($langPref -eq "python") {
        $newPlatform   = "python `"$(Join-Path $cliRoot 'platform\python\cli.py')`""
        $newAutomation = "python `"$(Join-Path $cliRoot 'automation\python\cli.py')`""
    } else {
        $newPlatform   = "node `"$(Join-Path $cliRoot 'platform\node\cli.js')`""
        $newAutomation = "node `"$(Join-Path $cliRoot 'automation\node\cli.js')`""
    }

    # .Replace() is a literal string swap - unlike -replace it treats the path as data,
    # so backslashes and $ in the target path are not reinterpreted.
    Get-ChildItem -Path $skillsDir -Recurse -Filter "SKILL.md" | ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        $content = $content.Replace('node cli-tools/automation/node/cli.js', $newAutomation)
        $content = $content.Replace('node cli-tools/platform/node/cli.js', $newPlatform)
        Set-Content $_.FullName -Value $content -Encoding UTF8
    }

    Write-Host "Skills deployed to: $skillsDir"
    Write-Host "Skills invoke the CLI at: $cliRoot"
}

Pop-Location
Write-Host ""
Write-Host "Installation Finished!" -ForegroundColor Green
