param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'status'
)
$ErrorActionPreference = 'Stop'
$gameRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $gameRoot
$stateFile = Join-Path $gameRoot 'work/local-host.json'
$statusFile = Join-Path $gameRoot 'work/local-address.txt'
New-Item -ItemType Directory -Force -Path (Join-Path $gameRoot 'work/cpolar') | Out-Null

function Get-ManagedProcess($record) {
    if (-not $record) { return $null }
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq ([DateTime]$record.started).ToUniversalTime().Ticks) {
        return $process
    }
    return $null
}

function Save-State {
    $script:state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

function New-Record($process) {
    return @{ id = $process.Id; started = $process.StartTime.ToUniversalTime().ToString('o') }
}

function Get-PublicAddress {
    $logFile = Join-Path $gameRoot 'work/cpolar/tunnel.out.log'
    if (-not (Test-Path -LiteralPath $logFile)) { return $null }
    $lines = Get-Content -LiteralPath $logFile -Tail 500
    $matchesFound = @($lines | Select-String 'Tunnel established at (https?://[a-zA-Z0-9.-]+)')
    if ($matchesFound.Count -eq 0) { return $null }
    return $matchesFound[-1].Matches[0].Groups[1].Value -replace '^http:', 'https:'
}

$script:state = @{ server = $null; tunnel = $null }
if (Test-Path -LiteralPath $stateFile) {
    $saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $script:state.server = $saved.server
    $script:state.tunnel = $saved.tunnel
}
$lock = New-Object System.Threading.Mutex($false, 'Local\PlayroomLocalHost')
$locked = $false
try {
    try { $locked = $lock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another GameHub start/stop action is in progress.' }

    if ($Action -eq 'stop') {
        foreach ($kind in @('tunnel', 'server')) {
            $process = Get-ManagedProcess $script:state[$kind]
            if ($process) {
                & taskkill.exe /PID $process.Id /T /F | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "Could not stop $kind." }
            }
            $script:state[$kind] = $null
            Save-State
        }
        'Stopped. The public link is now offline.' | Set-Content -LiteralPath $statusFile
        Write-Host 'GameHub server and tunnel stopped.'
        exit 0
    }

    if ($Action -eq 'start') {
        if (-not (Test-Path -LiteralPath 'work/cpolar/account.yml')) {
            throw 'Missing local cpolar account configuration. Sign in to cpolar and configure the client first.'
        }
        if (-not (Test-Path -LiteralPath 'work/cpolar/cpolar.exe')) {
            throw 'Missing cpolar client: work/cpolar/cpolar.exe'
        }
        if (-not (Get-ManagedProcess $script:state.server)) {
            if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) {
                throw 'Port 8787 is already used by an unmanaged process. Stop it before starting GameHub.'
            }
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'GameHub build failed.' }
            $nodeExe = (Get-Command node.exe).Source
            $process = Start-Process -FilePath $nodeExe -ArgumentList @(
                'node_modules/wrangler/bin/wrangler.js', 'dev', '--local',
                '--ip', '127.0.0.1', '--port', '8787', '--inspector-port', '0',
                '--log-level', 'warn', '--show-interactive-dev-session=false'
            ) -WorkingDirectory $gameRoot -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput 'work/game-server.out.log' -RedirectStandardError 'work/game-server.err.log'
            $script:state.server = New-Record $process
            Save-State
        }
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            try {
                $health = Invoke-RestMethod 'http://127.0.0.1:8787/api/health' -TimeoutSec 2
                if ($health.ok -and $health.game -eq 'liars-dice') { $ready = $true; break }
            } catch {}
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw 'Local game did not become ready. Check work/game-server.err.log.' }
        if (-not (Get-ManagedProcess $script:state.tunnel)) {
            $process = Start-Process -FilePath (Join-Path $gameRoot 'work/cpolar/cpolar.exe') -ArgumentList @(
                'http', '-config', 'work/cpolar/account.yml', '-region', 'cn',
                '-daemon', 'off', '-processMode', 'single', '-dashboard', 'off',
                '-inspect-addr', 'false', '-log', 'stdout', '-log-level', 'INFO', '8787'
            ) -WorkingDirectory $gameRoot -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput 'work/cpolar/tunnel.out.log' -RedirectStandardError 'work/cpolar/tunnel.err.log'
            $script:state.tunnel = New-Record $process
            Save-State
        }
        for ($attempt = 0; $attempt -lt 45; $attempt++) {
            if (Get-PublicAddress) { break }
            if (-not (Get-ManagedProcess $script:state.tunnel)) { throw 'cpolar exited. Check work/cpolar/tunnel.err.log.' }
            Start-Sleep -Milliseconds 700
        }
    }

    $server = Get-ManagedProcess $script:state.server
    $tunnel = Get-ManagedProcess $script:state.tunnel
    $address = if ($server -and $tunnel) { Get-PublicAddress } else { $null }
    $report = @(
        "Local game running: $([bool]$server)"
        "Tunnel process running: $([bool]$tunnel)"
        'Local: http://127.0.0.1:8787'
    )
    if ($address) {
        $report += "Public HTTP: $($address -replace '^https:', 'http:')"
        $report += "Public HTTPS: $address"
        $report += 'This is the latest assigned address; it does not guarantee current connectivity.'
        $report += 'Keep the computer awake and connected. The free address may change.'
    } else {
        $report += 'No active address found. Check work/cpolar/tunnel.out.log and tunnel.err.log.'
    }
    $report | Set-Content -LiteralPath $statusFile -Encoding UTF8
    $report | ForEach-Object { Write-Host $_ }
} finally {
    if ($locked) { $lock.ReleaseMutex() }
    $lock.Dispose()
}
