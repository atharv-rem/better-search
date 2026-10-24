$ErrorActionPreference = "Stop"

$BackendDir = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $BackendDir
$BinaryDir = Join-Path $ProjectRoot "src-tauri\binaries"
$Icon = Join-Path $ProjectRoot "src-tauri\icons\icon.ico"
$Version = (Get-Content (Join-Path $ProjectRoot "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version

New-Item -ItemType Directory -Force -Path $BinaryDir | Out-Null
Set-Location $BackendDir

# Three programs from one codebase, so Task Manager tells them apart: it lists
# a process by the description built into its file, not by what it's doing.
$programs = @(
    @{ Cmd = "helper";  Exe = "better-search-helper";  Description = "Better Search: Search helper" },
    @{ Cmd = "watcher"; Exe = "better-search-watcher"; Description = "Better Search: File watcher" },
    @{ Cmd = "indexer"; Exe = "better-search-indexer"; Description = "Better Search: Indexer" }
)

foreach ($p in $programs) {
    Write-Host "Building $($p.Exe)..." -ForegroundColor Cyan
    $dir = "./cmd/$($p.Cmd)"

    # Name, version and icon, as a resource "go build" links in (rsrc_*.syso,
    # generated here and not committed).
    Push-Location $dir
    go run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64 --out rsrc --manifest cli `
        --icon $Icon --product-name "Better Search" --file-description $p.Description `
        --product-version $Version --file-version $Version --original-filename "$($p.Exe).exe"
    if ($LASTEXITCODE -ne 0) { throw "go-winres failed for $($p.Exe)" }
    Pop-Location

    # -s -w: no symbol table or debug info (panics still print stack traces).
    # -H=windowsgui: a windowless program, so Windows doesn't start a console
    #   host (conhost.exe) for it. Its stdin/stdout are still the pipes Tauri
    #   hands it; run it from a terminal and its logs don't show.
    # -trimpath: no paths from this machine in the binary.
    $out = Join-Path $BinaryDir "$($p.Exe)-x86_64-pc-windows-msvc.exe"
    go build -trimpath -ldflags "-s -w -H=windowsgui" -o $out $dir
    if ($LASTEXITCODE -ne 0) { throw "go build failed for $($p.Exe)" }
}

Write-Host "Build complete: $BinaryDir" -ForegroundColor Green
