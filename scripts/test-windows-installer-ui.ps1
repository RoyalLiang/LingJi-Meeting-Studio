param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Screenshots,[switch]$WithoutModel,[string]$ProbeScript,[switch]$Upgrade)
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Installer verification requires disposable GitHub-hosted Windows CI'}
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class LingJiInstallerWindow {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  public delegate bool EnumWindowProc(IntPtr h,IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h,EnumWindowProc callback,IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int GetWindowTextW(IntPtr h,System.Text.StringBuilder text,int size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int GetClassNameW(IntPtr h,System.Text.StringBuilder text,int size);
  static string Text(IntPtr h) { var text=new System.Text.StringBuilder(512);GetWindowTextW(h,text,text.Capacity);return text.ToString(); }
  static string Class(IntPtr h) { var text=new System.Text.StringBuilder(64);GetClassNameW(h,text,text.Capacity);return text.ToString(); }
  public static IntPtr[] FindVisibleControls(IntPtr root,string[] names,bool staticOnly) {
    var matches=new System.Collections.Generic.List<IntPtr>();
    EnumChildWindows(root,(h,data)=>{if(IsWindowVisible(h)&&Array.IndexOf(names,Text(h))>=0&&(!staticOnly||Class(h).Equals("Static",StringComparison.OrdinalIgnoreCase)))matches.Add(h);return true;},IntPtr.Zero);
    return matches.ToArray();
  }
  [DllImport("user32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr CreateWindowExW(uint ex,string kind,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr data);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
  public static bool WithinClient(IntPtr root,IntPtr control) {
    Rect client,bounds;var origin=new Point();
    return GetClientRect(root,out client)&&ClientToScreen(root,ref origin)&&GetWindowRect(control,out bounds)
      &&bounds.Right>bounds.Left&&bounds.Bottom>bounds.Top
      &&bounds.Left>=origin.X+client.Left&&bounds.Top>=origin.Y+client.Top
      &&bounds.Right<=origin.X+client.Right&&bounds.Bottom<=origin.Y+client.Bottom;
  }
  public static void VerifyControlLookup() {
    var root=CreateWindowExW(0,"STATIC","lookup fixture",0x90000000u,-10000,-10000,300,160,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
    if(root==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      var label=CreateWindowExW(0,"STATIC","same caption",0x50000000u,10,10,120,24,root,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
      var button=CreateWindowExW(0,"BUTTON","same caption",0x50000000u,10,50,120,24,root,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
      var hidden=CreateWindowExW(0,"STATIC","same caption",0x40000000u,10,90,120,24,root,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
      if(label==IntPtr.Zero||button==IntPtr.Zero||hidden==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      var clipped=CreateWindowExW(0,"STATIC","clipped footer",0x50000000u,10,150,120,24,root,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
      if(clipped==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if(!WithinClient(root,label)||WithinClient(root,clipped))throw new Exception("Client bounds must reject clipped controls");
      var labels=FindVisibleControls(root,new[]{"same caption"},true);
      if(labels.Length!=1||labels[0]!=label||FindVisibleControls(root,new[]{"same caption"},false).Length!=2)throw new Exception("Native lookup must separate visible labels, buttons and hidden controls");
      Rect bounds;if(!GetWindowRect(labels[0],out bounds)||bounds.Right<=bounds.Left||bounds.Bottom<=bounds.Top)throw new Exception("Native label bounds missing");
    } finally {DestroyWindow(root);}
  }
  public static string VisibleControls(IntPtr root) {
    var rows=new System.Collections.Generic.List<string>();
    EnumChildWindows(root,(h,data)=>{var text=Text(h);if(IsWindowVisible(h)&&text.Length>0&&rows.Count<30)rows.Add(Class(h)+":"+text);return true;},IntPtr.Zero);
    return string.Join(" | ",rows);
  }
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref Point p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h,ref Point p);
 [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr h,Point p,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr h);
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
$background=$null;$setup=$null
$previousModels=@{};$previousModelTimes=@{};$changedResource=$null;$expectedChangedHash=$null
try {
if($Upgrade){
  $seed=Start-Process -FilePath $Installer -ArgumentList "/S /D=$install" -Wait -PassThru
  if($seed.ExitCode -ne 0){throw 'Upgrade fixture install failed'}
  $modelRoot=Join-Path $install 'client-backend/local-asr'
  foreach($file in Get-ChildItem -LiteralPath $modelRoot -File -Recurse){$previousModels[$file.FullName]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash}
  if($previousModels.Count -eq 0){throw 'Upgrade fixture has no model'}
  foreach($path in $previousModels.Keys){
    [IO.File]::SetLastWriteTimeUtc($path,[datetime]'2001-01-01T00:00:00Z')
    $previousModelTimes[$path]=[IO.File]::GetLastWriteTimeUtc($path).Ticks
  }
  $changedResource=Join-Path $install 'client-backend/services/records/src/config.mjs'
  $expectedChangedHash=(Get-FileHash -LiteralPath $changedResource -Algorithm SHA256).Hash
  [IO.File]::AppendAllText($changedResource,"`n// obsolete upgrade-fixture content`n")

  $installedKeys=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object {(Get-ItemProperty $_.PSPath).InstallLocation -eq ('"'+$install+'"')})
  if($installedKeys.Count -ne 1){throw 'Upgrade fixture registration missing or ambiguous'}
  # Exercise the real older-version branch, whose default would uninstall before copying.
  Set-ItemProperty -LiteralPath $installedKeys[0].PSPath -Name DisplayVersion -Value '0.0.0'
  # Keep the installed runtime mapped without recording or touching user data.
  $background=New-Object System.Diagnostics.Process
  $background.StartInfo.FileName=Join-Path $install 'runtime/node.exe'
  $background.StartInfo.Arguments='-e "process.stdin.resume()"'
  $background.StartInfo.UseShellExecute=$false
  $background.StartInfo.RedirectStandardInput=$true
  $background.StartInfo.CreateNoWindow=$true
  if(-not $background.Start()){throw 'Could not start installer occupancy fixture'}
  Start-Sleep -Milliseconds 300
  if($background.HasExited){throw 'Installer occupancy fixture exited early'}
  $silent=Start-Process -FilePath $Installer -ArgumentList "/S /D=$install" -Wait -PassThru
  if($silent.ExitCode -ne 2){throw 'Silent upgrade did not block the running backend'}
  if((Get-FileHash -LiteralPath $changedResource -Algorithm SHA256).Hash -eq $expectedChangedHash){throw 'Blocked silent upgrade overwrote installed resources'}
}
$setup=Start-Process -FilePath $Installer -ArgumentList "/D=$install" -PassThru
$script:handle=[IntPtr]::Zero
function Wait-Page([string]$text,[int]$seconds=30) {
 $names=@();$lastReadError=$null
 $pageClock=[System.Diagnostics.Stopwatch]::StartNew()
 while($pageClock.Elapsed.TotalSeconds -lt $seconds) {
  $setup.Refresh()
  if($setup.HasExited){throw "Installer exited before $text ($($setup.ExitCode))"}
  if($setup.MainWindowHandle -ne [IntPtr]::Zero){$script:handle=$setup.MainWindowHandle}
  if($script:handle -ne [IntPtr]::Zero){
   $names=@();$elements=@()
   try {
    $rootElement=[System.Windows.Automation.AutomationElement]::FromHandle($script:handle)
    $elements=$rootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $names=@($elements | ForEach-Object {$_.Current.Name})
   } catch {
    # A native window can be replaced between getting its handle and reading it.
    $lastReadError=$_.Exception.Message
    $names=@();$elements=@()
   }
   if($names -contains $text){return}
  }
  Start-Sleep -Milliseconds 500
 }
 try {Capture-Page 'unexpected'}catch{Write-Host ('::warning title=Installer capture::'+$_.Exception.Message)}
  # A page can finish while diagnostic capture brings the window forward.
  $setup.Refresh()
  if($setup.HasExited){throw "Installer exited before $text ($($setup.ExitCode))"}
  if($setup.MainWindowHandle -ne [IntPtr]::Zero){$script:handle=$setup.MainWindowHandle}
  try {
    $rootElement=[System.Windows.Automation.AutomationElement]::FromHandle($script:handle)
    $elements=$rootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $names=@($elements | ForEach-Object {$_.Current.Name})
    if($names -contains $text){return}
  }catch{$lastReadError=$_.Exception.Message}
  Write-Host ('::notice title=Installer last page::'+(($names | Where-Object {$_} | Select-Object -First 25) -join ' | '))
 if($lastReadError){Write-Host ('::notice title=Installer last UI read::'+$lastReadError)}
 throw "Installer page missing: $text"
}
function Wait-RunningPrompt {
 for($i=0;$i -lt 150;$i++){
  $setup.Refresh();if($setup.HasExited){throw 'Installer exited instead of offering retry'}
  $popup=[LingJiInstallerWindow]::GetLastActivePopup($script:handle)
  if($popup -ne [IntPtr]::Zero -and $popup -ne $script:handle){
   $dialog=[System.Windows.Automation.AutomationElement]::FromHandle($popup)
   $names=@($dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {$_.Current.Name})
   if($names | Where-Object {$_ -like '聆记仍在后台运行。*'}){return $popup}
  }
  Start-Sleep -Milliseconds 200
 }
 throw 'Running backend retry prompt missing'
}
function Click-Retry([IntPtr]$popup) {
 $retry=[LingJiInstallerWindow]::GetDlgItem($popup,4)
 if($retry -eq [IntPtr]::Zero -or -not [LingJiInstallerWindow]::PostMessage($retry,0x00f5,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Installer Retry action missing'}
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
function Assert-Separate([string[]]$leftNames,[string[]]$rightNames) {
  $left=@([LingJiInstallerWindow]::FindVisibleControls($script:handle,$leftNames,$true))
  $right=@([LingJiInstallerWindow]::FindVisibleControls($script:handle,$rightNames,$false))
  if($left.Count -ne 1 -or $right.Count -ne 1){throw ("Installer layout controls missing or ambiguous: left="+$left.Count+" ["+($leftNames -join '/')+"]; right="+$right.Count+" ["+($rightNames -join '/')+"]; visible="+[LingJiInstallerWindow]::VisibleControls($script:handle))}
  $a=New-Object LingJiInstallerWindow+Rect;$b=New-Object LingJiInstallerWindow+Rect
  if(-not [LingJiInstallerWindow]::GetWindowRect($left[0],[ref]$a) -or -not [LingJiInstallerWindow]::GetWindowRect($right[0],[ref]$b)){throw 'Installer control bounds unavailable'}
  if($a.Right -le $a.Left -or $a.Bottom -le $a.Top -or $b.Right -le $b.Left -or $b.Bottom -le $b.Top -or ($a.Left -lt $b.Right -and $b.Left -lt $a.Right -and $a.Top -lt $b.Bottom -and $b.Top -lt $a.Bottom)){throw ('Installer controls overlap: '+($leftNames -join '/')+' / '+($rightNames -join '/'))}
}
function Capture-Page([string]$name,[IntPtr]$target=[IntPtr]::Zero,[switch]$ThemedPrompt) {
 if($target -eq [IntPtr]::Zero){$target=$script:handle}
 [void][LingJiInstallerWindow]::SetForegroundWindow($target)
 Start-Sleep -Milliseconds 400
 $rectangle=New-Object LingJiInstallerWindow+Rect
 if(-not [LingJiInstallerWindow]::GetWindowRect($target,[ref]$rectangle)){throw 'Installer rectangle unavailable'}
 $width=$rectangle.Right-$rectangle.Left;$height=$rectangle.Bottom-$rectangle.Top
 if(($ThemedPrompt -and ($width -lt 500 -or $height -lt 240)) -or (-not $ThemedPrompt -and ($width -lt 600 -or $height -lt 400))){throw "Installer size too small: $width x $height"}
 $bitmap=New-Object System.Drawing.Bitmap($width,$height,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
 $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
 try {
  $captured=$false
  if([LingJiInstallerWindow]::GetForegroundWindow() -eq $target) {
   try {$graphics.CopyFromScreen($rectangle.Left,$rectangle.Top,0,0,$bitmap.Size);$captured=$true}catch{}
  }
  if(-not $captured) {
   $dc=$graphics.GetHdc()
   try {if(-not [LingJiInstallerWindow]::PrintWindow($target,$dc,2)){throw 'Installer PrintWindow failed'}}finally{$graphics.ReleaseHdc($dc)}
  }
  if($ThemedPrompt){
   if([LingJiInstallerWindow]::IsWindowEnabled($script:handle)){throw 'Retry prompt must block installer actions'}
   $client=New-Object LingJiInstallerWindow+Rect
   if(-not [LingJiInstallerWindow]::GetClientRect($target,[ref]$client)){throw 'Retry client bounds missing'}
   $sample=New-Object LingJiInstallerWindow+Point;$sample.X=8;$sample.Y=$client.Bottom-8
   if(-not [LingJiInstallerWindow]::ClientToScreen($target,[ref]$sample)){throw 'Retry pixel position missing'}
   $color=$bitmap.GetPixel($sample.X-$rectangle.Left,$sample.Y-$rectangle.Top)
   if($color.G -le $color.R -or $color.G-$color.B -lt 3){throw 'Retry dialog did not use the application green background'}
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
 Wait-Page '安装聆记'
 $initialWindow=$script:handle
 Wait-Page '安装本地 SenseVoice 离线转录模型（推荐）'
 if($WithoutModel){Uncheck-Checkbox '安装本地 SenseVoice 离线转录模型（推荐）'}
 Assert-Separate @('安装聆记') @('安装本地 SenseVoice 离线转录模型（推荐）')
Assert-Separate @('会议录音与智能纪要，随时开始。') @('安装位置')
Capture-Page 'welcome'
 Capture-Page 'settings'
 Click-Next
 if($Upgrade){
  $popup=Wait-RunningPrompt
  Capture-Page 'running-backend-retry' $popup -ThemedPrompt
  Click-Retry $popup
  Start-Sleep -Milliseconds 300
  $popup=Wait-RunningPrompt
  if((Get-FileHash -LiteralPath $changedResource -Algorithm SHA256).Hash -eq $expectedChangedHash){throw 'Busy retry overwrote installed resources'}
  $background.StandardInput.Close()
  if(-not $background.WaitForExit(10000)){throw 'Occupancy fixture failed to exit safely'}
  Click-Retry $popup
 }
 Start-Sleep -Milliseconds 200
 $progressRoot=[System.Windows.Automation.AutomationElement]::FromHandle($script:handle)
 $progressCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'让每一次讨论，都有回响。')
 if($null -ne $progressRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$progressCondition)){
  $footer=@([LingJiInstallerWindow]::FindVisibleControls($script:handle,@('本地记录，安心整理。'),$true))
  if($footer.Count -eq 1){
    $inside=[LingJiInstallerWindow]::WithinClient($script:handle,$footer[0])
    Capture-Page 'installing'
    if(-not $inside){throw 'Installer footer is clipped by the client bounds'}
  }else{Wait-Page '聆记已准备就绪' 5}
 }
 Wait-Page '聆记已准备就绪' 300
 Assert-Separate @('应用与本地转录模型已安装完成。','应用已安装完成。') @('✓  无需启动转录服务器，即可开始记录','请在设置中配置云端转录与纪要服务。')
Capture-Page 'finish'
 Uncheck-Checkbox '完成后启动聆记'

 Click-Next
 if(-not $setup.WaitForExit(10000)){throw 'Installer did not finish'}
 if($setup.ExitCode -ne 0){throw 'Interactive installer failed'}
 $model=Join-Path $install 'client-backend/local-asr/manifest.json'
 if($Upgrade){
  if($script:handle -ne $initialWindow){throw 'Upgrade replaced the installation window'}
  if((Get-FileHash -LiteralPath $changedResource -Algorithm SHA256).Hash -ne $expectedChangedHash){throw 'Upgrade failed to replace a changed backend resource'}
  foreach($path in $previousModels.Keys){
   if([IO.File]::GetLastWriteTimeUtc($path).Ticks -ne $previousModelTimes[$path]){throw 'Upgrade rewrote an unchanged model file'}
   if(-not (Test-Path -LiteralPath $path) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $previousModels[$path]){throw 'Upgrade opt-out removed or replaced an existing model file'}
  }
  [IO.File]::WriteAllText((Join-Path $Root 'upgrade-model-smoke.json'),(@{existingModelPreserved=$true;verifiedModelFiles=$previousModels.Count;olderVersionFixture=$true;unchangedModelsNotRewritten=$true;changedResourceUpdated=$true;singleInstallerWindow=$true;runningBackendRetry=$true;silentBusyBlocked=$true} | ConvertTo-Json))
 }elseif($WithoutModel){
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
 if($background -and -not $background.HasExited){$background.StandardInput.Close();if(-not $background.WaitForExit(5000)){$background.Kill();$background.WaitForExit()}}
 if($setup -and -not $setup.HasExited){$setup.Kill();$setup.WaitForExit()}
 $remove=Join-Path $install 'uninstall.exe'
 if(Test-Path $remove){$p=Start-Process -FilePath $remove -ArgumentList '/S' -Wait -PassThru;if($p.ExitCode -ne 0){throw 'Visual probe cleanup failed'}}
}
