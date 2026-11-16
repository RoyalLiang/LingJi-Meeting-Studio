param(
  [Parameter(Mandatory=$true)][string]$Metadata,
  [Parameter(Mandatory=$true)][int]$ApplicationProcessId,
  [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:TTS_MSIX_WINDOW_DIAGNOSTICS -ne 'authorized-scoped-app-window') { throw 'Scoped capture requires explicit authorization and disposable hosted CI' }
Add-Type -Path (Join-Path $PSScriptRoot 'msix-test-native.cs')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
$receipt=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
$installed=Get-AppxPackage -Name $receipt.identity.name
$application=Get-Process -Id $ApplicationProcessId
if (-not $installed -or $installed.Version -ne $receipt.packageVersion -or $application.Path -ne (Join-Path $installed.InstallLocation 'tts-client.exe') -or [LingjiMsixTest]::PackageName($ApplicationProcessId) -ne $installed.PackageFullName) { throw 'Capture target package/process mismatch' }
$handle=$application.MainWindowHandle
[uint32]$ownerProcessId=0
[void][LingjiMsixTest]::GetWindowThreadProcessId($handle,[ref]$ownerProcessId)
if ($ownerProcessId -ne $ApplicationProcessId -or [LingjiMsixTest]::WindowClass($handle) -ne 'Tauri Window') { throw 'Capture target window mismatch' }
$window=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($window.Current.ProcessId -ne $ApplicationProcessId) { throw 'Accessibility target mismatch' }
$names=@($window.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ProcessId -eq $ApplicationProcessId } | Select-Object -First 60 | ForEach-Object { $name=$_.Current.Name; $name.Substring(0,[Math]::Min(512,$name.Length)) })
@{processId=$ApplicationProcessId;packageFullName=$installed.PackageFullName;windowText=$names} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath ($Output+'.json') -Encoding utf8
$bounds=[LingjiMsixTest+Rect]::new()
if (-not [LingjiMsixTest]::GetWindowRect($handle,[ref]$bounds)) { throw 'Window bounds unavailable' }
$width=$bounds.Right-$bounds.Left; $height=$bounds.Bottom-$bounds.Top
if ($width -le 0 -or $height -le 0 -or $width -gt 4096 -or $height -gt 2160) { throw 'Unexpected target window bounds' }
$bitmap=[System.Drawing.Bitmap]::new($width,$height)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
$dc=$graphics.GetHdc()
try {
  [void][LingjiMsixTest]::GetWindowThreadProcessId($handle,[ref]$ownerProcessId)
  if ($ownerProcessId -ne $ApplicationProcessId -or [LingjiMsixTest]::PackageName($ApplicationProcessId) -ne $installed.PackageFullName) { throw 'Capture target changed before rendering' }
  if (-not [LingjiMsixTest]::PrintWindow($handle,$dc,2)) { throw 'Target-only PrintWindow failed' }
} finally { $graphics.ReleaseHdc($dc) }
try { $bitmap.Save($Output+'.jpg',[System.Drawing.Imaging.ImageFormat]::Jpeg) }
finally { $graphics.Dispose(); $bitmap.Dispose() }
