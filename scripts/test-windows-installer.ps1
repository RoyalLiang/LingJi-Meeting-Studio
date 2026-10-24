param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Output,
  [Parameter(Mandatory=$true)][string]$ProbeScript,
  [Parameter(Mandatory=$true)][string]$SourceRoot
)
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Installer verification requires disposable GitHub-hosted Windows CI'}
$ErrorActionPreference = 'Stop'
$installation = Join-Path $Root 'Installed App'
$smoke = Join-Path $Root 'package-smoke.json'
New-Item -ItemType Directory -Force $Root | Out-Null
$installed = $false
$uninstalled = $false
try {
  $setup = Start-Process -FilePath $Installer -ArgumentList "/S /D=$installation" -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
  $executable = Join-Path $installation 'tts-client.exe'
  foreach ($path in @($executable,(Join-Path $installation 'runtime\node.exe'),(Join-Path $installation 'client-backend\services\records\src\desktop-backend.mjs'))) {
    if (-not (Test-Path $path)) { throw "Installed resource missing: $path" }
  }
  $appBytes = [IO.File]::ReadAllBytes($executable)
  $pe = [BitConverter]::ToInt32($appBytes,0x3c)
  if ([BitConverter]::ToUInt16($appBytes,$pe+4) -ne 0x8664) { throw 'Installed application is not x64' }
  foreach ($resource in @('client-backend','runtime')) {
    $expectedRoot = Join-Path $SourceRoot "apps\desktop\src-tauri\resources\$resource"
    foreach ($file in Get-ChildItem $expectedRoot -File -Recurse) {
      $relative = $file.FullName.Substring($expectedRoot.Length).TrimStart('\')
      $actual = Join-Path (Join-Path $installation $resource) $relative
      if (-not (Test-Path $actual) -or (Get-FileHash $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $actual -Algorithm SHA256).Hash) { throw "Installed resource differs: $resource/$relative" }
    }
  }
  $installed = $true
  $previous = $env:NATIVE_CLIENT_EXECUTABLE
  try {
    $env:NATIVE_CLIENT_EXECUTABLE = $executable
    & node $ProbeScript $smoke
    if ($LASTEXITCODE -ne 0) { throw 'Installed production App lifecycle probe failed' }
  } finally { $env:NATIVE_CLIENT_EXECUTABLE = $previous }
  $uninstaller = Join-Path $installation 'uninstall.exe'
  if (-not (Test-Path $uninstaller)) { throw 'Uninstaller missing' }
  $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  if ($remove.ExitCode -ne 0) { throw "Uninstall failed: $($remove.ExitCode)" }
  for ($i=0; $i -lt 100 -and (Test-Path $executable); $i++) { Start-Sleep -Milliseconds 100 }
  if (Test-Path $executable) { throw 'Installed executable remains after uninstall' }
  $uninstalled = $true
  $evidence = @{installed=$installed;uninstalled=$uninstalled;resourcesVerified=$true;packageSmoke=$smoke;realAudioDevicesOpened=$false} | ConvertTo-Json
  [IO.File]::WriteAllText($Output,$evidence,(New-Object System.Text.UTF8Encoding($false)))
} finally {
  if ($installed -and -not $uninstalled) {
    $uninstaller = Join-Path $installation 'uninstall.exe'
    if (Test-Path $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null }
  }
}
