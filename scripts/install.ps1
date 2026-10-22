# Determine project root based on script location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Push-Location $ProjectRoot

# Written for Windows PowerShell 5.1 as well as PowerShell 7: `.\scripts\install.ps1` runs
# under 5.1 by default. Files that must be BOM-free (agent configs, SKILL.md) are written by
# the agent helper, never by Out-File/Set-Content, which add a BOM under 5.1.

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
        $answer = Read-Host "Enter number (1-$($Options.Count))"
        $parsed = 0
        $ok = [int]::TryParse($answer, [ref]$parsed) -and $valid -contains $parsed
        if (-not $ok) {
            Write-Host "Please enter a number between 1 and $($Options.Count)." -ForegroundColor Red
        }
    } while (-not $ok)

    return $parsed - 1
}

function Stop-Install([string]$Message) {
    Write-Host "Error: $Message" -ForegroundColor Red
    Pop-Location
    exit 1
}

# Fail early with an actionable message rather than a bare "not recognized" partway in.
function Assert-Command([string]$Name, [string]$Track) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Stop-Install "'$Name' is required for the $Track track but was not found on PATH. Install it and re-run this script."
    }
}

# Runs a native command and stops the install if it fails.
function Invoke-Checked([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Stop-Install "$What failed." }
}

# Copy .env.example to $Path unless a .env is already there.
function New-EnvFile([string]$Path) {
    if (!(Test-Path $Path)) {
        Copy-Item (Join-Path $ProjectRoot ".env.example") $Path
        Write-Host "Created $Path from .env.example - fill in your credentials before running any tools."
        Write-Host ""
    }
}

# 1. Language Preference - checked right away, because the agent helper runs on it.
$langIdx = Show-Menu "Choose Programming Language:" @("Node.js", "Python")
if ($langIdx -eq 0) {
    $langPref = "node"; $runtime = "node"
    Assert-Command "node" "Node.js"
    Assert-Command "pnpm" "Node.js"
    $helperScript = Join-Path $ScriptDir "agent-config.mjs"
} else {
    $langPref = "python"; $runtime = "python"
    Assert-Command "python" "Python"
    # `python -m pip` rather than `pip`: the dependencies must land in the interpreter the
    # tools will actually run with.
    python -m pip --version *> $null
    if ($LASTEXITCODE -ne 0) { Stop-Install "pip is not available for python." }
    $helperScript = Join-Path $ScriptDir "agent_config.py"
    # 7-day release quarantine, as pnpm-workspace.yaml does for Node. The requirements files pin
    # only direct dependencies, so this is what holds the transitive ones (mcp pulls in ~30) back.
    if ((python -m pip install --help 2>$null) -match '--uploaded-prior-to') {
        $env:PIP_UPLOADED_PRIOR_TO = [DateTime]::UtcNow.AddDays(-7).ToString("yyyy-MM-ddTHH:mm:ssZ")
    } else {
        Write-Host "WARNING: pip older than 26.0 cannot enforce the 7-day release quarantine." -ForegroundColor Yellow
        Write-Host "         Upgrade with: python -m pip install --upgrade pip" -ForegroundColor Yellow
        Start-Sleep -Seconds 3
    }
}
function Invoke-Helper { & $runtime $helperScript @args }

# 2. Track Preference
$trackIdx = Show-Menu "Select Installation Track:" @("MCP Servers (Track 1 - Direct Tooling)", "AI Agent Skills (Track 2 - CLI Powered Instructions)")
$track = if ($trackIdx -eq 0) { "mcp" } else { "skills" }

# 3. AI Agent Preference - the list comes from scripts/agents.json, filtered to this track.
$agents = @(Invoke-Helper list --track $track | ForEach-Object {
    $id, $label = $_ -split "`t", 2
    [pscustomobject]@{ Id = $id; Label = $label }
})
if ($agents.Count -eq 0) { Stop-Install "could not read the agent list." }
$agentIdx = Show-Menu "Select AI Agent:" ($agents | ForEach-Object { $_.Label })
$agent = $agents[$agentIdx].Id

# 4. Scope Preference
$localInstall = $false
$scopeIdx = Show-Menu "Install Scope:" @("Global (Standard User Directory)", "Local (Custom Project Folder)")
if ($scopeIdx -eq 1) {
    $localInstall = $true
    Write-Host "`nEnter local target directory path: " -NoNewline
    $targetPath = Read-Host
    if ([string]::IsNullOrWhiteSpace($targetPath)) { Stop-Install "No path provided." }
    $targetPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($targetPath)
    if (!(Test-Path $targetPath)) {
        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
    }
    # Everything a local install needs lives in .pixelz\, so the user's own package.json,
    # lockfile and requirements.txt are never overwritten, and uninstall can remove it whole.
    $pixelzDir = Join-Path $targetPath ".pixelz"
    New-Item -ItemType Directory -Path $pixelzDir -Force | Out-Null
    # Ignore the folder's contents in the user's repo: it holds a .env with API keys.
    [IO.File]::WriteAllText((Join-Path $pixelzDir ".gitignore"), "*`n")
    $scopeArgs = @("--scope", "local", "--target", $targetPath)
    $envFile = Join-Path $pixelzDir ".env"
} else {
    $scopeArgs = @("--scope", "global")
    $envFile = Join-Path $ProjectRoot ".env"
}

