$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$sdk = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
$makePri = Get-ChildItem "$sdk\*\x64\makepri.exe" -File |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makePri) { throw 'Windows SDK MakePri not found' }
$root = (Get-Location).Path
$stage = Join-Path $root 'store-icons'
$configuration = Join-Path $env:RUNNER_TEMP 'lingji-store-icons-priconfig.xml'
$identity = Get-Content 'apps/desktop/src-tauri/microsoft-store.json' -Raw | ConvertFrom-Json
$source = (git rev-parse HEAD).Trim()
if (Test-Path -LiteralPath $stage) { throw 'Store resources output already exists' }
node --input-type=module -e "import {writeStoreIcons} from './scripts/windows-msix.mjs'; await writeStoreIcons(process.cwd(), 'store-icons/Assets');"
& $makePri.FullName createconfig /cf $configuration /dq en-US /o
# Keep scale and theme variants in the same MSIX resource index.
[xml]$config = Get-Content -LiteralPath $configuration -Raw
$packaging = $config.SelectSingleNode('/resources/packaging')
if ($packaging) { [void]$packaging.ParentNode.RemoveChild($packaging) }
$config.Save($configuration)
& $makePri.FullName new /pr $stage /cf $configuration /in $identity.name /of (Join-Path $stage 'resources.pri')
if (-not (Test-Path -LiteralPath (Join-Path $stage 'resources.pri') -PathType Leaf)) { throw 'Missing Store resource index' }
$files = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object { $_.Extension -in '.pri','.png' } | ForEach-Object {
    @{
        name = [IO.Path]::GetRelativePath($stage, $_.FullName).Replace('\','/')
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
})
@{ sourceRevision = $source; files = $files } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stage 'store-icons.json') -Encoding utf8
