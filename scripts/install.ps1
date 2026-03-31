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
    2 { $agent = "windsurf"; $agentDir = "$HOME\.windsurf" }
    3 { $agent = "opencode"; $agentDir = "$HOME\.opencode" }
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
        pnpm install
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Root pnpm install failed."
            Pop-Location
            exit 1
        }

        Push-Location (Join-Path $ProjectRoot "mcp-servers\platform\node")
        pnpm install
        pnpm run build
        $buildOk = $LASTEXITCODE
        Pop-Location
        if ($buildOk -ne 0) {
            Write-Error "Platform MCP build failed."
            Pop-Location
            exit 1
        }

        Push-Location (Join-Path $ProjectRoot "mcp-servers\automation\node")
        pnpm install
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
            gemini mcp add -s user pixelz-platform $mcpCmd $platformPath
            gemini mcp add -s user pixelz-automation $mcpCmd $automationPath
            Write-Host "MCP servers registered with Gemini."
        } else {
            Write-Host "Gemini CLI not found — manual setup required."
            Write-Host "Config written to: $configFile"
            Write-Host "Merge the 'mcpServers' entries into your Gemini MCP config."
        }
    } else {
        # Windsurf, OpenCode — JSON config only
        Write-Host "MCP config written to: $configFile"
        Write-Host "Next step: merge its 'mcpServers' entries into your agent's MCP config file."
    }

} elseif ($trackChoice -eq 2) {
    Write-Host "Installing AI Agent Skills Track..." -ForegroundColor Green

    if ($localInstall) {
        # Copy CLI tools to the local target so skills can invoke them from there
        $cliDest = Join-Path $targetPath "cli-tools"
        if (!(Test-Path $cliDest)) { New-Item -ItemType Directory -Path $cliDest -Force | Out-Null }
        Copy-Item -Path (Join-Path $ProjectRoot "cli-tools\*") -Destination $cliDest -Recurse -Force

        if ($langPref -eq "node") {
            Copy-Item (Join-Path $ProjectRoot "package.json") (Join-Path $targetPath "package.json") -Force
            Copy-Item (Join-Path $ProjectRoot ".npmrc") (Join-Path $targetPath ".npmrc") -Force
            $lockFile = Join-Path $ProjectRoot "pnpm-lock.yaml"
            if (Test-Path $lockFile) {
                Copy-Item $lockFile (Join-Path $targetPath "pnpm-lock.yaml") -Force
            }
            Push-Location $targetPath
            pnpm install
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
            pnpm install
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
    Copy-Item -Path "skills\*" -Destination $skillsDir -Recurse -Force

    # Patch CLI commands in copied skills to match the selected language
    if ($langPref -eq "python") {
        Get-ChildItem -Path $skillsDir -Recurse -Filter "SKILL.md" | ForEach-Object {
            $content = Get-Content $_.FullName -Raw
            $content = $content -replace 'node cli-tools/automation/node/cli\.js', 'python cli-tools/automation/python/cli.py'
            $content = $content -replace 'node cli-tools/platform/node/cli\.js', 'python cli-tools/platform/python/cli.py'
            Set-Content $_.FullName -Value $content -Encoding UTF8
        }
        Write-Host "Skills patched to use Python CLI."
    }

    Write-Host "Skills deployed to: $skillsDir"
}

Pop-Location
Write-Host ""
Write-Host "Installation Finished!" -ForegroundColor Green
