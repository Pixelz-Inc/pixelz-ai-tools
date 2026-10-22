# Determine project root based on script location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Push-Location $ProjectRoot

Write-Host "Pixelz AI Tools Uninstaller" -ForegroundColor Yellow
Write-Host "========================="

# The agent helper exists in both languages; use whichever runtime is available.
if (Get-Command node -ErrorAction SilentlyContinue) {
    $runtime = "node"; $helperScript = Join-Path $ScriptDir "agent-config.mjs"
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
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
$scopePref = Read-Host "Uninstall from (global/local)"
if ($scopePref -eq "local") {
    $localInstall = $true
    $targetPath = Read-Host "Enter local target directory path"
    if ([string]::IsNullOrWhiteSpace($targetPath)) {
        Write-Host "No path provided." -ForegroundColor Red; Pop-Location; exit 1
    }
    $targetPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($targetPath)
    if (!(Test-Path $targetPath)) {
        Write-Host "Directory not found: $targetPath" -ForegroundColor Red
        Pop-Location; exit 1
    }
    $scopeArgs = @("--scope", "local", "--target", $targetPath)
}

# Both are safe to run whichever track was installed: each removes only Pixelz's own entries
# (the two pixelz-* MCP servers, the skill folders named in skills\) and leaves the rest.
Invoke-Helper unregister-mcp --agent $agent @scopeArgs
Invoke-Helper remove-skills --agent $agent @scopeArgs --src (Join-Path $ProjectRoot "skills")

if ($localInstall) {
    $pixelzDir = Join-Path $targetPath ".pixelz"
    if (Test-Path $pixelzDir) {
        Write-Host "Removing $pixelzDir (CLI tools, dependencies and its .env)..."
        Remove-Item -Path $pixelzDir -Recurse -Force
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
Write-Host "Uninstall complete."
