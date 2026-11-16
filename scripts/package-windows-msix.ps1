param(
  [Parameter(Mandatory=$true)][string]$Prebuilt,
  [Parameter(Mandatory=$true)][string]$Metadata,
  [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'MSIX verification requires disposable Windows CI' }
$receipt = Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
$package = Join-Path (Split-Path $Metadata) $receipt.artifact.name
$hash = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $receipt.artifact.sha256) { throw 'WGS MSIX digest mismatch' }
$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$makeAppx = Get-ChildItem "$sdk\*\x64\makeappx.exe" | Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
if (-not $makeAppx) { throw 'Windows SDK MakeAppx was not found' }
$unpacked = Join-Path ([IO.Path]::GetTempPath()) ('lingji-msix-schema-'+[guid]::NewGuid().ToString('N'))
try {
  & $makeAppx.FullName unpack /p $package /d $unpacked
  if ($LASTEXITCODE -ne 0) { throw "MakeAppx unpack failed: $LASTEXITCODE" }
  if ((Get-FileHash -LiteralPath (Join-Path $unpacked 'tts-client.exe') -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Prebuilt 'windows-app.exe') -Algorithm SHA256).Hash) { throw 'MSIX changed the WGS executable' }
  [xml]$manifest = Get-Content -LiteralPath (Join-Path $unpacked 'AppxManifest.xml') -Raw
  if ($manifest.Package.Applications.Application.Executable -ne 'tts-client.exe' -or $manifest.Package.Identity.ProcessorArchitecture -ne 'x64') { throw 'Unexpected package entry point or architecture' }
  if ($manifest.Package.Identity.Name -ne $receipt.identity.name -or $manifest.Package.Identity.Publisher -ne $receipt.identity.publisher -or $manifest.Package.Identity.Version -ne $receipt.packageVersion) { throw 'MSIX identity differs from receipt' }
  if (Test-Path -LiteralPath (Join-Path $unpacked 'AppxSignature.p7x')) { throw 'Store submission must remain unsigned' }
  $runtime = Join-Path $unpacked 'webview2/msedgewebview2.exe'
  if (-not (Test-Path -LiteralPath $runtime) -or (Get-Item -LiteralPath $runtime).VersionInfo.ProductVersion -ne $receipt.webview.version) { throw 'Incorrect packaged Fixed WebView2 runtime' }
  $signature = Get-AuthenticodeSignature -LiteralPath $runtime
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'Fixed WebView2 does not have a valid Microsoft signature' }
  @{unpacked=$true;appExecutableMatches=$true;packageIdentityMatches=$true;fixedWebviewVersion=$receipt.webview.version;originalSha256=$hash;signature='unsigned-submission';makeAppxVersion=$makeAppx.VersionInfo.FileVersion} | ConvertTo-Json | Set-Content -LiteralPath $Output -Encoding utf8
} finally {
  if (Test-Path -LiteralPath $unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force }
  if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Schema verification changed the original WGS package' }
}
