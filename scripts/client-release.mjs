import { prepareClientBackend } from './prepare-client-backend.mjs';
import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { releaseVersion, releaseRepository, releaseTargets, hash, command } from './client-release-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || 'plan', tag = process.env.RELEASE_TAG || process.argv[3];
const version = releaseVersion(tag), repository = releaseRepository(process.env.CLIENT_RELEASE_REPOSITORY || process.env.GITHUB_REPOSITORY);
const tauri = join(dirname(createRequire(import.meta.url).resolve('@tauri-apps/cli')), 'tauri.js');
const selected = releaseTargets.find(target => target.key === process.env.CLIENT_RELEASE_TARGET);
function git(...args) { return command('git', args, { cwd: root }); }
async function versions(ref = '') {
  const source = async path => ref ? git('show', `${ref}:${path}`) : readFile(join(root, path), 'utf8');
  const configuration = JSON.parse(await source('apps/desktop/src-tauri/tauri.conf.json'));
  const desktop = JSON.parse(await source('apps/desktop/package.json'));
  const cargo = /\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(await source('apps/desktop/src-tauri/Cargo.toml'))?.[1];
  if ([configuration.version, desktop.version, cargo].some(value => value !== version)) throw new Error('Client package, Tauri and Cargo versions must match the tag');
}
async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name); if (entry.isDirectory()) result.push(...await walk(path)); else if (entry.isFile()) result.push(path);
  } return result;
}
if (mode === 'verify-tag') {
  if (git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag') throw new Error('Release requires an annotated signed tag');
  git('verify-tag', tag);
  const branch = process.env.RELEASE_DEFAULT_BRANCH; if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('Default branch is required');
  git('merge-base', '--is-ancestor', `${tag}^{commit}`, `origin/${branch}`); await versions(tag);
  const sha = git('rev-parse', `${tag}^{commit}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `sha=${sha}\ntag=${tag}\nversion=${version}\n`);
  console.log(JSON.stringify({ tag, version, sha, repository }));
} else if (mode === 'plan') {
  await versions(); console.log(JSON.stringify({ tag, version, repository, targets: releaseTargets, updaterEndpoint: `https://github.com/${repository}/releases/latest/download/latest.json`, execute: false }, null, 2));
} else if (mode === 'build') {
  if (process.env.CI !== 'true') throw new Error('Signed release builds run in the configured CI environment');
  if (!selected) throw new Error('CLIENT_RELEASE_TARGET is required'); await versions();
  const commit = git('rev-parse', 'HEAD'); if (commit !== process.env.RELEASE_SHA) throw new Error('Checkout differs from verified tag commit');
  if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('Release checkout must be clean');
  for (const name of ['TAURI_SIGNING_PRIVATE_KEY', 'TTS_UPDATER_PUBLIC_KEY']) if (!process.env[name]) throw new Error(`${name} is required`);
  // The release must contain its own API/worker runtime on every target.
  await prepareClientBackend({ root });
  const config = { bundle: { createUpdaterArtifacts: true } };
  if (selected.key.startsWith('darwin')) {
    for (const name of ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) if (!process.env[name]) throw new Error(`${name} is required for notarized macOS builds`);
    const run = Number(process.env.GITHUB_RUN_NUMBER); if (!Number.isInteger(run) || run < 1 || run > 99_989_999) throw new Error('Valid monotonically increasing GitHub run number required');
    config.bundle.macOS = { bundleVersion: `${Math.floor(run / 10000) + 1}.${Math.floor(run / 100) % 100}.${run % 100}` };
  }
  if (selected.key.startsWith('windows')) {
    if (!process.env.WINDOWS_SIGN_COMMAND || !process.env.WINDOWS_PUBLISHER_SUBJECT) throw new Error('Provision Windows issuer signing tool, command and publisher identity first');
    config.bundle.windows = { signCommand: process.env.WINDOWS_SIGN_COMMAND };
  }
  const output = join(root, 'dist', 'client-release', selected.key); await mkdir(output, { recursive: true });
  const configPath = join(output, 'build-config.json'); await writeFile(configPath, JSON.stringify(config));
  const env = { ...process.env, TTS_UPDATER_ENDPOINT: `https://github.com/${repository}/releases/latest/download/latest.json` };
  command(process.execPath, [tauri, 'build', '--ci', '--target', selected.target, '--bundles', selected.bundles, '--config', configPath, '--', '--locked'], { cwd: join(root, 'apps', 'desktop'), env, stdio: 'inherit' });
  const bundle = join(root, 'apps', 'desktop', 'src-tauri', 'target', selected.target, 'release', 'bundle');
  const paths = await walk(bundle);
  const updater = paths.filter(path => selected.format === 'app' ? path.endsWith('.app.tar.gz') : selected.format === 'nsis' ? path.endsWith('-setup.exe') : path.endsWith('.AppImage'));
  if (updater.length !== 1) throw new Error('Expected one updater artifact');
  let osSignatureVerified = false;
  if (selected.format === 'app') {
    const app = updater[0].slice(0, -'.tar.gz'.length);
    command('codesign', ['--verify', '--deep', '--strict', app]); command('xcrun', ['stapler', 'validate', app]); command('spctl', ['--assess', '--type', 'execute', app]); osSignatureVerified = true;
  }
  if (selected.format === 'nsis') { command('powershell', ['-NoProfile', '-File', join(root, 'scripts', 'verify-windows-signature.ps1'), '-Artifact', updater[0]], { env }); osSignatureVerified = true; }
  const extension = selected.format === 'app' ? '.app.tar.gz' : selected.format === 'nsis' ? '-setup.exe' : '.AppImage';
  const name = `Lingji-${version}-${selected.key}${extension}`, files = [];
  const save = async (path, name, role) => { const bytes = await readFile(path); await writeFile(join(output, name), bytes); files.push({ name, role, bytes: bytes.length, sha256: hash(bytes) }); };
  await save(updater[0], name, 'updater'); await save(`${updater[0]}.sig`, `${name}.sig`, 'signature');
  if (selected.format === 'app') { const dmg = paths.filter(path => path.endsWith('.dmg')); if (dmg.length !== 1) throw new Error('DMG installer missing'); await save(dmg[0], `Lingji-${version}-${selected.key}.dmg`, 'installer'); }
  await writeFile(join(output, 'release.json'), JSON.stringify({ tag, version, commit, key: selected.key, osSignatureVerified, node: process.version, rust: command('rustc', ['--version']), files }, null, 2) + '\n');
  console.log(JSON.stringify({ output, target: selected.key, files: files.map(file => basename(file.name)) }));
} else throw new Error('Expected plan, verify-tag or build');
