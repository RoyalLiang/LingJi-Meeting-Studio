param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Screenshots,[switch]$WithoutModel,[string]$ProbeScript) 
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Installer verification requires disposable GitHub-hosted Windows CI'}
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class LingJiInstallerWindow {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h,ref Point p);
 [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr h,Point p,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h,uint m,IntPtr w,IntPtr l);
}
'@
New-Item -ItemType Directory -Force $Root | Out-Null
New-Item -ItemType Directory -Force $Screenshots | Out-Null
$install=Join-Path $Root 'Visual Install'
$setup=Start-Process -FilePath $Installer -ArgumentList "/D=$install" -PassThru
$script:handle=[IntPtr]::Zero
function Wait-Page([string]$text,[int]$seconds=30) {
 for($i=0;$i -lt $seconds*5;$i++) {
  $setup.Refresh()
  if($setup.HasExited){throw "Installer exited before $text ($($setup.ExitCode))"}
  if($setup.MainWindowHandle -ne [IntPtr]::Zero){$script:handle=$setup.MainWindowHandle}
  if($script:handle -ne [IntPtr]::Zero){
   $rootElement=[System.Windows.Automation.AutomationElement]::FromHandle($script:handle)
   $elements=$rootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
   foreach($element in $elements){if($element.Current.Name -eq $text){return}}
  }
  Start-Sleep -Milliseconds 200
 }
 $names=@($elements | ForEach-Object {$_.Current.Name} | Where-Object {$_} | Select-Object -First 25) -join ' | '
 Write-Host ('::notice title=Installer last page::'+$names)
 try {Capture-Page 'unexpected'}catch{Write-Host ('::warning title=Installer capture::'+$_.Exception.Message)}
 throw "Installer page missing: $text"
}
function Uncheck-Checkbox([string]$name) {
 $rootElement=[System.Windows.Automation.AutomationElement]::FromHandle($script:handle)
 $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$name)
 $control=[IntPtr]::Zero
 foreach($candidate in $rootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)){
  $h=[IntPtr]$candidate.Current.NativeWindowHandle
  if($h -ne [IntPtr]::Zero -and $candidate.Current.ClassName -eq 'Button' -and ([LingJiInstallerWindow]::GetWindowLongW($h,-16) -band 15) -eq 3){$control=$h;break}
 }
 if($control -eq [IntPtr]::Zero){throw "Installer native checkbox missing: $name"}
 if([LingJiInstallerWindow]::SendMessageW($control,0x00f0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -ne 1){throw "Installer checkbox must default to checked: $name"}
 if(-not [LingJiInstallerWindow]::PostMessage($control,0x00f5,[IntPtr]::Zero,[IntPtr]::Zero)){throw "Installer checkbox click failed: $name"}
 for($i=0;$i -lt 20;$i++){
  if([LingJiInstallerWindow]::SendMessageW($control,0x00f0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -eq 0){return}
  Start-Sleep -Milliseconds 100
 }
 throw "Installer checkbox did not uncheck: $name"
}
function Click-Next {
 $button=[LingJiInstallerWindow]::GetDlgItem($script:handle,1)
 if($button -eq [IntPtr]::Zero){throw 'Installer next button missing'}
 $bounds=New-Object LingJiInstallerWindow+Rect
 if(-not [LingJiInstallerWindow]::GetWindowRect($button,[ref]$bounds)){throw 'Installer button bounds missing'}
 $point=New-Object LingJiInstallerWindow+Point
 $point.X=[int](($bounds.Left+$bounds.Right)/2);$point.Y=[int](($bounds.Top+$bounds.Bottom)/2)
 [void][LingJiInstallerWindow]::ScreenToClient($script:handle,[ref]$point)
 if([LingJiInstallerWindow]::ChildWindowFromPointEx($script:handle,$point,0) -ne $button){throw 'Installer page covers the primary button'}
 if(-not [LingJiInstallerWindow]::PostMessage($script:handle,0x0111,[IntPtr]1,$button)){throw 'Installer next action could not be posted'}
}
function Capture-Page([string]$name) {
 [void][LingJiInstallerWindow]::SetForegroundWindow($script:handle)
 Start-Sleep -Milliseconds 400
 $rectangle=New-Object LingJiInstallerWindow+Rect
 if(-not [LingJiInstallerWindow]::GetWindowRect($script:handle,[ref]$rectangle)){throw 'Installer rectangle unavailable'}
 $width=$rectangle.Right-$rectangle.Left;$height=$rectangle.Bottom-$rectangle.Top
 if($width -lt 600 -or $height -lt 400){throw "Installer size too small: $width x $height"}
 $bitmap=New-Object System.Drawing.Bitmap($width,$height,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
 $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
 try {
  $captured=$false
  if([LingJiInstallerWindow]::GetForegroundWindow() -eq $script:handle) {
   try {$graphics.CopyFromScreen($rectangle.Left,$rectangle.Top,0,0,$bitmap.Size);$captured=$true}catch{}
  }
  if(-not $captured) {
   $dc=$graphics.GetHdc()
   try {if(-not [LingJiInstallerWindow]::PrintWindow($script:handle,$dc,2)){throw 'Installer PrintWindow failed'}}finally{$graphics.ReleaseHdc($dc)}
  }
  $path=Join-Path $Screenshots "$name.jpg"
  $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'}
  $bitmap.Save((Join-Path $Screenshots "$name.png"),[System.Drawing.Imaging.ImageFormat]::Png)
  $data=$null
  foreach($quality in @(65,55,45,35,25,15)) {
    $parameters=[System.Drawing.Imaging.EncoderParameters]::new(1)
    $buffer=[System.IO.MemoryStream]::new()
    try {
      $parameters.Param[0]=[System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality,[long]$quality)
      $bitmap.Save($buffer,$codec,$parameters)
      $data=$buffer.ToArray()
    }finally{$buffer.Dispose();$parameters.Dispose()}
    if($data.Length -le 28000){break}
  }
  if($data.Length -gt 28000){throw 'Diagnostic screenshot remains too large; full PNG retained'}
  [IO.File]::WriteAllBytes($path,$data)
  Write-Host "Saved installer screenshot: $name"

 } finally {$graphics.Dispose();$bitmap.Dispose()}
}
try {
 Wait-Page '安装聆记'
 Wait-Page '安装本地 SenseVoice 离线转录模型（推荐）'
 if($WithoutModel){Uncheck-Checkbox '安装本地 SenseVoice 离线转录模型（推荐）'}
 Capture-Page 'welcome'
 Capture-Page 'settings'
 Click-Next
 Start-Sleep -Milliseconds 200
 $progressRoot=[System.Windows.Automation.AutomationElement]::FromHandle($script:handle)
 $progressCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'正在安装聆记')
 if($null -ne $progressRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$progressCondition)){Capture-Page 'installing'}
 Wait-Page '聆记已准备就绪' 180
 Capture-Page 'finish'
 Uncheck-Checkbox '完成后启动聆记'

 Click-Next
 if(-not $setup.WaitForExit(10000)){throw 'Installer did not finish'}
 if($setup.ExitCode -ne 0){throw 'Interactive installer failed'}
 $model=Join-Path $install 'client-backend/local-asr/manifest.json'
 if($WithoutModel){
  if(Test-Path $model){throw 'Opt-out still installed local model assets'}
  $modelRoot=Split-Path $model -Parent
  if((Test-Path $modelRoot) -and (Get-ChildItem -LiteralPath $modelRoot -File -Recurse | Select-Object -First 1)){throw 'Opt-out copied partial model files'}
  if($ProbeScript){
   $previous=$env:NATIVE_CLIENT_EXECUTABLE;$previousMode=$env:TTS_VERIFY_BUNDLED_ASR
   try{
    $env:NATIVE_CLIENT_EXECUTABLE=Join-Path $install 'tts-client.exe';$env:TTS_VERIFY_BUNDLED_ASR='0'
    & node $ProbeScript (Join-Path $Root 'cloud-only-smoke.json')
    if($LASTEXITCODE -ne 0){throw 'Cloud-only installed App probe failed'}
   }finally{$env:NATIVE_CLIENT_EXECUTABLE=$previous;$env:TTS_VERIFY_BUNDLED_ASR=$previousMode}
  }
 }elseif(-not (Test-Path $model)){throw 'Default installation omitted the local model'}

 } catch {
 Write-Host ('::error title=Native installer UI::'+$_.Exception.Message.Replace('%','%25').Replace("`r",'%0D').Replace("`n",'%0A'))
 throw
} finally {
 if(-not $setup.HasExited){$setup.Kill();$setup.WaitForExit()}
 $remove=Join-Path $install 'uninstall.exe'
 if(Test-Path $remove){$p=Start-Process -FilePath $remove -ArgumentList '/S' -Wait -PassThru;if($p.ExitCode -ne 0){throw 'Visual probe cleanup failed'}}
}
