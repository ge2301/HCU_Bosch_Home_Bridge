<#
  get-dev-token.ps1 - creates a Connect API auth token for REMOTE plugin
  development (running the plugin from your PC against the HCU).

  Steps (see PLAN section 2.1 / Connect API docs 2.4):
    1. HCUweb -> Entwicklermodus aktivieren + "Connect API WebSocket im
       LAN freigeben" einschalten.
    2. HCUweb -> Entwicklermodus -> Aktivierungscode erzeugen.
    3. Run this script with -HcuHost hcu1-XXXX.local (XXXX = last 4 digits of
       the SGTIN) and -ActivationKey ABCDEF.
    4. The token is written to data\dev-authtoken.txt (gitignored).

  Note: the HCU uses a self-signed certificate -> TLS validation is disabled
  for these two requests only.
#>
param(
  [Parameter(Mandatory = $true)][string]$HcuHost,
  [Parameter(Mandatory = $true)][string]$ActivationKey,
  [string]$PluginId = "de.essers.gerrit.plugin.boschbridge",
  [string]$FriendlyName = "Bosch Smart Home Bridge (Dev)"
)

$ErrorActionPreference = "Stop"

# Accept the HCU's self-signed certificate for this process.
add-type @"
using System.Net; using System.Security.Cryptography.X509Certificates;
public class TrustAll : ICertificatePolicy {
  public bool CheckValidationResult(ServicePoint s, X509Certificate c, WebRequest r, int p) { return true; }
}
"@ | Out-Null
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAll
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$base = "https://${HcuHost}:6969"
$headers = @{ "VERSION" = "12"; "Content-Type" = "application/json" }

$body1 = @{ activationKey = $ActivationKey; pluginId = $PluginId; friendlyName = @{ en = $FriendlyName; de = $FriendlyName } } | ConvertTo-Json -Depth 5
Write-Host "==> requestConnectApiAuthToken ..." -ForegroundColor Cyan
$r1 = Invoke-RestMethod -Method Post -Uri "$base/hmip/auth/requestConnectApiAuthToken" -Headers $headers -Body $body1
$token = $r1.authToken
if (-not $token) { throw "no authToken in response" }

$body2 = @{ activationKey = $ActivationKey; authToken = $token } | ConvertTo-Json
Write-Host "==> confirmConnectApiAuthToken ..." -ForegroundColor Cyan
$r2 = Invoke-RestMethod -Method Post -Uri "$base/hmip/auth/confirmConnectApiAuthToken" -Headers $headers -Body $body2

$Root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $Root "data\dev-authtoken.txt"
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
Set-Content -Path $out -Value $token -NoNewline -Encoding ASCII

Write-Host ""
Write-Host "Token written to: $out" -ForegroundColor Green
Write-Host "clientId        : $($r2.clientId)"
Write-Host ""
Write-Host "Run plugin remotely:" -ForegroundColor Cyan
Write-Host "  npm start -- $PluginId $HcuHost ./data/dev-authtoken.txt"
Write-Host "(npm start already appends the default args - override via: node server/index.js $PluginId $HcuHost ./data/dev-authtoken.txt)"
