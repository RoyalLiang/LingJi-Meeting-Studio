param(
  [Parameter(Mandatory=$true)][string]$Metadata,
  [Parameter(Mandatory=$true)][string]$Output
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
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('lingji-msix-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$certificate = $null
$installed = $null
$primaryError = $null
$applicationProcessId = 0
$backendProcessId = 0
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
  $sourceRoot = Split-Path -Parent $PSScriptRoot
  $installedNode = Join-Path $installed.InstallLocation 'runtime/node.exe'
  $installedBackend = Join-Path $installed.InstallLocation 'client-backend'
  $previousNode = $env:CLIENT_NODE_EXECUTABLE
  $previousEntry = $env:CLIENT_BACKEND_ENTRY
  try {
    $env:CLIENT_NODE_EXECUTABLE = $installedNode
    $env:CLIENT_BACKEND_ENTRY = Join-Path $installedBackend 'services/records/src/desktop-backend.mjs'
    & $installedNode (Join-Path $sourceRoot 'scripts/test-standalone-package.mjs') (Join-Path $scratch 'backend.json')
    if ($LASTEXITCODE -ne 0) { throw "Read-only MSIX backend test failed: $LASTEXITCODE" }
    & $installedNode (Join-Path $sourceRoot 'scripts/test-bundled-asr.mjs') $installedBackend (Join-Path $scratch 'asr.json')
    if ($LASTEXITCODE -ne 0) { throw "Read-only MSIX model test failed: $LASTEXITCODE" }
    $asr = Get-Content -LiteralPath (Join-Path $scratch 'asr.json') -Raw | ConvertFrom-Json
    if (-not $asr.nativeInference) { throw 'MSIX local model did not run native inference' }
  } finally { $env:CLIENT_NODE_EXECUTABLE=$previousNode; $env:CLIENT_BACKEND_ENTRY=$previousEntry }
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
  $webview = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith((Join-Path $installed.InstallLocation 'webview2'),[StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
  if (-not $webview) { throw 'Packaged application did not use its bundled Fixed WebView2 runtime' }
  $webviewVersion = (Get-Item -LiteralPath $webview.ExecutablePath).VersionInfo.ProductVersion
  if ($webviewVersion -ne $receipt.webview.version) { throw 'Unexpected active WebView2 version' }
  @{installed=$true;activated=$true;windowCreated=$true;bundledBackendStarted=$true;readOnlyBackendVerified=$true;readOnlyModelInference=$true;packageIdentityVerified=$true;fixedWebviewUsed=$true;webviewVersion=$webviewVersion;webviewExecutable=$webview.ExecutablePath;packageFullName=$actualPackageName;testSignature='temporary-self-signed-copy';submissionRemainsUnsigned=$true;realAudioDevicesVerified=$false;realProvidersVerified=$false} | ConvertTo-Json | Set-Content -LiteralPath $Output -Encoding utf8
} catch {
  $primaryError = $_
  throw
} finally {
  $cleanupErrors = [Collections.Generic.List[string]]::new()
  try {
    if ($installed -and $applicationProcessId) {
      $application = Get-Process -Id $applicationProcessId -ErrorAction SilentlyContinue
      if ($application -and $application.Path.StartsWith($installed.InstallLocation,[StringComparison]::OrdinalIgnoreCase)) {
        & taskkill.exe /PID $applicationProcessId /T /F | Out-Null
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
