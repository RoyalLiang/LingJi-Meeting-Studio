param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$Root)
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
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
}
'@
New-Item -ItemType Directory -Force $Root | Out-Null
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
 throw "Installer page missing: $text"
}
function Click-Next {
 $button=[LingJiInstallerWindow]::GetDlgItem($script:handle,1)
 if($button -eq [IntPtr]::Zero){throw 'Installer next button missing'}
 [void][LingJiInstallerWindow]::SendMessage($button,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)
}
function Capture-Page([string]$name) {
 [void][LingJiInstallerWindow]::SetForegroundWindow($script:handle)
 Start-Sleep -Milliseconds 400
 $rectangle=New-Object LingJiInstallerWindow+Rect
 if(-not [LingJiInstallerWindow]::GetWindowRect($script:handle,[ref]$rectangle)){throw 'Installer rectangle unavailable'}
 $width=$rectangle.Right-$rectangle.Left;$height=$rectangle.Bottom-$rectangle.Top
 if($width -lt 600 -or $height -lt 400){throw "Installer size too small: $width x $height"}
 $bitmap=New-Object System.Drawing.Bitmap($width,$height)
 $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
 try {
  $dc=$graphics.GetHdc()
  try {if(-not [LingJiInstallerWindow]::PrintWindow($script:handle,$dc,2)){throw 'Installer PrintWindow failed'}}finally{$graphics.ReleaseHdc($dc)}
  $path=Join-Path $Root "$name.png"
  $bitmap.Save($path,[System.Drawing.Imaging.ImageFormat]::Png)
  $encoded=[Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
  if($encoded.Length -gt 60000){throw "Installer preview exceeds bounded annotation: $name"}
  Write-Output "::notice title=LingJi installer $name::$encoded"
 } finally {$graphics.Dispose();$bitmap.Dispose()}
}
try {
 Wait-Page '欢迎安装聆记'
 Capture-Page 'welcome'
 Click-Next
 Wait-Page '选择安装位置'
 Capture-Page 'directory'
 Click-Next
 Wait-Page '安装完成' 180
 Capture-Page 'finish'
 $rootElement=[System.Windows.Automation.AutomationElement]::FromHandle($script:handle)
 $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'立即启动聆记')
 $launch=$rootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
 if($null -eq $launch){throw 'Installer launch checkbox missing'}
 $toggle=$launch.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
 if($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On){$toggle.Toggle()}
 Click-Next
 if(-not $setup.WaitForExit(10000)){throw 'Installer did not finish'}
 if($setup.ExitCode -ne 0){throw 'Interactive installer failed'}
} finally {
 if(-not $setup.HasExited){$setup.Kill();$setup.WaitForExit()}
 $remove=Join-Path $install 'uninstall.exe'
 if(Test-Path $remove){$p=Start-Process -FilePath $remove -ArgumentList '/S' -Wait -PassThru;if($p.ExitCode -ne 0){throw 'Visual probe cleanup failed'}}
}