Write-Host ""
Write-Host "-----------------------"

New-EnvFile $envFile

if ($track -eq "mcp") {
    Write-Host "Installing MCP Server Track..." -ForegroundColor Green

    if ($langPref -eq "node") {
        Invoke-Checked "Root pnpm install" { pnpm install --frozen-lockfile }
        foreach ($api in @("platform", "automation")) {
            Push-Location (Join-Path $ProjectRoot "mcp-servers\$api\node")
            pnpm install --frozen-lockfile
            $installOk = $LASTEXITCODE
            if ($installOk -eq 0) { pnpm run build }
            $buildOk = $LASTEXITCODE
            Pop-Location
            if ($installOk -ne 0 -or $buildOk -ne 0) { Stop-Install "$api MCP install/build" }
        }
        $platformPath   = Join-Path $ProjectRoot "mcp-servers\platform\node\build\index.js"
        $automationPath = Join-Path $ProjectRoot "mcp-servers\automation\node\build\index.js"
    } else {
        Invoke-Checked "pip install (root)" { python -m pip install -r requirements.txt }
        Invoke-Checked "pip install (platform)" { python -m pip install -r mcp-servers\platform\python\requirements.txt }
        Invoke-Checked "pip install (automation)" { python -m pip install -r mcp-servers\automation\python\requirements.txt }
        $platformPath   = Join-Path $ProjectRoot "mcp-servers\platform\python\server.py"
        $automationPath = Join-Path $ProjectRoot "mcp-servers\automation\python\server.py"
    }

    # A local install keeps its own credentials, so point the servers at that .env.
    $dotenvArgs = @()
    if ($localInstall) { $dotenvArgs = @("--dotenv", $envFile) }
    Invoke-Helper register-mcp --agent $agent @scopeArgs --cmd $runtime --platform $platformPath --automation $automationPath @dotenvArgs
    if ($LASTEXITCODE -ne 0) { Stop-Install "MCP registration" }

} else {
    Write-Host "Installing AI Agent Skills Track..." -ForegroundColor Green

    if ($localInstall) {
        # Only the selected language's tree - the skills are patched to one language, so
        # shipping the other is dead weight the user would have to trust and update.
        foreach ($api in @("platform", "automation")) {
            $langDest = Join-Path $pixelzDir "cli-tools\$api\$langPref"
            New-Item -ItemType Directory -Path $langDest -Force | Out-Null
            Copy-Item -Path (Join-Path $ProjectRoot "cli-tools\$api\$langPref\*") -Destination $langDest -Recurse -Force
        }

        if ($langPref -eq "node") {
            # pnpm-workspace.yaml carries the supply-chain settings (7-day quarantine etc.).
            foreach ($f in @("package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml")) {
                Copy-Item (Join-Path $ProjectRoot $f) (Join-Path $pixelzDir $f) -Force
            }
            Push-Location $pixelzDir
            pnpm install --frozen-lockfile --prod
            $installOk = $LASTEXITCODE
            Pop-Location
            if ($installOk -ne 0) { Stop-Install "pnpm install in $pixelzDir" }
        } else {
            Copy-Item (Join-Path $ProjectRoot "requirements.txt") (Join-Path $pixelzDir "requirements.txt") -Force
            Invoke-Checked "pip install" { python -m pip install -r (Join-Path $pixelzDir "requirements.txt") }
        }
        # The CLIs load .env from three levels above cli.js, i.e. .pixelz\.env.
        $cliRoot = Join-Path $pixelzDir "cli-tools"
    } else {
        if ($langPref -eq "node") {
            Invoke-Checked "pnpm install" { pnpm install --frozen-lockfile }
        } else {
            Invoke-Checked "pip install" { python -m pip install -r requirements.txt }
        }
        $cliRoot = Join-Path $ProjectRoot "cli-tools"
    }

    Invoke-Helper install-skills --agent $agent @scopeArgs --src (Join-Path $ProjectRoot "skills") --cli-root $cliRoot --runtime $runtime
    if ($LASTEXITCODE -ne 0) { Stop-Install "Skill deployment" }
}

Pop-Location
Write-Host ""
Write-Host "Credentials: $envFile"
Write-Host "Installation Finished!" -ForegroundColor Green
