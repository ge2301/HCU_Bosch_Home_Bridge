<#
  build-plugin.ps1 - builds the ARM64 plugin image and produces the .tar.gz
  upload artifact for HCUweb (Plugins -> Datei hochladen).

  Usage:  .\scripts\build-plugin.ps1 [-Version 0.1.0] [-SkipSave]
  Requires Docker Desktop with ARM64 support (QEMU binfmt is default on
  Docker Desktop for Windows).
#>
param(
  [string]$Version = "",
  [switch]$SkipSave
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not $Version) {
  $Version = (Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json).version
}

$imageName = "bosch-hcu-bridge"
$tag = "${imageName}:${Version}"
$tar = Join-Path $Root "dist\$imageName-$Version.tar"
$tarGz = Join-Path $Root "dist\$imageName-$Version.tar.gz"

Write-Host "==> docker build --platform=linux/arm64 -t $tag" -ForegroundColor Cyan
docker build --platform=linux/arm64 -t $tag $Root
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

if ($SkipSave) { return }

New-Item -ItemType Directory -Force -Path (Join-Path $Root "dist") | Out-Null

Write-Host "==> docker save -> $tar" -ForegroundColor Cyan
docker save $tag -o $tar
if ($LASTEXITCODE -ne 0) { throw "docker save failed" }

# Gzip the docker-save tar in place (single gzipped tar, NOT a tar archive
# containing the tar - that is the format the HCU expects, cf. docs 'tar.gz').
Write-Host "==> gzip -> $tarGz" -ForegroundColor Cyan
if (Test-Path $tarGz) { Remove-Item $tarGz -Force }
$in  = [IO.File]::OpenRead($tar)
$out = [IO.File]::Create($tarGz)
$gz  = New-Object IO.Compression.GzipStream($out, [IO.Compression.CompressionMode]::Compress)
$in.CopyTo($gz)
$gz.Dispose(); $out.Dispose(); $in.Dispose()
Remove-Item $tar -Force

$sizeMb = [math]::Round((Get-Item $tarGz).Length / 1MB, 2)
Write-Host "==> Done: $tarGz ($sizeMb MB) - upload this file in HCUweb > Plugins" -ForegroundColor Green
