# Where the user ran us from, before Push-Location below: a relative target path means what they typed.
$OrigDir = (Get-Location).Path

# Determine project root based on script location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Push-Location $ProjectRoot

Write-Host "Pixelz AI Tools Uninstaller" -ForegroundColor Yellow
Write-Host "========================="

# The agent helper exists in both languages; use whichever runtime is available.
if (Get-Command node -ErrorAction SilentlyContinue) {
    $runtime = "node"; $helperScript = Join-Path $ScriptDir "agent-config.mjs"
} elseif ((Get-Command python -ErrorAction SilentlyContinue) -and ((python -c pass *> $null) -or $LASTEXITCODE -eq 0)) {
    # (the probe skips the Microsoft Store placeholder, which is on PATH but only opens the Store)
    $runtime = "python"; $helperScript = Join-Path $ScriptDir "agent_config.py"
} else {
    Write-Host "Error: Node.js or Python is required to run the uninstaller." -ForegroundColor Red
    Pop-Location; exit 1
}
function Invoke-Helper { & $runtime $helperScript @args }

$agents = @(Invoke-Helper list | ForEach-Object { ($_ -split "`t", 2) })
$ids = @(); $n = 0
for ($i = 0; $i -lt $agents.Count; $i += 2) {
    $n++; $ids += $agents[$i]
    Write-Host "  $n) $($agents[$i + 1])"
}
$choice = Read-Host "Select AI Agent to uninstall for (1-$n)"
$parsed = 0
if (-not ([int]::TryParse($choice, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le $n)) {
    Write-Host "Invalid choice" -ForegroundColor Red; Pop-Location; exit 1
}
$agent = $ids[$parsed - 1]

$localInstall = $false
$scopeArgs = @("--scope", "global")
$scopePref = (Read-Host "Uninstall from (global/local)").Trim().ToLower()
if ($scopePref -ne "local" -and $scopePref -ne "global") {
    Write-Host "Please answer global or local." -ForegroundColor Red; Pop-Location; exit 1
}
if ($scopePref -eq "local") {
    $localInstall = $true
    $targetPath = Read-Host "Enter local target directory path"
    if ([string]::IsNullOrWhiteSpace($targetPath)) {
        Write-Host "No path provided." -ForegroundColor Red; Pop-Location; exit 1
    }
    # Same forgiving input as install.ps1: quotes, trailing slash, relative to where we ran.
    $targetPath = $targetPath.Trim().Trim('"').Trim("'").TrimEnd('\', '/')
    # `C:\` trimmed to `C:` means "current directory on C:", i.e. this repo - restore the root.
    if ($targetPath -match '^[A-Za-z]:$') { $targetPath += '\' }
    if (-not [IO.Path]::IsPathRooted($targetPath) -and -not $targetPath.StartsWith('~')) { $targetPath = Join-Path $OrigDir $targetPath }
    $targetPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($targetPath)
    if (!(Test-Path $targetPath)) {
        Write-Host "Directory not found: $targetPath" -ForegroundColor Red
        Pop-Location; exit 1
    }
    $scopeArgs = @("--scope", "local", "--target", $targetPath)
}

# Both are safe to run whichever track was installed: each removes only Pixelz's own entries
# (the two pixelz-* MCP servers, the skill folders named in skills\) and leaves the rest.
$helperOk = $true
Invoke-Helper unregister-mcp --agent $agent @scopeArgs
if ($LASTEXITCODE -ne 0) { $helperOk = $false }
Invoke-Helper remove-skills --agent $agent @scopeArgs --src (Join-Path $ProjectRoot "skills")
if ($LASTEXITCODE -ne 0) { $helperOk = $false }

if ($localInstall) {
    $pixelzDir = Join-Path $targetPath ".pixelz"
    if (Test-Path $pixelzDir) {
        # .pixelz\ holds the project's .env and CLI tools for EVERY agent installed here, so it goes
        # only when nothing else still uses it - and never after a failed step above.
        $stillUsing = @(Invoke-Helper in-use --target $targetPath --src (Join-Path $ProjectRoot "skills") --exclude $agent)
        if ($LASTEXITCODE -ne 0) { $helperOk = $false }
        if (-not $helperOk) {
            Write-Host "Kept $pixelzDir because a step above failed." -ForegroundColor Yellow
        } elseif ($stillUsing.Count -gt 0) {
            Write-Host "Kept ${pixelzDir}: still used by $($stillUsing -join ', ')."
        } else {
            Write-Host "Removing $pixelzDir (CLI tools and its .env)..."
            Remove-Item -Path $pixelzDir -Recurse -Force
        }
    }
    # Installs before the .pixelz\ layout copied these into the project root. They may be the
    # user's own files too, so they are listed rather than deleted.
    $legacy = @("cli-tools", "node_modules", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "requirements.txt", ".env") |
        Where-Object { Test-Path (Join-Path $targetPath $_) }
    if ($legacy.Count -gt 0 -and (Test-Path (Join-Path $targetPath "cli-tools\platform"))) {
        Write-Host ""
        Write-Host "NOTE: an older Pixelz install may have copied these into ${targetPath}:"
        $legacy | ForEach-Object { Write-Host "  $_" }
        Write-Host "Delete the ones that are not part of your own project."
    }
}

Pop-Location
if ($helperOk) {
    Write-Host "Uninstall complete."
} else {
    Write-Host "Uninstall finished with errors - see the messages above." -ForegroundColor Red
    exit 1
}
