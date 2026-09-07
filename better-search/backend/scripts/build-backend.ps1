$ErrorActionPreference = "Stop"

$BackendDir = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $BackendDir
$BinaryDir = Join-Path $ProjectRoot "src-tauri\binaries"

New-Item -ItemType Directory -Force -Path $BinaryDir | Out-Null

Write-Host "Building Better Search Go backend..." -ForegroundColor Cyan

Set-Location $BackendDir

go build -o "$BinaryDir\better-search-x86_64-pc-windows-msvc.exe" ./cmd/better-search

Write-Host "Build complete: $BinaryDir\better-search-x86_64-pc-windows-msvc.exe" -ForegroundColor Green