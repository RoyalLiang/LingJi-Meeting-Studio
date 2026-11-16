param(
  [Parameter(Mandatory=$true)][string]$Metadata,
  [Parameter(Mandatory=$true)][string]$Output,
  [Parameter(Mandatory=$true)][string]$SourceRoot
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'MSIX install tests require disposable Windows CI' }
$receipt = Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
if ($receipt.signed -or $receipt.published -or -not $receipt.identity.name) { throw 'Expected an unsigned Store submission candidate' }
$package = Join-Path (Split-Path -Parent $Metadata) $receipt.artifact.name
$originalHash = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
if ($originalHash -ne $receipt.artifact.sha256) { throw 'Store candidate changed before installation test' }
if (Get-AppxPackage -Name $receipt.identity.name) { throw 'Refusing to replace an existing package' }
$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$signTool = Get-ChildItem "$sdk\*\x64\signtool.exe" | Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
if (-not $signTool) { throw 'Windows SDK SignTool was not found' }
$scratch = Join-Path (Join-Path $SourceRoot '.agent-runtime') ('lingji-msix-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$certificate = $null
$installed = $null
$primaryError = $null
$applicationProcessId = 0
$backendProcessId = 0
$contextProcessId = 0
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class LingjiActivationManager { }
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILingjiActivationManager {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string args, int options, out uint processId);
}
public static class LingjiMsixTest {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
  public static uint Activate(string id) {
    var manager = (ILingjiActivationManager)new LingjiActivationManager();
    try { uint processId; Marshal.ThrowExceptionForHR(manager.ActivateApplication(id, "", 0, out processId)); return processId; }
    finally { Marshal.FinalReleaseComObject(manager); }
  }
  public static string PackageName(uint processId) {
    var process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      uint length=0; int result=GetPackageFullName(process,ref length,null);
      if (result!=122) throw new Win32Exception(result);
      var name=new StringBuilder((int)length); result=GetPackageFullName(process,ref length,name);
      if (result!=0) throw new Win32Exception(result);
      return name.ToString();
    } finally { CloseHandle(process); }
  }
}
'@
try {
  $signed = Join-Path $scratch 'fixture.msix'
  Copy-Item -LiteralPath $package -Destination $signed
  $certificate = New-SelfSignedCertificate -Type Custom -Subject $receipt.identity.publisher -KeyUsage DigitalSignature -KeyExportPolicy NonExportable -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')
  $publicCertificate = Join-Path $scratch 'fixture.cer'
  Export-Certificate -Cert $certificate -FilePath $publicCertificate | Out-Null
  Import-Certificate -FilePath $publicCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
  & $signTool.FullName sign /fd SHA256 /sha1 $certificate.Thumbprint /s My $signed
  if ($LASTEXITCODE -ne 0) { throw "Fixture signing failed: $LASTEXITCODE" }
  Add-AppxPackage -Path $signed
  $installed = Get-AppxPackage -Name $receipt.identity.name
  if (-not $installed -or $installed.Version -ne $receipt.packageVersion) { throw 'Expected MSIX version was not installed' }
  $installedNode = Join-Path $installed.InstallLocation 'runtime/node.exe'
  $installedBackend = Join-Path $installed.InstallLocation 'client-backend'
  $applicationProcessId = [LingjiMsixTest]::Activate($installed.PackageFamilyName+'!App')
  if (-not $applicationProcessId) { throw 'Package activation returned no application process' }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    $application = Get-Process -Id $applicationProcessId -ErrorAction SilentlyContinue
    if (-not $application) { throw 'Packaged application exited during startup' }
    $backend = Get-CimInstance Win32_Process -Filter "ParentProcessId=$applicationProcessId" | Where-Object { $_.Name -eq 'node.exe' -and $_.ExecutablePath.StartsWith($installed.InstallLocation,[StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if ($backend -and $application.MainWindowHandle -ne 0) { $backendProcessId=$backend.ProcessId; break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $backendProcessId) { throw 'Packaged desktop window and bundled backend did not become ready' }
  $actualPackageName = [LingjiMsixTest]::PackageName($applicationProcessId)
  if ($actualPackageName -ne $installed.PackageFullName) { throw 'Activated process has the wrong package identity' }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    $webviewProcesses = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath)
    $webview = $webviewProcesses | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith((Join-Path $installed.InstallLocation 'webview2'),[StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if ($webview) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $webview) {
    Write-Host (ConvertTo-Json -InputObject $webviewProcesses -Compress)
    throw 'Packaged application did not use its bundled Fixed WebView2 runtime'
  }
  $webviewVersion = (Get-Item -LiteralPath $webview.ExecutablePath).VersionInfo.ProductVersion
  if ($webviewVersion -ne $receipt.webview.version) { throw 'Unexpected active WebView2 version' }
  if ([LingjiMsixTest]::PackageName($backendProcessId) -ne $installed.PackageFullName) { throw 'Normal application backend did not inherit its package identity' }
  $configPath = Join-Path $scratch 'backend-context.json'
  $started = Join-Path $scratch 'started.json'
  $proceed = Join-Path $scratch 'proceed'
  $result = Join-Path $scratch 'result.json'
  @{sourceRoot=$SourceRoot;backend=$installedBackend;started=$started;proceed=$proceed;result=$result;backendReport=(Join-Path $scratch 'backend.json');asrReport=(Join-Path $scratch 'asr.json')} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
  # This supplemental context test does not replace the ordinary AUMID activation above.
  $wrapper = Join-Path $PSScriptRoot 'test-msix-backend.mjs'
  Invoke-CommandInDesktopPackage -PackageFamilyName $installed.PackageFamilyName -AppId 'App' -Command $installedNode -Args ('"'+$wrapper+'" "'+$configPath+'"') -PreventBreakaway -ErrorAction Stop | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $started)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Packaged Node context did not start' }
    Start-Sleep -Milliseconds 200
  }
  $contextProcessId = [int](Get-Content -LiteralPath $started -Raw | ConvertFrom-Json).pid
  if ([LingjiMsixTest]::PackageName($contextProcessId) -ne $installed.PackageFullName) { throw 'Supplemental Node test lacks the actual package identity' }
  [IO.File]::WriteAllText($proceed,'verified')
  $deadline = [DateTime]::UtcNow.AddSeconds(420)
  while (-not (Test-Path -LiteralPath $result)) {
    if ([DateTime]::UtcNow -ge $deadline -or -not (Get-Process -Id $contextProcessId -ErrorAction SilentlyContinue)) {
      if (Test-Path -LiteralPath $result) { break }
      throw 'Packaged backend/model context test did not finish'
    }
    Start-Sleep -Milliseconds 250
  }
  $contextResult = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
  if (-not $contextResult.ok) { throw ('Packaged backend/model test failed: '+$contextResult.error) }
  @{installed=$true;activated=$true;windowCreated=$true;bundledBackendStarted=$true;readOnlyBackendVerified=$true;readOnlyModelInference=$true;packageIdentityVerified=$true;normalBackendPackageIdentityVerified=$true;supplementalNodeContextVerified=$true;sourceRevision=$receipt.sourceRevision;controllerSha=$env:GITHUB_SHA;fixedWebviewUsed=$true;webviewVersion=$webviewVersion;webviewExecutable=$webview.ExecutablePath;packageFullName=$actualPackageName;testSignature='temporary-self-signed-copy';submissionRemainsUnsigned=$true;realAudioDevicesVerified=$false;realProvidersVerified=$false} | ConvertTo-Json | Set-Content -LiteralPath $Output -Encoding utf8
} catch {
  $primaryError = $_
  throw
} finally {
  $cleanupErrors = [Collections.Generic.List[string]]::new()
  try {
    if ($installed) {
      foreach ($processId in @($applicationProcessId,$contextProcessId)) {
        if (-not $processId) { continue }
        $application = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($application -and $application.Path.StartsWith($installed.InstallLocation,[StringComparison]::OrdinalIgnoreCase)) {
          & taskkill.exe /PID $processId /T /F | Out-Null
        }
      }
    }
  } catch { $cleanupErrors.Add($_.Exception.Message) }
  try {
    if ($installed) { Remove-AppxPackage -Package $installed.PackageFullName }
  } catch { $cleanupErrors.Add($_.Exception.Message) }
  if ($certificate) {
    foreach ($entry in @(@{Path='Cert:\LocalMachine\TrustedPeople\'+$certificate.Thumbprint;DeleteKey=$false},@{Path='Cert:\CurrentUser\My\'+$certificate.Thumbprint;DeleteKey=$true})) {
      try {
        if (Test-Path -LiteralPath $entry.Path) { Remove-Item -LiteralPath $entry.Path -DeleteKey:$entry.DeleteKey -Force }
      } catch { $cleanupErrors.Add($_.Exception.Message) }
    }
  }
  try { Remove-Item -LiteralPath $scratch -Recurse -Force } catch { $cleanupErrors.Add($_.Exception.Message) }
  try {
    if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant() -ne $originalHash) { $cleanupErrors.Add('Install test changed Store submission package') }
  } catch { $cleanupErrors.Add($_.Exception.Message) }
  if ($cleanupErrors.Count) {
    $message = 'MSIX test cleanup failed: '+($cleanupErrors -join '; ')
    if ($primaryError) { Write-Warning $message } else { throw $message }
  }
}
