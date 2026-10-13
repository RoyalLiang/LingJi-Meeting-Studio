// Network mutations are confined to the explicitly configured CI publishing jobs.
import { readFile, writeFile, readdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUpdateManifest, command, hash, releaseRepository, releaseVersion, releaseTargets } from './client-release-contract.mjs';

if (process.env.CI !== 'true') throw new Error('Remote release changes require the configured CI release environment');
const mode = process.argv[2], tag = process.env.RELEASE_TAG, commit = process.env.RELEASE_SHA;
const version = releaseVersion(tag), repository = releaseRepository(process.env.CLIENT_RELEASE_REPOSITORY || process.env.GITHUB_REPOSITORY);
if (!process.env.GH_TOKEN) throw new Error('A scoped release token is required');
const gh = (...args) => command('gh', args);
const api = path => JSON.parse(gh('api', '-H', 'X-GitHub-Api-Version: 2026-03-10', path));
if (api(`repos/${repository}`).private !== false) throw new Error('Anonymous updater downloads require a public distribution repository');
if (api(`repos/${repository}/immutable-releases`).enabled !== true) throw new Error('Enable immutable releases before publication; token needs Administration read');
const temporary = await mkdtemp(join(tmpdir(), 'tts-client-publish-'));
try {
  let groups = [], existing;
  if (mode === 'draft') {
    const artifacts = resolve(process.argv[3] || 'release-artifacts');
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else if (entry.name === 'release.json') groups.push({ directory, metadata: JSON.parse(await readFile(path, 'utf8')) });
      }
    } await collect(artifacts);
  } else if (mode === 'publish') {
    existing = api(`repos/${repository}/releases/tags/${tag}`);
    if (existing.draft !== true) throw new Error('Only an existing draft can be published; released assets are never replaced');
    gh('release', 'download', tag, '--repo', repository, '--dir', temporary, '--pattern', 'Lingji-*', '--pattern', 'release-*.json', '--pattern', 'latest.json', '--pattern', 'SHA256SUMS.txt');
    for (const target of releaseTargets) groups.push({ directory: temporary, metadata: JSON.parse(await readFile(join(temporary, `release-${target.key}.json`), 'utf8')) });
  } else throw new Error('Expected draft or publish');
  const oldManifest = mode === 'publish' ? JSON.parse(await readFile(join(temporary, 'latest.json'), 'utf8')) : undefined;
  const { manifest, files } = await buildUpdateManifest(groups, { tag, commit, repository, publicKey: process.env.TTS_UPDATER_PUBLIC_KEY, date: oldManifest?.pub_date });
  if (mode === 'publish') {
    if (oldManifest.version !== manifest.version || JSON.stringify(oldManifest.platforms) !== JSON.stringify(manifest.platforms) || oldManifest.notes !== manifest.notes) throw new Error('Published update manifest differs from verified draft assets');
    const expected = new Set([...files.map(file => file.name), 'latest.json', 'SHA256SUMS.txt', ...releaseTargets.map(target => `release-${target.key}.json`)]);
    if (existing.assets.length !== expected.size || existing.assets.some(asset => !expected.has(asset.name))) throw new Error('Draft inventory is incomplete or contains unexpected assets');
    const checksumPaths = [...files.map(file => file.path), join(temporary, 'latest.json'), ...releaseTargets.map(target => join(temporary, `release-${target.key}.json`))];
    const checksumLines = await Promise.all(checksumPaths.map(async path => `${hash(await readFile(path))}  ${basename(path)}`));
    const storedSums = (await readFile(join(temporary, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n').sort();
    if (JSON.stringify(storedSums) !== JSON.stringify(checksumLines.sort())) throw new Error('Draft checksums do not match its actual asset bytes');
    gh('release', 'edit', tag, '--repo', repository, '--draft=false', `--prerelease=${version.includes('-')}`, `--latest=${!version.includes('-')}`);
    const released = api(`repos/${repository}/releases/tags/${tag}`);
    if (!released.immutable || released.draft) throw new Error('Release publication did not confirm immutability; investigate before further releases');
    console.log(JSON.stringify({ published: true, tag, immutable: true, repository }));
  } else {
    // No --clobber: retrying can never overwrite a named release artifact.
    let draft;
    try { draft = api(`repos/${repository}/releases/tags/${tag}`); } catch { /* create below; API errors still cannot overwrite anything */ }
    if (draft && (!draft.draft || draft.assets.length)) throw new Error('Tag already has release assets; publish that verified draft or explicitly resolve it first');
    const notes = join(temporary, 'notes.md');
    await writeFile(notes, `聆记 ${version}\n\nSource tag: ${tag}\nSource commit: ${commit}\n\n客户端更新需要后端安全更新协议 v1。macOS/Windows/Linux 目标制品与签名已汇总。录音、暂停和补传期间不会安装更新。\n`);
    if (!draft) {
      const args = ['release', 'create', tag, '--repo', repository, '--draft', '--title', `聆记 ${version}`, '--notes-file', notes];
      if (repository === process.env.GITHUB_REPOSITORY) args.push('--verify-tag');
      if (version.includes('-')) args.push('--prerelease'); gh(...args);
    }
    const uploads = [];
    for (const file of files) { const path = join(temporary, basename(file.name)); await copyFile(file.path, path); uploads.push(path); }
    for (const { metadata } of groups) { const path = join(temporary, `release-${metadata.key}.json`); await writeFile(path, JSON.stringify(metadata, null, 2) + '\n'); uploads.push(path); }
    const manifestPath = join(temporary, 'latest.json'); await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n'); uploads.push(manifestPath);
    const checksums = await Promise.all(uploads.map(async path => `${hash(await readFile(path))}  ${basename(path)}`));
    const checksumPath = join(temporary, 'SHA256SUMS.txt'); await writeFile(checksumPath, checksums.join('\n') + '\n'); uploads.push(checksumPath);
    gh('release', 'upload', tag, '--repo', repository, ...uploads);
    console.log(JSON.stringify({ draft: true, tag, repository, files: uploads.length }));
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
