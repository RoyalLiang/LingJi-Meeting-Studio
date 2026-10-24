param([string]$Root = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$source = Join-Path $Root 'apps/desktop/src-tauri/installer/native-ui'
$build = Join-Path $Root '.agent-runtime/installer-theme'
$output = Join-Path $Root 'apps/desktop/src-tauri/installer/generated'
& cmake -S $source -B $build -A Win32
if ($LASTEXITCODE -ne 0) { throw 'Installer UI configuration failed' }
& cmake --build $build --config Release
if ($LASTEXITCODE -ne 0) { throw 'Installer UI compilation failed' }
New-Item -ItemType Directory -Force $output | Out-Null
Copy-Item (Join-Path $build 'Release/lingji-ui.dll') (Join-Path $output 'lingji-ui.dll') -Force
