# FILE: scripts/run-local-agnt.ps1
# Purpose: Starts a local relay plus the foreground agnt bridge on Windows.
# Layer: developer utility

[CmdletBinding()]
param(
    [string]$Hostname = "",
    [string]$RelayUrl = "",
    [string]$BindHost = "0.0.0.0",
    [int]$Port = 9000,
    [string]$Provider = "",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$BridgeDir = Join-Path $RootDir "agnt-bridge"
$RelayDir = Join-Path $RootDir "relay"
$RunDir = Join-Path $RootDir ".agnt-local"
$RelayLog = Join-Path $RunDir "relay.log"
$RelayErr = Join-Path $RunDir "relay.err.log"

function Write-RunLog {
    param([string]$Message)
    Write-Host "[run-local-agnt] $Message"
}

function Fail {
    param([string]$Message)
    throw "[run-local-agnt] $Message"
}

function Require-Command {
    param([string]$Name)
    $resolved = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $resolved) {
        Fail "Missing required command: $Name"
    }
}

function Resolve-AdvertisedHostname {
    if ($Hostname.Trim()) {
        return $Hostname.Trim()
    }

    # Prefer physical LAN/Wi-Fi interfaces over virtual ones so the QR points at
    # an address the phone can actually reach. Tailscale is a fine fallback.
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -and
            $_.IPAddress -notlike "127.*" -and
            $_.IPAddress -notlike "169.254.*" -and
            $_.AddressState -eq "Preferred" -and
            $_.InterfaceAlias -notmatch "vEthernet|Default Switch|WSL|Docker|VMware|VirtualBox|Loopback"
        } |
        Sort-Object @{
            Expression = {
                if ($_.InterfaceAlias -match "Wi-Fi|Ethernet") { 0 }
                elseif ($_.InterfaceAlias -match "Tailscale") { 1 }
                else { 2 }
            }
        }, InterfaceMetric, PrefixLength

    $firstAddress = $addresses | Select-Object -First 1
    if ($firstAddress -and $firstAddress.IPAddress) {
        return $firstAddress.IPAddress
    }

    return [System.Net.Dns]::GetHostName()
}

function Normalize-RelayUrl {
    param([string]$RawUrl)

    try {
        $uri = [System.UriBuilder]::new($RawUrl)
        if ($uri.UserName -or $uri.Password) {
            Fail "Credentials are not supported in relay URLs."
        }
        if ($uri.Query -or $uri.Fragment) {
            Fail "Query strings and fragments are not supported in relay URLs."
        }

        switch ($uri.Scheme.ToLowerInvariant()) {
            "ws" { }
            "wss" { }
            "http" { $uri.Scheme = "ws" }
            "https" { $uri.Scheme = "wss" }
            default { Fail "Relay URL must start with ws://, wss://, http://, or https://" }
        }

        if (-not $uri.Path -or $uri.Path -eq "/") {
            $uri.Path = "/relay"
        }

        return $uri.Uri.AbsoluteUri
    } catch {
        Fail "Invalid -RelayUrl '$RawUrl'. Pass ws(s)://.../relay, or paste an http(s) tunnel URL."
    }
}

function Wait-ForRelay {
    param([string]$ProbeHost, [int]$ProbePort, [System.Diagnostics.Process]$RelayProcess)

    $healthUrl = "http://${ProbeHost}:${ProbePort}/health"
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        if ($RelayProcess.HasExited) {
            $relayError = ""
            if (Test-Path -LiteralPath $RelayErr) {
                $relayError = Get-Content -Raw -LiteralPath $RelayErr
            }
            Fail "Relay process exited before becoming healthy. $relayError"
        }

        try {
            Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
            return
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    Fail "Relay did not become healthy at $healthUrl"
}

function Ensure-PackageDependencies {
    param([string]$PackageDir)

    if ($SkipInstall -or (Test-Path -LiteralPath (Join-Path $PackageDir "node_modules"))) {
        return
    }

    Write-RunLog "Installing dependencies in $PackageDir"
    Push-Location $PackageDir
    try {
        npm install
    } finally {
        Pop-Location
    }
}

Require-Command "node"
Require-Command "npm"

$nodeMajor = [int]((node -p "process.versions.node").Split(".")[0])
if ($nodeMajor -lt 18) {
    Fail "Please use Node.js 18 or newer."
}

Ensure-PackageDependencies $BridgeDir
Ensure-PackageDependencies $RelayDir
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

$advertisedHost = Resolve-AdvertisedHostname
$probeHost = if ($BindHost -eq "0.0.0.0" -or -not $BindHost.Trim()) { "127.0.0.1" } else { $BindHost }
$resolvedRelayUrl = if ($RelayUrl.Trim()) {
    Normalize-RelayUrl $RelayUrl.Trim()
} else {
    "ws://${advertisedHost}:${Port}/relay"
}

$existingListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($existingListener) {
    Fail "Port $Port is already in use. Stop the existing listener or rerun with -Port."
}

Write-RunLog "Configuration"
Write-Host "  Relay bind host : $BindHost"
Write-Host "  Relay port      : $Port"
Write-Host "  Relay hostname  : $advertisedHost"
Write-Host "  Relay URL       : $resolvedRelayUrl"
Write-Host "  Relay log       : $RelayLog"
if ($Provider.Trim()) {
    Write-Host "  Provider        : $Provider"
} else {
    Write-Host "  Provider        : (auto-detect)"
}

$previousAgntRelayPort = $env:AGNT_RELAY_PORT
$previousAgntRelayBindHost = $env:AGNT_RELAY_BIND_HOST
$previousAgntRelay = $env:AGNT_RELAY
$previousAgntProvider = $env:AGNT_PROVIDER
$relayProcess = $null

try {
    $env:AGNT_RELAY_PORT = [string]$Port
    $env:AGNT_RELAY_BIND_HOST = $BindHost
    $relayProcess = Start-Process -FilePath "node" `
        -ArgumentList @("server.js") `
        -WorkingDirectory $RelayDir `
        -RedirectStandardOutput $RelayLog `
        -RedirectStandardError $RelayErr `
        -PassThru `
        -WindowStyle Hidden

    Write-RunLog "Started relay process $($relayProcess.Id)"
    Wait-ForRelay -ProbeHost $probeHost -ProbePort $Port -RelayProcess $relayProcess

    Write-RunLog "Relay is healthy. Starting foreground bridge."
    Write-RunLog "Keep this terminal open. Press Ctrl+C to stop the bridge and relay."
    $env:AGNT_RELAY = $resolvedRelayUrl

    $bridgeArgs = @(".\bin\agnt.js", "run")
    if ($Provider.Trim()) {
        $bridgeArgs += @("--provider", $Provider.Trim())
    }

    Push-Location $BridgeDir
    try {
        node @bridgeArgs
    } finally {
        Pop-Location
    }
} finally {
    $env:AGNT_RELAY_PORT = $previousAgntRelayPort
    $env:AGNT_RELAY_BIND_HOST = $previousAgntRelayBindHost
    $env:AGNT_RELAY = $previousAgntRelay
    $env:AGNT_PROVIDER = $previousAgntProvider

    if ($relayProcess -and -not $relayProcess.HasExited) {
        Write-RunLog "Stopping relay process $($relayProcess.Id)"
        Stop-Process -Id $relayProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
