# Jarvis Claude Code - Windows one-shot setup.
# Idempotent. Installs deps, builds dashboard, sets up OMEGA + ChromaDB, and
# registers scheduled tasks that start the three services at logon.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1 -NoAgents

[CmdletBinding()]
param(
    [switch]$NoAgents,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$script:RepoRoot = $PSScriptRoot
$script:Router   = Join-Path $RepoRoot 'router'
$script:Scripts  = Join-Path $Router 'scripts'
$script:Dashboard = Join-Path $Router 'dashboard'
$script:Agents   = Join-Path $RepoRoot 'agents'
$script:Template = Join-Path $RepoRoot 'agents.example\default'
$script:LogsDir  = Join-Path $env:USERPROFILE '.claude\jarvis\logs'

function Step($msg)  { Write-Host "`n> $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "  [ok] $msg"   -ForegroundColor Green }
function Warn($msg)  { Write-Host "  [!]  $msg"   -ForegroundColor Yellow }
function Skip($msg)  { Write-Host "  [-]  $msg (skipped)" -ForegroundColor DarkGray }
function Info($msg)  { Write-Host "  $msg" -ForegroundColor DarkGray }
function Die($msg)   { Write-Host "  [x] $msg" -ForegroundColor Red; exit 1 }

# --- Prerequisites -----------------------------------------------------------
Step 'Checking prerequisites'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die 'Node.js 20+ required. Install from https://nodejs.org' }
$nodeVersion = (& node -p 'process.versions.node').Trim()
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) { Die "Node.js 20+ required (found $nodeVersion)" }
Ok "Node.js $nodeVersion"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Die 'npm is required.' }
Ok "npm $(& npm -v)"

$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $py) { Die 'Python 3.11+ required. Install from https://www.python.org' }
$pyVersion = (& $py.Source --version) -replace 'Python ',''
$pyMajor = [int]($pyVersion.Split('.')[0])
$pyMinor = [int]($pyVersion.Split('.')[1])
if ($pyMajor -lt 3 -or ($pyMajor -eq 3 -and $pyMinor -lt 11)) {
    Die "Python 3.11+ required (found $pyVersion)"
}
Ok "Python $pyVersion"

if (Get-Command claude -ErrorAction SilentlyContinue) {
    Ok 'Claude Code CLI'
} else {
    Warn 'Claude Code CLI not found (https://docs.claude.com/en/docs/claude-code)'
}

foreach ($bin in 'ffmpeg','pdftotext') {
    if (Get-Command $bin -ErrorAction SilentlyContinue) { Ok $bin }
    else { Warn "$bin not found (media pipeline features using it will be disabled)" }
}

# --- Router deps -------------------------------------------------------------
Step 'Installing router dependencies'
if (Test-Path (Join-Path $Router 'node_modules')) {
    Skip 'router/node_modules'
} else {
    Push-Location $Router
    & npm install --no-fund --no-audit
    Pop-Location
    Ok 'router deps installed'
}

# --- Dashboard ---------------------------------------------------------------
Step 'Building the dashboard'
if (-not (Test-Path (Join-Path $Dashboard 'node_modules'))) {
    Push-Location $Dashboard; & npm install --no-fund --no-audit; Pop-Location
    Ok 'dashboard deps installed'
} else { Skip 'dashboard deps' }

$distIndex = Join-Path $Dashboard 'dist\index.html'
if (Test-Path $distIndex) {
    Skip 'dashboard already built (delete router\dashboard\dist to rebuild)'
} else {
    Push-Location $Dashboard; & npm run build; Pop-Location
    Ok 'dashboard built -> router\dashboard\dist'
}

# --- OMEGA venv + ONNX model + chromadb -------------------------------------
Step 'Setting up Python memory servers (OMEGA + ChromaDB)'
$venv = Join-Path $Scripts 'omega-env'
$venvPython = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $venv)) {
    & $py.Source -m venv $venv
    Ok 'venv created at router\scripts\omega-env'
} else { Skip 'omega-env already exists' }

$hasOmega = $false
try { & $venvPython -c "import omega" 2>$null; $hasOmega = ($LASTEXITCODE -eq 0) } catch {}
if (-not $hasOmega) {
    Info 'installing omega-memory[server] (about 30s)'
    & $venvPython -m pip install --quiet --upgrade pip
    & $venvPython -m pip install --quiet 'omega-memory[server]'
    Ok 'omega-memory installed'
} else { Skip 'omega-memory already installed' }

$hasChroma = $false
try { & $venvPython -c "import chromadb, dotenv" 2>$null; $hasChroma = ($LASTEXITCODE -eq 0) } catch {}
if (-not $hasChroma) {
    Info 'installing chromadb + python-dotenv (about 30s)'
    & $venvPython -m pip install --quiet chromadb python-dotenv
    Ok 'chromadb installed'
} else { Skip 'chromadb already installed' }

$modelCache = Join-Path $env:USERPROFILE '.cache\omega\models\bge-small-en-v1.5-onnx'
if (-not (Test-Path $modelCache) -or -not (Get-ChildItem $modelCache -ErrorAction SilentlyContinue)) {
    Info 'downloading ONNX embedding model (about 90 MB, one-time)'
    $omegaExe = Join-Path $venv 'Scripts\omega.exe'
    & $omegaExe setup --download-model --client venv | Out-Null
    Ok 'ONNX model ready'
} else { Skip 'ONNX model already present' }

