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
Add-Type -Path (Join-Path $PSScriptRoot 'msix-test-native.cs')
try {
  $signed = Join-Path $scratch 'fixture.msix'
  Copy-Item -LiteralPath $package -Destination $signed
  $certificate = New-SelfSignedCertificate -Type Custom -Subject $receipt.identity.publisher -KeyUsage DigitalSignature -KeyExportPolicy NonExportable -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')
  $publicCertificate = Join-Path $scratch 'fixture.cer'
  Export-Certificate -Cert $certificate -FilePath $publicCertificate | Out-Null
  Import-Certificate -FilePath $publicCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
  & $signTool.FullName sign /fd SHA256 /sha1 $certificate.Thumbprint /s My $signed
  if ($LASTEXITCODE -ne 0) { throw "Fixture signing failed: $LASTEXITCODE" }
  Add-Type -AssemblyName System.IO.Compression.ZipFile
  $signedArchive=[IO.Compression.ZipFile]::OpenRead($signed)
  try { $signedCatalogPresent=$null -ne $signedArchive.GetEntry('AppxMetadata/CodeIntegrity.cat') } finally { $signedArchive.Dispose() }
  Add-AppxPackage -Path $signed
  $installed = Get-AppxPackage -Name $receipt.identity.name
  if (-not $installed -or $installed.Version -ne $receipt.packageVersion) { throw 'Expected MSIX version was not installed' }
  $installedNode = Join-Path $installed.InstallLocation 'runtime/node.exe'
  $installedBackend = Join-Path $installed.InstallLocation 'client-backend'
  $activationTime=[DateTime]::UtcNow
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
  if ([LingjiMsixTest]::PackageName($backendProcessId) -ne $installed.PackageFullName) { throw 'Normal application backend did not inherit its package identity' }
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
  try {
    $application = Get-Process -Id $applicationProcessId -ErrorAction SilentlyContinue
    $modulePaths = @()
    if ($application -and $application.Path.StartsWith($installed.InstallLocation,[StringComparison]::OrdinalIgnoreCase)) {
      $modulePaths = @($application.Modules | ForEach-Object { $_.FileName })
    }
    $webProcesses = @(Get-Process | Where-Object { $_.ProcessName -match '^(msedge|msedgewebview2|WebViewHost)$' } | Select-Object Id,ProcessName,Path)
    $diagnostics = @{signedCatalogPresent=$signedCatalogPresent;errorCode=$primaryError.Exception.HResult;applicationProcessId=$applicationProcessId;applicationRunning=[bool]$application;windowClass=if($application){[LingjiMsixTest]::WindowClass($application.MainWindowHandle)}else{''};applicationModules=$modulePaths;webProcesses=$webProcesses;webviewProcesses=$webviewProcesses} | ConvertTo-Json -Depth 4
    $diagnostics | Set-Content -LiteralPath ($Output+'.diagnostics.json') -Encoding utf8
    Write-Host $diagnostics
  } catch { Write-Warning ('MSIX failure diagnostics unavailable: '+$_.Exception.Message) }
  if ($env:TTS_MSIX_WINDOW_DIAGNOSTICS -eq 'authorized-scoped-app-window' -and $applicationProcessId) {
    try {
      $captureHelper=Join-Path $PSScriptRoot 'capture-msix-window.ps1'
      $arguments=@('-NoProfile','-NonInteractive','-STA','-File',('"'+$captureHelper+'"'),'-Metadata',('"'+(Resolve-Path $Metadata).Path+'"'),'-ApplicationProcessId',$applicationProcessId,'-Output',('"'+[IO.Path]::GetFullPath($Output)+'.window"'))
      $capture=Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput ($Output+'.capture-stdout.txt') -RedirectStandardError ($Output+'.capture-stderr.txt')
      if (-not $capture.WaitForExit(15000)) { $capture.Kill($true); [void]$capture.WaitForExit(2000); Write-Warning 'Scoped window diagnostics timed out' }
      elseif ($capture.ExitCode -ne 0) { Write-Warning ('Scoped window diagnostics failed: '+$capture.ExitCode) }
    } catch { Write-Warning ('Scoped window diagnostics unavailable: '+$_.Exception.Message) }
  }
  if ($env:TTS_MSIX_CONTEXT_PROBE -and $installed) {
    $probeProcessId=0
    try {
      $probe=$env:TTS_MSIX_CONTEXT_PROBE
      $probeOutput=[IO.Path]::GetFullPath($Output)+'.webview-probe.json'
      Invoke-CommandInDesktopPackage -PackageFamilyName $installed.PackageFamilyName -AppId 'App' -Command $probe -Args ('"'+(Join-Path $installed.InstallLocation 'webview2')+'" "'+$probeOutput+'" "'+$installed.PackageFullName+'"') -ErrorAction Stop | Out-Null
      $deadline=[DateTime]::UtcNow.AddSeconds(60)
      while (-not (Test-Path -LiteralPath $probeOutput)) {
        if (Test-Path -LiteralPath ($probeOutput+'.started')) { $probeProcessId=[int](Get-Content -LiteralPath ($probeOutput+'.started') -Raw) }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'SDK WebView context diagnostic timed out' }
        Start-Sleep -Milliseconds 200
      }
      if (-not $probeProcessId -and (Test-Path -LiteralPath ($probeOutput+'.started'))) { $probeProcessId=[int](Get-Content -LiteralPath ($probeOutput+'.started') -Raw) }
      Write-Host (Get-Content -LiteralPath $probeOutput -Raw)
      foreach ($mode in @('unpackaged','unpackaged-copy')) {
        $runtime=Join-Path $installed.InstallLocation 'webview2'
        if ($mode -eq 'unpackaged-copy') {
          $copy=Join-Path (Split-Path -Parent $probe) 'runtime-copy'
          if (Test-Path -LiteralPath $copy) { throw 'Refusing existing runtime copy' }
          Copy-Item -LiteralPath $runtime -Destination $copy -Recurse -Force
          $originalFiles=@(Get-ChildItem -LiteralPath $runtime -File -Recurse -Force)
          $copiedFiles=@(Get-ChildItem -LiteralPath $copy -File -Recurse -Force)
          if ($originalFiles.Count -ne $copiedFiles.Count) { throw 'Runtime copy file count changed' }
          foreach ($file in $originalFiles) {
            $relative=[IO.Path]::GetRelativePath($runtime,$file.FullName)
            if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $copy $relative) -Algorithm SHA256).Hash) { throw 'Runtime copy hash changed' }
          }
          $runtime=$copy
          Write-Host ('Byte-identical runtime copy verified: '+$copiedFiles.Count+' files')
        }
        $unpackagedOutput=[IO.Path]::GetFullPath($Output)+'.webview-'+$mode+'-probe.json'
        $unpackaged=$null
        try {
          $arguments=@(('"'+$runtime+'"'),('"'+$unpackagedOutput+'"'),('"'+$installed.PackageFullName+'"'),$mode)
          $unpackaged=Start-Process -FilePath $probe -ArgumentList $arguments -WindowStyle Hidden -PassThru
          $unpackagedStart=$unpackaged.StartTime
          if (-not $unpackaged.WaitForExit(60000)) { throw 'Unpackaged SDK WebView probe timed out' }
          if ($unpackaged.ExitCode -ne 0) { throw ('Unpackaged SDK WebView probe exited '+$unpackaged.ExitCode) }
          Write-Host (Get-Content -LiteralPath $unpackagedOutput -Raw)
        } finally {
          if ($unpackaged) {
            $remaining=Get-Process -Id $unpackaged.Id -ErrorAction SilentlyContinue
            if ($remaining -and $remaining.Path -eq $probe -and $remaining.StartTime -eq $unpackagedStart) { & taskkill.exe /PID $remaining.Id /T /F | Out-Null }
          }
        }
      }
    } catch { Write-Warning ('SDK WebView context diagnostic unavailable: '+$_.Exception.Message) }
    finally {
      try {
        if ($probeProcessId) {
          $process=Get-Process -Id $probeProcessId -ErrorAction SilentlyContinue
          if ($process -and $process.Path -eq $probe -and [LingjiMsixTest]::PackageName($probeProcessId) -eq $installed.PackageFullName) { & taskkill.exe /PID $probeProcessId /T /F | Out-Null }
        }
      } catch { Write-Warning ('SDK probe cleanup unavailable: '+$_.Exception.Message) }
    }
  }
  if ($env:TTS_MSIX_CONTEXT_PROBE -and $installed -and $activationTime) {
    try {
      $roots=@($installed.InstallLocation.TrimEnd('\')+'\')
      $deviceAliasAvailable=$false
      try { $roots+=([LingjiMsixTest]::DevicePath($installed.InstallLocation).TrimEnd('\')+'\'); $deviceAliasAvailable=$true } catch { }
      if ($installed.InstallLocation.StartsWith($env:SystemDrive+'\',[StringComparison]::OrdinalIgnoreCase)) { $roots+=('%OSDRIVE%'+$installed.InstallLocation.Substring(2).TrimEnd('\')+'\') }
      Add-Type -AssemblyName System.Diagnostics.EventLog
      $selector=[System.Diagnostics.Eventing.Reader.EventLogPropertySelector]::new([string[]]@("Event/EventData/Data[@Name='FileName']","Event/EventData/Data[@Name='FileNameBuffer']","Event/EventData/Data[@Name='ProcessName']","Event/EventData/Data[@Name='ProcessNameBuffer']","Event/EventData/Data[@Name='Status']",'Event/UserData/RuleAndFileData/FilePath','Event/UserData/RuleAndFileData/RuleId'))
      $reports=@()
      try {
        foreach ($policy in @(@{provider='Microsoft-Windows-CodeIntegrity';log='Microsoft-Windows-CodeIntegrity/Operational';ids=@(3033,3076,3077)},@{provider='Microsoft-Windows-AppLocker';log='Microsoft-Windows-AppLocker/EXE and DLL';ids=@(8003,8004)})) {
          $rows=@(); $queryStatus='ok'; $queryError=$null; $events=@()
          try {
            $events=@(Get-WinEvent -FilterHashtable @{LogName=$policy.log;ProviderName=$policy.provider;Id=$policy.ids;StartTime=$activationTime;EndTime=[DateTime]::UtcNow} -ErrorAction Stop)
            foreach ($event in $events) {
              $value=$event.GetPropertyValues($selector)
              $file=@($value[0],$value[1],$value[5]) | Where-Object { $_ -is [string] -and $_ } | Select-Object -First 1
              $process=@($value[2],$value[3]) | Where-Object { $_ -is [string] -and $_ } | Select-Object -First 1
              $owned=$false
              foreach ($root in $roots) { if (($file -and $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or ($process -and $process.StartsWith($root,[StringComparison]::OrdinalIgnoreCase))) { $owned=$true; break } }
              if (-not $owned) { continue }
              $basename=[IO.Path]::GetFileName([string]$file)
              if ($basename -notmatch '^[A-Za-z0-9_.-]{1,128}\.(exe|dll)$') { $basename=$null }
              $ruleId=$null; $guid=[guid]::Empty
              if ($value[6] -and [guid]::TryParse([string]$value[6],[ref]$guid)) { $ruleId=$guid.ToString() }
              $status=$null
              if ($null -ne $value[4]) { try { $status=if ([string]$value[4] -match '^0x[0-9a-f]+$') { [Convert]::ToUInt32(([string]$value[4]).Substring(2),16) } else { [long]$value[4] -band [long]4294967295 } } catch { } }
              $rows+=@{eventId=[int]$event.Id;time=$event.TimeCreated.ToUniversalTime().ToString('O');basename=$basename;ruleId=$ruleId;status=$status}
              if ($rows.Count -ge 50) { break }
            }
          } catch {
            $queryStatus=if ($_.FullyQualifiedErrorId.StartsWith('NoMatchingEventsFound')) { 'empty-log-interval' } else { 'query-unavailable' }
            $queryError=$_.Exception.HResult
          } finally { foreach ($event in $events) { $event.Dispose() } }
          $reports+=@{provider=$policy.provider;queryStatus=$queryStatus;queryError=$queryError;events=$rows}
        }
      } finally { $selector.Dispose() }
      $policyReport=@{deviceAliasAvailable=$deviceAliasAvailable;providers=$reports} | ConvertTo-Json -Depth 6
      Set-Content -LiteralPath ($Output+'.policy-events.json') -Value $policyReport -Encoding utf8
      Write-Host $policyReport
    } catch { Write-Warning ('Scoped policy metadata unavailable: HRESULT '+$_.Exception.HResult) }
  }
  throw $primaryError
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
