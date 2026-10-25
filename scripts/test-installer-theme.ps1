param([string]$Root = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Use disposable Windows CI for this UI-only harness'}
& node (Join-Path $Root 'scripts/prepare-installer-theme.mjs')
if($LASTEXITCODE -ne 0){throw 'Native painter build failed'}
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
