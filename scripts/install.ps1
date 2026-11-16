<#
.SYNOPSIS
    Installs Pixelz AI Tools for an AI coding agent.
.DESCRIPTION
    Any value given as a parameter skips its prompt; anything missing is asked for interactively.
    Without a console (CI, scripts, AI agents) every value must be given as a parameter.
.PARAMETER Lang
    node | python
.PARAMETER Track
    mcp (Track 1, MCP servers) | skills (Track 2, Agent Skills + CLI)
.PARAMETER Agent
    An id from scripts/agents.json: claude, codex, copilot, cursor, antigravity, windsurf,
    opencode, universal (universal: skills track only).
.PARAMETER Scope
    global (your user account) | local (one project folder)
.PARAMETER Target
    Project folder for -Scope local; implies -Scope local when -Scope is omitted.
.EXAMPLE
    .\scripts\install.ps1 -Lang node -Track skills -Agent claude -Scope global
#>
param (
    [string]$Lang,
    [string]$Track,
    [string]$Agent,
    [string]$Scope,
    [string]$Target
)

# Where the user ran us from, before Push-Location below: a relative target path means what they typed.
$OrigDir = (Get-Location).Path

# Determine project root based on script location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Push-Location $ProjectRoot

# Written for Windows PowerShell 5.1 as well as PowerShell 7: `.\scripts\install.ps1` runs
# under 5.1 by default. Files that must be BOM-free (agent configs, SKILL.md, VERSION) are written by
# the agent helper, never by Out-File/Set-Content, which add a BOM under 5.1.

# The pip version CI pins. Installed first inside the venv so the 7-day release quarantine
# (--uploaded-prior-to, pip 26.0+) is enforceable whatever pip the system Python ships.
$PinnedPip = "26.2.1"

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

