import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {access, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {releaseHash, snapshotReleaseSource} from './release-source.mjs';
import {verifyWgsInput} from './wgs-build-contract.mjs';
import {downloadPinned} from './prepare-local-asr.mjs';

export function storeIdentity(input) {
  assert.ok(input && typeof input === 'object', 'Reserved Microsoft Store identity is required');
  const {storeId, name, publisher, displayName, appDisplayName} = input;
  assert.match(storeId || '', /^[A-Z0-9]{12}$/, 'Use the Store ID from Partner Center');
  assert.match(name || '', /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/, 'Use the exact Package/Identity/Name from Partner Center');
  assert.match(publisher || '', /^CN=[^<>\r\n\0]{3,200}$/, 'Use the exact Package/Identity/Publisher from Partner Center');
  for (const value of [displayName, appDisplayName]) assert.ok(typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f]/.test(value), 'Reserved application and publisher display names are required');
  return {storeId, name, publisher, displayName, appDisplayName};
}

export function msixVersion(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(version.split('.').every(value => Number(value) <= 65535 && String(Number(value)) === value), 'MSIX version components must be canonical integers <= 65535');
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(major < 65535, 'Store major version reserves an offset for zero-major product releases');
  return `${major + 1}.${minor}.${patch}.0`;
}

const xml = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[character]));

