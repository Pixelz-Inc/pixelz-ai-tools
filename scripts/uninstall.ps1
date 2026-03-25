# Determine project root based on script location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Push-Location $ProjectRoot

Write-Host "Pixelz AI Tools Uninstaller" -ForegroundColor Yellow
Write-Host "========================="

Write-Host "Select AI Agent to uninstall for: 1) Gemini, 2) Claude, 3) Windsurf, 4) OpenCode"
$agentChoice = Read-Host "Choice (1-4)"
switch ($agentChoice) {
    "1" { $agent = "gemini"; $agentDir = "$HOME\.gemini" }
    "2" { $agent = "claude"; $agentDir = "$HOME\.claude" }
    "3" { $agent = "windsurf"; $agentDir = "$HOME\.windsurf" }
    "4" { $agent = "opencode"; $agentDir = "$HOME\.opencode" }
    Default { Write-Error "Invalid choice"; Pop-Location; exit 1 }
}

$localInstall = $false
$scopePref = Read-Host "Uninstall from (global/local)"
if ($scopePref -eq "local") {
    $localInstall = $true
    $targetPath = Read-Host "Enter local target directory path"
    if ([string]::IsNullOrWhiteSpace($targetPath)) {
        Write-Error "No path provided."; Pop-Location; exit 1
    }
    $targetPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($targetPath)
    if (!(Test-Path $targetPath)) {
        Write-Host "Directory not found: $targetPath" -ForegroundColor Red
        Pop-Location; exit 1
    }
    $agentDir = Join-Path $targetPath ".$agent"
}

if (Test-Path $agentDir) {
    Write-Host "Cleaning up $agentDir..." -ForegroundColor Green
    $skillsDir = Join-Path $agentDir "skills"
    if (Test-Path $skillsDir) { Remove-Item -Path $skillsDir -Recurse -Force }
    $configFile = Join-Path $agentDir "pixelz_config.json"
    if (Test-Path $configFile) { Remove-Item -Path $configFile -Force }
    Write-Host "Agent config cleaned."
} else {
    Write-Host "No installation found at $agentDir." -ForegroundColor Red
}

# For local installs, also remove the CLI tools and npm/pip files that were copied in
if ($localInstall) {
    foreach ($item in @("cli-tools", "node_modules", "package.json", "package-lock.json", "requirements.txt")) {
        $target = Join-Path $targetPath $item
        if (Test-Path $target) {
            Write-Host "Removing $target..."
            Remove-Item -Path $target -Recurse -Force
        }
    }
}

Pop-Location
Write-Host "Uninstall complete."
