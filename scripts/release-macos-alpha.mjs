import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const sourceRef = process.env.TTS_RELEASE_SOURCE_REF ? capture('git', ['rev-parse', '--verify', `${process.env.TTS_RELEASE_SOURCE_REF}^{commit}`]) : null;
const readSource = path => sourceRef ? Promise.resolve(execFileSync('git', ['show', `${sourceRef}:${path}`], { maxBuffer: 8 * 1024 * 1024 })) : readFile(path);
assert.equal(process.platform, 'darwin', 'This release command requires macOS.');
assert.equal(process.arch, 'arm64', 'This Alpha is for Apple Silicon.');
const config = JSON.parse((await readSource('apps/desktop/src-tauri/tauri.alpha.conf.json')).toString());
const baseConfig = JSON.parse((await readSource('apps/desktop/src-tauri/tauri.conf.json')).toString());
assert.match(config.version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
assert.equal(baseConfig.build.frontendDist, '../../web/dist');
const output = join(root, 'dist/releases', config.version);
try {
  await access(output);
  throw new Error(`Release already exists: ${output}. Preserve it and use a new Alpha version.`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function capture(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}

async function run(command, args, extraEnv = {}, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

// Identify the actual build inputs, including existing uncommitted native work.
// Never copy .env, meeting data, credentials, or unrelated IDE state into the release.
async function sourceSnapshot(destination) {
  const paths = capture('git', [...(sourceRef ? ['ls-tree', '-r', '--name-only', '-z', sourceRef] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z']), '--',
    '.gitignore', 'package.json', 'package-lock.json', 'apps/web', 'apps/desktop/package.json',
    'apps/desktop/src-tauri', 'apps/desktop/assets', 'scripts/release-macos-alpha.mjs', 'scripts/test-native-package.mjs', 'docs/releases/macos-alpha.md',
  ]).split('\0').filter(Boolean).sort();
  const files = [];
  for (const path of paths) {
    if (path.split('/').some(part => ['.DS_Store', 'target', 'gen', 'dist', 'node_modules'].includes(part)) || /(^|\/)\.env(?:\.|$)/.test(path)) continue;
    const bytes = await readSource(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    files.push({ path, sha256: bytes === null ? null : createHash('sha256').update(bytes).digest('hex') });
    if (destination && bytes !== null) {
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  }
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

const appName = `${config.productName}.app`;
const parent = dirname(output);
await mkdir(parent, { recursive: true });
const release = await mkdtemp(join(parent, '.alpha-build-'));
const scratch = await mkdtemp(join(tmpdir(), 'lingji-alpha-install-'));
const mount = join(scratch, 'mounted');
let mounted = false;
try {
  const frozen = join(scratch, 'source');
  const revision = sourceRef || capture('git', ['rev-parse', 'HEAD']);
  const source = await sourceSnapshot(frozen);
  assert.equal((await sourceSnapshot()).sha256, source.sha256, 'Inputs changed while taking the source snapshot; retry.');
  const sourceStatus = sourceRef ? '' : capture('git', ['status', '--porcelain=v1', '--', ...source.files.map(file => file.path)]);
  // Reuse installed dependencies, but compile frozen application sources in an isolated Cargo target.
  await symlink(join(root, 'node_modules'), join(frozen, 'node_modules'));
  for (const workspace of ['apps/web', 'apps/desktop']) {
    const modules = join(root, workspace, 'node_modules');
    try { await access(modules); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    await symlink(modules, join(frozen, workspace, 'node_modules'));
  }
  const generatedIcons = join(scratch, 'icons');
  await run('npm', ['exec', '--workspace', 'apps/desktop', '--', 'tauri', 'icon', join(frozen, 'apps/desktop/assets/lingji-app-icon.svg'), '--output', generatedIcons], {}, frozen);
  // ICNS encoders may emit identical image blocks in a different order.
  const iconDigest = (bytes, name) => {
    const hash = value => createHash('sha256').update(value).digest('hex');
    if (name !== 'icon.icns') return hash(bytes);
    assert.equal(bytes.subarray(0, 4).toString(), 'icns');
    assert.equal(bytes.readUInt32BE(4), bytes.length);
    const blocks = [];
    for (let offset = 8; offset < bytes.length;) {
      assert.ok(offset + 8 <= bytes.length);
      const size = bytes.readUInt32BE(offset + 4);
      assert.ok(size >= 8 && offset + size <= bytes.length);
      blocks.push(hash(bytes.subarray(offset, offset + size)));
      offset += size;
    }
    return hash(blocks.sort().join('\n'));
  };
  for (const name of ['icon.png', 'icon.icns', 'icon.ico']) {
    const generated = iconDigest(await readFile(join(generatedIcons, name)), name);
    const packaged = iconDigest(await readFile(join(frozen, 'apps/desktop/src-tauri/icons', name)), name);
    assert.equal(generated, packaged, `Regenerate ${name} from the selected SVG before release.`);
  }
  await run('npm', ['run', 'build:web'], {}, frozen);
  const cargoTarget = join(root, '.agent-runtime/releases/macos-alpha/target');
  await run('npm', ['exec', '--workspace', 'apps/desktop', '--', 'tauri', 'build', '--ci', '--bundles', 'app,dmg',
    '--config', join(frozen, 'apps/desktop/src-tauri/tauri.alpha.conf.json')], { CARGO_TARGET_DIR: cargoTarget }, frozen);
  const builtApp = join(cargoTarget, 'release/bundle/macos', appName);
  await run('codesign', ['--verify', '--deep', '--strict', builtApp]);
  await copyFile(join(frozen, 'docs/releases/macos-alpha.md'), join(release, '安装说明.md'));
  const dmgName = `Lingji-${config.version}-macos-arm64.dmg`;
  const dmg = join(release, dmgName);
  const bundleDmg = join(cargoTarget, 'release/bundle/dmg', `${config.productName}_${config.version}_aarch64.dmg`);
  await copyFile(bundleDmg, dmg);
  await run('hdiutil', ['verify', dmg]);
  await mkdir(mount);
  await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
  mounted = true;
  assert.ok((await readFile(join(mount, '.DS_Store'))).length > 100, 'DMG Finder layout missing');
  const backgrounds = (await readdir(join(mount, '.background'))).filter(name => /\.(tiff?|png)$/i.test(name));
  assert.equal(backgrounds.length, 1, 'DMG installation background missing');
  assert.deepEqual(await readFile(join(mount, '.background', backgrounds[0])), await readFile(join(frozen, 'apps/desktop/assets/macos-installer-background.tiff')));
  const installedApp = join(scratch, 'installed', appName);
  await run('ditto', [join(mount, appName), installedApp]);
  await run('codesign', ['--verify', '--deep', '--strict', installedApp]);
  const binary = join(installedApp, 'Contents/MacOS/tts-client');
  assert.equal(capture('lipo', ['-archs', binary]), 'arm64');
  const plist = join(installedApp, 'Contents/Info.plist');
  const readPlist = key => capture('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
  assert.equal(readPlist('CFBundleIdentifier'), baseConfig.identifier);
  assert.equal(readPlist('CFBundleVersion'), config.bundle.macOS.bundleVersion);
  assert.equal(readPlist('LSMinimumSystemVersion'), baseConfig.bundle.macOS.minimumSystemVersion);
  assert.ok(readPlist('NSMicrophoneUsageDescription'));
  assert.ok(readPlist('NSAudioCaptureUsageDescription'));
  await run(process.execPath, ['scripts/test-native-package.mjs', join(release, 'package-smoke.json')], {
    NATIVE_CLIENT_EXECUTABLE: binary,
  }, frozen);
  const checksum = createHash('sha256').update(await readFile(dmg)).digest('hex');
  await writeFile(join(release, 'SHA256SUMS.txt'), `${checksum}  ${dmgName}\n`);
  await writeFile(join(release, 'release.json'), JSON.stringify({
    version: config.version, productName: config.productName, platform: 'macos', architecture: 'arm64',
    installer: config.bundle.macOS.dmg, iconSource: 'apps/desktop/assets/lingji-app-icon.svg',
    minimumSystemVersion: readPlist('LSMinimumSystemVersion'),
    bundleVersion: readPlist('CFBundleVersion'), bundleShortVersion: readPlist('CFBundleShortVersionString'),
    createdAt: new Date().toISOString(), artifact: dmgName, sha256: checksum,
    signing: 'ad-hoc', notarized: false, backendBundled: false,
    sourceRevision: revision, sourceDirty: Boolean(sourceStatus), sourceStatus, source, frozenSourceBuild: true,
    validation: { imageVerified: true, copiedAppSignatureVerified: true, productionSmoke: true,
      realAudioDevicesTested: false, realProvidersTested: false, freshMachineTested: false },
  }, null, 2) + '\n');
  await run('hdiutil', ['detach', mount]);
  mounted = false;
  await rename(release, output);
  console.log(`Local Alpha release: ${output}`);
} finally {
  if (mounted) await run('hdiutil', ['detach', mount]);
  await rm(scratch, { recursive: true, force: true });
  await rm(release, { recursive: true, force: true });
}