export function msixManifest(version, identity) {
  storeIdentity(identity);
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap rescap">
  <Identity Name="${xml(identity.name)}" Publisher="${xml(identity.publisher)}" Version="${msixVersion(version)}" ProcessorArchitecture="x64" />
  <Properties><DisplayName>${xml(identity.appDisplayName)}</DisplayName><PublisherDisplayName>${xml(identity.displayName)}</PublisherDisplayName><Logo>Assets/StoreLogo.png</Logo></Properties>
  <Resources><Resource Language="zh-cn" /><Resource Language="en-us" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Applications><Application Id="App" Executable="tts-client.exe" EntryPoint="Windows.FullTrustApplication"><uap:VisualElements DisplayName="${xml(identity.appDisplayName)}" Description="录音、转录与会议纪要工作台" BackgroundColor="transparent" Square150x150Logo="Assets/Square150x150Logo.png" Square44x44Logo="Assets/Square44x44Logo.png" /></Application></Applications>
  <Capabilities><Capability Name="internetClient" /><rescap:Capability Name="runFullTrust" /><DeviceCapability Name="microphone" /></Capabilities>
</Package>
`;
}

export async function buildWindowsMsix({root, prebuilt, destination, sourceRevision, identity}) {
  assert.equal(process.platform, 'linux', 'Store packages are built in the WGS Linux container');
  await access('/.dockerenv');
  assert.equal(process.env.TTS_WGS_CURRENT_BUILD, '1');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  assert.equal(revision, sourceRevision, 'MSIX must use the fixed release checkout');
  const version = JSON.parse(await readFile(join(root, 'apps/desktop/src-tauri/tauri.preview.conf.json'))).version;
  const source = await snapshotReleaseSource({root, ref: sourceRevision});
  const receipt = await verifyWgsInput(prebuilt, {version, sourceRevision, source});
  assert.ok(receipt.files.some(file => file.name === 'windows-app.exe'), 'WGS must provide the application executable');
  await assert.rejects(access(destination), {code: 'ENOENT'}, 'Never replace an existing Store candidate');
  await mkdir(dirname(destination), {recursive: true});
  const stage = await mkdtemp(join(dirname(destination), '.msix-'));
  const run = (command, args) => execFileSync(command, args, {cwd: root, stdio: 'inherit'});
  try {
    const payload = join(stage, 'payload');
    await mkdir(payload);
    await copyFile(join(prebuilt, 'windows-app.exe'), join(payload, 'tts-client.exe'));
    const archive = join(prebuilt, 'resources.tar.gz');
    const entries = execFileSync('tar', ['-tf', archive], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}).trim().split(/\r?\n/);
    assert.ok(entries.length && entries.every(path => /^(runtime|client-backend)\//.test(path) && !path.split('/').includes('..') && !path.includes('\\')), 'Unsafe WGS resource archive');
    run('tar', ['-xf', archive, '-C', payload]);
    const config = JSON.parse(await readFile(join(root, 'apps/desktop/src-tauri/tauri.conf.json')));
    for (const [from, to] of Object.entries(config.bundle.resources)) {
      if (!to.startsWith('licenses/')) continue;
      assert.ok(!to.split('/').includes('..'));
      await mkdir(dirname(join(payload, to)), {recursive: true});
      await copyFile(join(root, 'apps/desktop/src-tauri', from), join(payload, to));
    }
    await copyFile(join(root, 'tools/release/WebView2-Fixed-Version-EULA.html'), join(payload, 'licenses/WebView2-Fixed-Version-EULA.html'));
    const webview = JSON.parse(await readFile(join(root, 'tools/release/webview2-fixed.json')));
    assert.match(webview.version, /^\d+\.\d+\.\d+\.\d+$/);
    assert.match(webview.sha256, /^[a-f0-9]{64}$/);
    assert.ok(new URL(webview.url).hostname === 'msedge.sf.dl.delivery.mp.microsoft.com');
    const cache = resolve(process.env.TTS_RUNTIME_CACHE || join(root, '.agent-runtime/runtimes'));
    await mkdir(cache, {recursive: true});
    const cab = join(cache, `webview2-${webview.version}-x64.cab`);
    await downloadPinned(webview.url, cab, 'sha256', webview.sha256);
    const extracted = join(stage, 'webview-extracted');
    await mkdir(extracted);
    run('cabextract', ['-q', '-d', extracted, cab]);
    const runtime = join(extracted, `Microsoft.WebView2.FixedVersionRuntime.${webview.version}.x64`);
    await access(join(runtime, 'msedgewebview2.exe'));
    await cp(runtime, join(payload, 'webview2'), {recursive: true});
    await rm(extracted, {recursive: true});
    run('npm', ['exec', '--workspace', '@tts/desktop', '--', 'tauri', 'icon', '--output', join(payload, 'Assets'), join(root, 'apps/desktop/src-tauri/icons/icon.png')]);
    await writeFile(join(payload, 'AppxManifest.xml'), msixManifest(version, identity));
    const fileName = 'windows-store-unsigned.msix';
    const packagePath = join(stage, fileName);
    run('makemsix', ['pack', '-d', payload, '-p', packagePath]);
    const bytes = await readFile(packagePath);
    await writeFile(join(stage, 'store-package.json'), JSON.stringify({version, packageVersion: msixVersion(version), sourceRevision, sourceDigest: source.sha256, builder: 'wgs', identity, signed: false, published: false, webview, sdkRevision: '7adc5aed67a309ee77dfed45be76285bda8f738d', artifact: {name: fileName, size: bytes.length, sha256: releaseHash(bytes)}}, null, 2) + '\n');
    await rm(payload, {recursive: true});
    await rename(stage, destination);
    return {destination, version, sourceRevision};
  } catch (error) { await rm(stage, {recursive: true, force: true}); throw error; }
}

export async function copyWindowsMsix({root, prebuilt, destination, sourceRevision}) {
  const version = JSON.parse(await readFile(join(root, 'apps/desktop/src-tauri/tauri.preview.conf.json'))).version;
  const source = await snapshotReleaseSource({root, ref: sourceRevision});
  await verifyWgsInput(prebuilt, {version, sourceRevision, source});
  const metadata = JSON.parse(await readFile(join(prebuilt, 'store-package.json')));
  assert.equal(metadata.sourceRevision, sourceRevision);
  assert.equal(metadata.sourceDigest, source.sha256);
  assert.equal(metadata.version, version);
  assert.equal(metadata.packageVersion, msixVersion(version));
  assert.equal(metadata.builder, 'wgs');
  assert.equal(metadata.signed, false);
  assert.equal(metadata.published, false);
  assert.deepEqual(metadata.identity, storeIdentity(JSON.parse(await readFile(join(root, 'apps/desktop/src-tauri/microsoft-store.json')))));
  assert.equal(metadata.artifact.name, 'windows-store-unsigned.msix');
  const bytes = await readFile(join(prebuilt, metadata.artifact.name));
  assert.equal(bytes.length, metadata.artifact.size);
  assert.equal(releaseHash(bytes), metadata.artifact.sha256);
  await mkdir(destination, {recursive: false});
  for (const name of ['store-package.json', metadata.artifact.name]) await copyFile(join(prebuilt, name), join(destination, name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.platform, 'win32', 'This command verifies the WGS submission in Windows CI');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.ok(process.env.TTS_PREBUILT_DIRECTORY);
  const root = resolve(import.meta.dirname, '..');
  const destination = resolve(process.env.TTS_MSIX_OUTPUT || '.agent-runtime/msix-submission');
  await copyWindowsMsix({root, prebuilt: resolve(process.env.TTS_PREBUILT_DIRECTORY), destination, sourceRevision: process.env.TTS_RELEASE_SOURCE_REF});
  execFileSync('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/package-windows-msix.ps1'), '-Prebuilt', process.env.TTS_PREBUILT_DIRECTORY, '-Metadata', join(destination, 'store-package.json'), '-Output', join(destination, 'schema-verification.json')], {cwd: root, stdio: 'inherit'});
}
