param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Screenshots)
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
function Click-Next {
 $button=[LingJiInstallerWindow]::GetDlgItem($script:handle,1)
 if($button -eq [IntPtr]::Zero){throw 'Installer next button missing'}
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
  $parameters=[System.Drawing.Imaging.EncoderParameters]::new(1)
  try {
   $parameters.Param[0]=[System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality,[long]65)
   $bitmap.Save($path,$codec,$parameters)
  }finally {$parameters.Dispose()}
  Write-Host "Saved installer screenshot: $name"

 } finally {$graphics.Dispose();$bitmap.Dispose()}
}
try {
 Wait-Page '欢迎安装聆记'
 Capture-Page 'welcome'
 Click-Next
 Wait-Page '选择安装位置'
 Capture-Page 'directory'
 Click-Next
 Start-Sleep -Milliseconds 200
 $progressRoot=[System.Windows.Automation.AutomationElement]::FromHandle($script:handle)
 $progressCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'正在安装聆记')
 if($null -ne $progressRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$progressCondition)){Capture-Page 'installing'}
 Wait-Page '安装完成' 180
 Capture-Page 'finish'
 $rootElement=[System.Windows.Automation.AutomationElement]::FromHandle($script:handle)
 $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'立即启动聆记')
 # The dialog proxy can share its first control's accessible name. Select a
 # native BS_AUTOCHECKBOX handle, then verify the real click by reading state.
 $launchHandle=[IntPtr]::Zero
 foreach($candidate in $rootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)){
  $candidateHandle=[IntPtr]$candidate.Current.NativeWindowHandle
  if($candidateHandle -ne [IntPtr]::Zero -and $candidate.Current.ClassName -eq 'Button' -and ([LingJiInstallerWindow]::GetWindowLongW($candidateHandle,-16) -band 15) -eq 3){$launchHandle=$candidateHandle;break}
 }
 if($launchHandle -eq [IntPtr]::Zero){throw 'Installer native launch checkbox missing'}
 $checked=[LingJiInstallerWindow]::SendMessageW($launchHandle,0x00f0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32()
 if($checked -eq 1){
  if(-not [LingJiInstallerWindow]::PostMessage($launchHandle,0x00f5,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Installer checkbox click could not be posted'}
  for($i=0;$i -lt 20;$i++){
   if([LingJiInstallerWindow]::SendMessageW($launchHandle,0x00f0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -eq 0){break}
   Start-Sleep -Milliseconds 100
  }
 }
 if([LingJiInstallerWindow]::SendMessageW($launchHandle,0x00f0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -ne 0){throw 'Installer launch checkbox did not uncheck'}

 Click-Next
 if(-not $setup.WaitForExit(10000)){throw 'Installer did not finish'}
 if($setup.ExitCode -ne 0){throw 'Interactive installer failed'}
} finally {
 if(-not $setup.HasExited){$setup.Kill();$setup.WaitForExit()}
 $remove=Join-Path $install 'uninstall.exe'
 if(Test-Path $remove){$p=Start-Process -FilePath $remove -ArgumentList '/S' -Wait -PassThru;if($p.ExitCode -ne 0){throw 'Visual probe cleanup failed'}}
}