# Accept a path the way people paste it: quoted ("Copy as path"), with a trailing slash (which
# Windows PowerShell 5.1 would pass to native commands as an escaped quote), or relative to the
# directory the installer was started from.
function Resolve-UserPath([string]$Path) {
    $p = $Path.Trim().Trim('"').Trim("'").TrimEnd('\', '/')
    if ($p -match '^[A-Za-z]:$') { $p += '\' }
    if (-not [IO.Path]::IsPathRooted($p) -and -not $p.StartsWith('~')) { $p = Join-Path $OrigDir $p }
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p)
}

# Copy .env.example to $Path unless a .env is already there.
function New-EnvFile([string]$Path) {
    if (!(Test-Path $Path)) {
        Copy-Item (Join-Path $ProjectRoot ".env.example") $Path
        Write-Host "Created $Path from .env.example - fill in your credentials before running any tools."
        Write-Host ""
    }
}

function Write-Usage {
    Write-Host "Flags (any value given skips its prompt; without a console all must be given):"
    Write-Host "  -Lang   node | python"
    Write-Host "  -Track  mcp | skills"
    Write-Host "  -Agent  claude | codex | copilot | cursor | antigravity | windsurf | opencode | universal (skills only)"
    Write-Host "  -Scope  global | local"
    Write-Host "  -Target project folder for -Scope local (implies -Scope local when -Scope is omitted)"
    Write-Host "Example: .\scripts\install.ps1 -Lang node -Track skills -Agent claude -Scope global"
}

function Stop-Usage([string]$Message) {
    Write-Host "Error: $Message" -ForegroundColor Red
    Write-Usage
    Pop-Location
    exit 1
}

# The interpreter inside venv $Dir: Scripts\ on Windows, bin/ elsewhere.
function Get-VenvPython([string]$Dir) {
    foreach ($rel in @("Scripts\python.exe", "bin/python")) {
        $p = Join-Path $Dir $rel
        if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
    }
    return $null
}

# Create (or reuse) the venv in $Dir and leave its interpreter in $script:venvPython. The system Python is never
# written to: Homebrew/Debian/Ubuntu refuse that (PEP 668), and the exact pins would otherwise
# land in the user's global site-packages.
function Initialize-Venv([string]$Dir) {
    $py = Get-VenvPython $Dir
    $works = $false
    if ($py) { & $py -c pass *> $null; $works = ($LASTEXITCODE -eq 0) }
    if (-not $works) {
        Write-Host "Creating Python virtual environment: $Dir"
        & python -m venv $Dir | Out-Host
        if ($LASTEXITCODE -ne 0) { Stop-Install "could not create the virtual environment in $Dir." }
        $py = Get-VenvPython $Dir
        if ($py) { & $py -c pass *> $null; $works = ($LASTEXITCODE -eq 0) }
    } else {
        Write-Host "Using Python virtual environment: $Dir"
    }
    if (-not $works) { Stop-Install "the virtual environment in $Dir has no working python." }

    # Before the quarantine is set: pip itself is an exact, CI-vetted pin, and may be newer than 7 days.
    & $py -m pip install --quiet --disable-pip-version-check "pip==$PinnedPip" | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Host "WARNING: could not install pip==$PinnedPip into the virtual environment." -ForegroundColor Yellow }
    # 7-day release quarantine, as pnpm-workspace.yaml does for Node. The requirements files pin
    # only direct dependencies, so this is what holds the transitive ones (mcp pulls in ~30) back.
    if ((& $py -m pip install --help 2>$null) -match '--uploaded-prior-to') {
        # Invariant culture: ':' in a format string is the culture's time separator, so e.g. fi-FI
        # produced 14.03.46, which pip rejects - failing every pip install below.
        $env:PIP_UPLOADED_PRIOR_TO = [DateTime]::UtcNow.AddDays(-7).ToString("yyyy-MM-dd'T'HH':'mm':'ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
    } else {
        Write-Host "WARNING: pip older than 26.0 cannot enforce the 7-day release quarantine." -ForegroundColor Yellow
        Write-Host "         Upgrade with: $py -m pip install --upgrade pip" -ForegroundColor Yellow
        if (-not [Console]::IsInputRedirected) { Start-Sleep -Seconds 3 }
    }
    # Forward slashes: they need no escaping in the JSON/TOML configs and SKILL.md the helper writes.
    $script:venvPython = $py.Replace('\', '/')
}

# ---- Flags: normalize and validate before doing anything ----
$langPref = if ($Lang) { $Lang.Trim().ToLower() } else { "" }
$track = if ($Track) { $Track.Trim().ToLower() } else { "" }
$scope = if ($Scope) { $Scope.Trim().ToLower() } else { "" }
$agent = if ($Agent) { $Agent.Trim() } else { "" }
$targetPath = if ($Target) { $Target } else { "" }
if ($langPref -and $langPref -ne "node" -and $langPref -ne "python") { Stop-Usage "-Lang must be node or python (got '$Lang')." }
if ($track -and $track -ne "mcp" -and $track -ne "skills") { Stop-Usage "-Track must be mcp or skills (got '$Track')." }
if ($scope -and $scope -ne "global" -and $scope -ne "local") { Stop-Usage "-Scope must be global or local (got '$Scope')." }
if (-not $scope -and $targetPath) { $scope = "local" }
if ($scope -eq "global" -and $targetPath) { Stop-Usage "-Target only applies to -Scope local." }

# Never sit waiting on a prompt nobody can answer.
$missing = @()
if (-not $langPref) { $missing += "-Lang" }
if (-not $track) { $missing += "-Track" }
if (-not $agent) { $missing += "-Agent" }
if (-not $scope) { $missing += "-Scope" }
if ($scope -eq "local" -and -not $targetPath) { $missing += "-Target" }
if ($missing.Count -gt 0 -and [Console]::IsInputRedirected) {
    Stop-Usage "no console to prompt on, so these must be given as parameters: $($missing -join ' ')"
}
$prompted = $false

# 1. Language Preference - checked right away, because the agent helper runs on it.
if (-not $langPref) {
    $prompted = $true
    $langIdx = Show-Menu "Choose Programming Language:" @("Node.js", "Python")
    $langPref = if ($langIdx -eq 0) { "node" } else { "python" }
}
if ($langPref -eq "node") {
    $helperRuntime = "node"; $runtime = "node"
    Assert-Command "node" "Node.js"
    # process.loadEnvFile and fs.openAsBlob are stable from 22.21; earlier 22.x mostly works.
    # Compared here rather than in `node -e`: PowerShell 5.1 strips the inner quotes from native
    # command arguments, which turned split(".") into a syntax error.
    $nodeVersion = [version](node -p process.versions.node)
    if ($nodeVersion -lt [version]'22.21.0') { Write-Host "WARNING: Node.js v$nodeVersion is older than the supported v22.21." -ForegroundColor Yellow }
    $helperScript = Join-Path $ScriptDir "agent-config.mjs"
} else {
    $helperRuntime = "python"
    Assert-Command "python" "Python"
    # The `python` on PATH can be the Microsoft Store placeholder, which exists but only opens the Store.
    python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" *> $null
    if ($LASTEXITCODE -ne 0) { Stop-Install "Python 3.10+ is required for the Python track ('python' may be the Microsoft Store placeholder)." }
    # The tools run from a virtual environment created once the scope is known; this
    # interpreter only runs the helper and creates it.
    $helperScript = Join-Path $ScriptDir "agent_config.py"
}
function Invoke-Helper { & $helperRuntime $helperScript @args }

# 2. Track Preference
if (-not $track) {
    $prompted = $true
    $trackIdx = Show-Menu "Select Installation Track:" @("MCP Servers (Track 1 - Direct Tooling)", "AI Agent Skills (Track 2 - CLI Powered Instructions)")
    $track = if ($trackIdx -eq 0) { "mcp" } else { "skills" }
}

# 3. AI Agent Preference - the list comes from scripts/agents.json, filtered to this track.
$agents = @(Invoke-Helper list --track $track | ForEach-Object {
    $id, $label = $_ -split "`t", 2
    [pscustomobject]@{ Id = $id; Label = $label }
})
if ($agents.Count -eq 0) { Stop-Install "could not read the agent list." }
if ($agent) {
    if (-not ($agents | Where-Object { $_.Id -eq $agent })) {
        $everyAgent = @(Invoke-Helper list | ForEach-Object { ($_ -split "`t", 2)[0] })
        if ($everyAgent -contains $agent) { $why = "agent '$agent' does not support the $track track" } else { $why = "unknown agent '$agent'" }
        Stop-Usage "$why. Agents for the $track track: $(($agents | ForEach-Object { $_.Id }) -join ', ')"
    }
} else {
    $prompted = $true
    $agentIdx = Show-Menu "Select AI Agent:" ($agents | ForEach-Object { $_.Label })
    $agent = $agents[$agentIdx].Id
}

# 4. Scope Preference
if (-not $scope) {
    $prompted = $true
    $scopeIdx = Show-Menu "Install Scope:" @("Global (Standard User Directory)", "Local (Custom Project Folder)")
    $scope = if ($scopeIdx -eq 1) { "local" } else { "global" }
}
$localInstall = ($scope -eq "local")
if ($localInstall) {
    if (-not $targetPath) {
        $prompted = $true
        Write-Host "`nEnter local target directory path: " -NoNewline
        $targetPath = Read-Host
    }
    if ([string]::IsNullOrWhiteSpace($targetPath)) { Stop-Install "No path provided." }
    try { $targetPath = Resolve-UserPath $targetPath } catch { Stop-Install "Not a usable path: $targetPath" }
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

$version = ("" + (Invoke-Helper version | Select-Object -First 1)).Trim()
if (-not $version) { Stop-Install "could not read the version." }
if ($localInstall) {
    # Prints "Updating ... from X to Y" when an older install is being replaced.
    Invoke-Helper stamp-version --target $targetPath
    if ($LASTEXITCODE -ne 0) { Stop-Install "could not write $pixelzDir\VERSION." }
}

New-EnvFile $envFile

if ($langPref -eq "python") {
    $venvDir = if ($localInstall) { Join-Path $pixelzDir "venv" } else { Join-Path $ProjectRoot ".venv" }
    Initialize-Venv $venvDir
    $venvPython = $script:venvPython
    $runtime = $venvPython
}

if ($track -eq "mcp") {
    Write-Host "Installing MCP Server Track..." -ForegroundColor Green

    if ($langPref -eq "node") {
        # Only the MCP servers have npm dependencies (the SDK and zod); the CLIs have none.
        Assert-Command "pnpm" "Node.js MCP"
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
        Invoke-Checked "pip install (root)" { & $venvPython -m pip install -r requirements.txt }
        Invoke-Checked "pip install (platform)" { & $venvPython -m pip install -r mcp-servers\platform\python\requirements.txt }
        Invoke-Checked "pip install (automation)" { & $venvPython -m pip install -r mcp-servers\automation\python\requirements.txt }
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
        # The CLIs load the shared module from ..\..\..\shared\<lang>\ relative to cli.js / cli.py.
        $sharedSrc = Join-Path $ProjectRoot "shared\$langPref"
        if (!(Test-Path -LiteralPath $sharedSrc -PathType Container)) {
            Stop-Install "$sharedSrc is missing - the CLI tools cannot run without it. Update your checkout (git pull) and re-run."
        }

        # Only the selected language's tree - the skills are patched to one language, so
        # shipping the other is dead weight the user would have to trust and update. Replaced
        # rather than merged, so files removed upstream do not linger across updates.
        foreach ($api in @("platform", "automation")) {
            $langDest = Join-Path $pixelzDir "cli-tools\$api\$langPref"
            if (Test-Path -LiteralPath $langDest) { Remove-Item -LiteralPath $langDest -Recurse -Force }
            New-Item -ItemType Directory -Path $langDest -Force | Out-Null
            Copy-Item -Path (Join-Path $ProjectRoot "cli-tools\$api\$langPref\*") -Destination $langDest -Recurse -Force
        }
        $sharedDest = Join-Path $pixelzDir "shared\$langPref"
        if (Test-Path -LiteralPath $sharedDest) { Remove-Item -LiteralPath $sharedDest -Recurse -Force }
        New-Item -ItemType Directory -Path $sharedDest -Force | Out-Null
        Copy-Item -Path (Join-Path $sharedSrc "*") -Destination $sharedDest -Recurse -Force

        # The Node CLIs use only Node built-ins, so there is nothing to install for them.
        if ($langPref -eq "python") {
            Invoke-Checked "pip install" { & $venvPython -m pip install -r (Join-Path $ProjectRoot "requirements.txt") }
        }
        # The CLIs load .env from three levels above cli.js, i.e. .pixelz\.env.
        $cliRoot = Join-Path $pixelzDir "cli-tools"
    } else {
        if ($langPref -eq "python") {
            Invoke-Checked "pip install" { & $venvPython -m pip install -r requirements.txt }
        }
        $cliRoot = Join-Path $ProjectRoot "cli-tools"
    }

    Invoke-Helper install-skills --agent $agent @scopeArgs --src (Join-Path $ProjectRoot "skills") --cli-root $cliRoot --runtime $runtime
    if ($LASTEXITCODE -ne 0) { Stop-Install "Skill deployment" }
}

Pop-Location
Write-Host ""
Write-Host "Credentials: $envFile"
Write-Host "Pixelz AI Tools version: $version"
Write-Host "Installation Finished!" -ForegroundColor Green