# --- Config files ------------------------------------------------------------
Step 'Creating config files'
$envFile = Join-Path $Router '.env'
if (Test-Path $envFile) { Skip 'router\.env exists' }
else { Copy-Item (Join-Path $Router '.env.example') $envFile; Ok 'router\.env created (fill in bot tokens)' }

$cfgFile = Join-Path $Router 'config.yaml'
if (Test-Path $cfgFile) { Skip 'router\config.yaml exists' }
else { Copy-Item (Join-Path $Router 'config.example.yaml') $cfgFile; Ok 'router\config.yaml created' }

# --- Default agent -----------------------------------------------------------
Step 'Scaffolding default agent'
$agentDefault = Join-Path $Agents 'default'
if (Test-Path $agentDefault) { Skip 'agents\default already exists' }
else {
    if (-not (Test-Path $Agents)) { New-Item -ItemType Directory -Path $Agents | Out-Null }
    Copy-Item -Recurse $Template $agentDefault
    Ok 'agents\default created from template'
}

# --- jarvis-config skill -----------------------------------------------------
Step 'Installing jarvis-config skill'
$skillSrc = Join-Path $RepoRoot 'skills\jarvis-config'
$skillsRoot = Join-Path $env:USERPROFILE '.claude\skills'
$skillDst = Join-Path $skillsRoot 'jarvis-config'
if (Test-Path $skillSrc) {
    if (-not (Test-Path $skillsRoot)) { New-Item -ItemType Directory -Path $skillsRoot | Out-Null }
    if (Test-Path $skillDst) { Skip '~/.claude/skills/jarvis-config already present' }
    else {
        # Junction works without admin, unlike SymbolicLink.
        New-Item -ItemType Junction -Path $skillDst -Target $skillSrc | Out-Null
        Ok "linked skill -> $skillDst"
    }
} else { Warn "skill source missing at $skillSrc" }

# --- Scheduled tasks (autostart at logon) -----------------------------------
$tasksInstalled = $false
if ($NoAgents) {
    Step 'Scheduled tasks'
    Skip 'auto-start disabled (-NoAgents)'
} else {
    Step 'Registering scheduled tasks (chroma + omega + router)'
    if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null }

    $pythonw = Join-Path $venv 'Scripts\pythonw.exe'
    if (-not (Test-Path $pythonw)) { $pythonw = $venvPython }  # fallback
    $nodeExe = $node.Source
    $tsxJs   = Join-Path $Router 'node_modules\tsx\dist\cli.mjs'

    $tasks = @(
        @{
            Name = 'JarvisChroma'
            Action = New-ScheduledTaskAction `
                -Execute $pythonw `
                -Argument "`"$(Join-Path $Scripts 'chroma-server.py')`"" `
                -WorkingDirectory $Router
        },
        @{
            Name = 'JarvisOmega'
            Action = New-ScheduledTaskAction `
                -Execute $pythonw `
                -Argument "`"$(Join-Path $Scripts 'omega-server.py')`"" `
                -WorkingDirectory $Scripts
        },
        @{
            Name = 'JarvisRouter'
            Action = New-ScheduledTaskAction `
                -Execute $nodeExe `
                -Argument "`"$tsxJs`" src\index.ts" `
                -WorkingDirectory $Router
        }
    )

    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -Hidden
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

    foreach ($t in $tasks) {
        try {
            Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false -ErrorAction SilentlyContinue
            Register-ScheduledTask `
                -TaskName $t.Name `
                -Action $t.Action `
                -Trigger $trigger `
                -Settings $settings `
                -Principal $principal `
                -Description "Jarvis Claude Code: $($t.Name)" | Out-Null
            Start-ScheduledTask -TaskName $t.Name
            Ok "$($t.Name) registered + started"
        } catch {
            Warn "$($t.Name) failed: $($_.Exception.Message)"
        }
    }
    $tasksInstalled = $true
}

# --- Done --------------------------------------------------------------------
Write-Host ""
Write-Host "[OK] Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Fill in bot tokens:         router\.env"
Write-Host "  2. Review routes & channels:   router\config.yaml"
Write-Host "  3. Customize your first agent: agents\default\"
Write-Host ""

if ($tasksInstalled) {
    Write-Host "All services run in the background and auto-start at logon:" -ForegroundColor White
    Write-Host "  ChromaDB (docs)         :3342"
    Write-Host "  OMEGA    (conversation) :3343"
    Write-Host "  Router   (bots + web)   :3340 / :3341"
    Write-Host ""
    Write-Host "  Logs:    $LogsDir"
    Write-Host "  Manage:  Get-ScheduledTask 'Jarvis*'"
    Write-Host "  Restart: Stop-ScheduledTask -TaskName JarvisRouter; Start-ScheduledTask -TaskName JarvisRouter"
    Write-Host ""
    Write-Host "Dashboard: http://localhost:3340"
    Write-Host ""
    Write-Host "Important: after editing .env / config.yaml, restart the router task." -ForegroundColor Yellow
} else {
    Write-Host "Start the stack manually (three terminals):"
    Write-Host "  cd router"
    Write-Host "  scripts\omega-env\Scripts\python.exe scripts\chroma-server.py"
    Write-Host "  scripts\omega-env\Scripts\python.exe scripts\omega-server.py"
    Write-Host "  npm start"
}
