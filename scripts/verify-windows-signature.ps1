param([Parameter(Mandatory=$true)][string]$Artifact)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Artifact
if ($signature.Status -ne 'Valid') { throw 'Windows Authenticode signature is not valid' }
if (-not $env:WINDOWS_PUBLISHER_SUBJECT -or $signature.SignerCertificate.Subject -ne $env:WINDOWS_PUBLISHER_SUBJECT) { throw 'Windows publisher differs from the configured release identity' }
if (-not $signature.TimeStamperCertificate) { throw 'Windows release signature requires a trusted timestamp' }
Write-Output 'Windows signature, publisher and timestamp verified'
