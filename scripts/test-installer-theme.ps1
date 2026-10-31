param([string]$Root = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Use disposable Windows CI for this UI-only harness'}
$alias=Join-Path $env:RUNNER_TEMP ('lingji-theme-alias-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Junction -Path $alias -Target $Root | Out-Null
try {
  $dll=Join-Path $Root 'apps/desktop/src-tauri/installer/generated/lingji-ui.dll'
  if(Test-Path $dll){Remove-Item $dll -Force}
  & node (Join-Path $alias 'scripts/prepare-installer-theme.mjs')
  if($LASTEXITCODE -ne 0 -or -not(Test-Path $dll)){throw 'Aliased installer entry did not prepare native resources'}
} finally { if(Test-Path $alias){[System.IO.Directory]::Delete($alias)} }
if($LASTEXITCODE -ne 0){throw 'Native painter build failed'}
$entryRoot=Join-Path $env:TEMP ('LingJi entry alias '+[guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Force (Join-Path $entryRoot 'scripts'),(Join-Path $entryRoot 'apps/desktop/src-tauri/resources/client-backend') | Out-Null
  Copy-Item (Join-Path $Root 'scripts/prepare-installer-theme.mjs') (Join-Path $entryRoot 'scripts/prepare-installer-theme.mjs')
  Set-Content -LiteralPath (Join-Path $entryRoot 'scripts/build-installer-theme.ps1') -Value 'Set-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) "entry-ran") -Value "prepared"'
  Set-Content -LiteralPath (Join-Path $entryRoot 'apps/desktop/src-tauri/resources/client-backend/fixture.txt') -Value 'fixture'
  $shortRoot=(& cmd.exe /d /c "for %I in (`"$entryRoot`") do @echo %~sI").Trim()
  if($shortRoot -notmatch '~'){throw '8.3 entry fixture did not resolve a short path'}
  & node (Join-Path $shortRoot 'scripts/prepare-installer-theme.mjs')
  if($LASTEXITCODE -ne 0 -or -not(Test-Path (Join-Path $entryRoot 'entry-ran')) -or -not(Test-Path (Join-Path $entryRoot 'apps/desktop/src-tauri/installer/generated/resource-hashes.nsh'))){throw '8.3 entry did not generate hashes and invoke the build'}
} finally { if(Test-Path $entryRoot){Remove-Item -LiteralPath $entryRoot -Recurse -Force} }
$compiler='C:\Program Files (x86)\NSIS\makensis.exe'
if(-not (Test-Path $compiler)){
  & choco install nsis --version=3.11 --yes --no-progress
  if($LASTEXITCODE -ne 0){throw 'NSIS setup failed'}
}
$stage=Join-Path $Root '.agent-runtime/installer-theme-harness'
New-Item -ItemType Directory -Force $stage | Out-Null
$theme=(Join-Path $Root 'apps/desktop/src-tauri/installer/lingji-theme.nsh')
$source=@'
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
Name "聆记安装器界面验证"
OutFile "theme-harness.exe"
InstallDir "$TEMP\LingJiInstallerTheme"
RequestExecutionLevel user
!include "THEME_PATH"
Page custom LingJiWelcome LingJiDirectoryLeave
!define MUI_PAGE_CUSTOMFUNCTION_SHOW LingJiProgressShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE LingJiProgressLeave
!insertmacro MUI_PAGE_INSTFILES
Page custom LingJiFinish LingJiFinishLeave
!insertmacro MUI_LANGUAGE "SimpChinese"
Function SkipIfPassive
  IfSilent 0 +2
  Abort
FunctionEnd
Function CreateOrUpdateDesktopShortcut
FunctionEnd
Function RunMainBinary
FunctionEnd
Section
  SetOutPath $INSTDIR
  CreateDirectory "$INSTDIR\client-backend\local-asr"
  !insertmacro LingJiResource "MODEL_FILE" "client-backend\local-asr\manifest.json"
  !insertmacro LingJiResource "MODEL_FILE" "required-app-resource.txt"
  Sleep 2000
SectionEnd
'@
[IO.File]::WriteAllText((Join-Path $stage 'theme-harness.nsi'),$source.Replace('THEME_PATH',$theme).Replace('MODEL_FILE',(Join-Path $stage 'model.json')),(New-Object System.Text.UTF8Encoding($true)))
[IO.File]::WriteAllText((Join-Path $stage 'model.json'),'{}')
Push-Location $stage
try{& $compiler /V3 theme-harness.nsi;if($LASTEXITCODE -ne 0){throw 'NSIS UI harness compile failed'}}finally{Pop-Location}
& pwsh -NoProfile -File (Join-Path $Root 'scripts/test-windows-installer-ui.ps1') -Installer (Join-Path $stage 'theme-harness.exe') -Root (Join-Path $stage 'probe') -Screenshots (Join-Path $Root '.agent-runtime/installer-ui')

if($LASTEXITCODE -ne 0){throw 'Default model UI probe failed'}
& pwsh -NoProfile -File (Join-Path $Root 'scripts/test-windows-installer-ui.ps1') -Installer (Join-Path $stage 'theme-harness.exe') -Root (Join-Path $stage 'cloud-probe') -Screenshots (Join-Path $Root '.agent-runtime/installer-ui-cloud') -WithoutModel
if($LASTEXITCODE -ne 0){throw 'Cloud-only UI probe failed'}

foreach($case in @('probe','cloud-probe')){
 if(-not (Test-Path (Join-Path $stage "$case/Visual Install/required-app-resource.txt"))){throw 'Model opt-out skipped a required application resource'}
}
