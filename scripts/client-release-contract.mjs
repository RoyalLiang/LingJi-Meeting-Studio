import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const releaseTargets = [
  { key: 'darwin-aarch64', runner: 'macos-15', target: 'aarch64-apple-darwin', bundles: 'app,dmg', format: 'app' },
  { key: 'darwin-x86_64', runner: 'macos-15-intel', target: 'x86_64-apple-darwin', bundles: 'app,dmg', format: 'app' },
  { key: 'windows-x86_64', runner: 'windows-2022', target: 'x86_64-pc-windows-msvc', bundles: 'nsis', format: 'nsis' },
  { key: 'linux-x86_64', runner: 'ubuntu-24.04', target: 'x86_64-unknown-linux-gnu', bundles: 'appimage', format: 'appimage' },
];
export function releaseVersion(tag) {
  const match = /^client-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?)$/.exec(tag || '');
  if (!match) throw new Error('Tag must be client-vX.Y.Z or client-vX.Y.Z-alpha/beta/rc.N');
  return match[1];
}
export function releaseRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Release repository must be OWNER/REPO');
  return repository;
}
export function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { stdio: 'pipe', ...options });
  if (result.error || result.status !== 0) throw new Error(`${basename(binary)} failed (exit ${result.status})`);
  return result.stdout?.toString().trim() || '';
}
export async function verifyUpdaterSignature(artifact, signature, publicKey) {
  const directory = await mkdtemp(join(tmpdir(), 'tts-release-verify-'));
  try {
    const keyFile = join(directory, 'public.key'), signatureFile = join(directory, 'artifact.minisig');
    await writeFile(keyFile, Buffer.from(publicKey.trim(), 'base64'));
    await writeFile(signatureFile, Buffer.from(signature.trim(), 'base64'));
    command('minisign', ['-V', '-q', '-p', keyFile, '-x', signatureFile, '-m', artifact]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function buildUpdateManifest(groups, { tag, commit, repository, publicKey, verify = verifyUpdaterSignature, date = new Date().toISOString() }) {
  const version = releaseVersion(tag); releaseRepository(repository);
  if (!Number.isFinite(Date.parse(date))) throw new Error('Publication date must be RFC 3339 compatible');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Source commit must be a full Git object ID');
  if (!publicKey?.trim()) throw new Error('Updater public key is required');
  if (groups.length !== releaseTargets.length) throw new Error('All four platform/architecture groups are required');
  const seen = new Set(), names = new Set(), platforms = {}, files = [];
  for (const { directory, metadata } of groups) {
    const target = releaseTargets.find(target => target.key === metadata.key);
    if (!target || seen.has(target.key)) throw new Error('Duplicate or unsupported release target'); seen.add(target.key);
    if (metadata.tag !== tag || metadata.version !== version || metadata.commit !== commit) throw new Error('Artifact tag/version/commit does not match the release');
    if (target.key !== 'linux-x86_64' && metadata.osSignatureVerified !== true) throw new Error('OS signature/notarization verification is required');
    if (!Array.isArray(metadata.files)) throw new Error('Artifact file inventory is required');
    for (const file of metadata.files) {
      if (basename(file.name) !== file.name || !/^Lingji-[A-Za-z0-9._-]+$/.test(file.name) || names.has(file.name)) throw new Error('Unsafe or duplicate artifact filename');
      names.add(file.name);
      const path = join(directory, file.name), bytes = await readFile(path);
      if (file.bytes !== bytes.length || file.sha256 !== hash(bytes)) throw new Error('Artifact size/hash changed');
      files.push({ path, ...file });
    }
    const packageFile = metadata.files.find(file => file.role === 'updater');
    const signatureFile = metadata.files.find(file => file.role === 'signature');
    if (!packageFile || !signatureFile || signatureFile.name !== `${packageFile.name}.sig`
      || metadata.files.filter(file => file.role === 'updater').length !== 1 || metadata.files.filter(file => file.role === 'signature').length !== 1) throw new Error('Exactly one updater and matching signature are required');
    const extension = target.format === 'app' ? '.app.tar.gz' : target.format === 'nsis' ? '-setup.exe' : '.AppImage';
    if (!packageFile.name.endsWith(extension) || packageFile.bytes < 1 || packageFile.bytes > 256 * 1024 * 1024) throw new Error('Updater format or size is unsupported by the client');
    const installers = metadata.files.filter(file => file.role === 'installer');
    if (metadata.files.some(file => !['updater', 'signature', 'installer'].includes(file.role)) || (target.format === 'app'
      ? installers.length !== 1 || !installers[0].name.endsWith('.dmg') : installers.length !== 0)) throw new Error('Installer inventory does not match its platform');
    const signature = (await readFile(join(directory, signatureFile.name), 'utf8')).trim();
    await verify(join(directory, packageFile.name), signature, publicKey);
    // Only read the trusted comment after minisign verifies both the payload and global signature.
    const trusted = Buffer.from(signature, 'base64').toString('utf8').split('\n').find(line => line.startsWith('trusted comment: '));
    const signedVersion = trusted?.slice('trusted comment: '.length).split('\t').find(field => field.startsWith('version:'))?.slice(8);
    if (signedVersion !== version) throw new Error('Updater signature must bind the exact release version');
    const entry = { url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(packageFile.name)}`, signature };
    platforms[target.key] = entry; platforms[`${target.key}-${target.format}`] = entry;
  }
  return { manifest: { version, notes: `聆记 ${version}。安装会重启客户端，请先结束会议并完成补传。`, pub_date: date, platforms }, files };
}
