import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import OSS from 'ali-oss';
import {downloadManifest} from '../apps/site/src/downloads.mjs';

const execute = promisify(execFile);
export const downloadStorage = Object.freeze({bucket: 'lingji-studio', region: 'oss-cn-shanghai', prefix: 'releases/'});
export const downloadOrigin = 'https://lingji-studio.oss-cn-shanghai.aliyuncs.com/releases/';
const manifest = value => {
  const checked = downloadManifest(value);
  return {version: checked.version, assets: checked.assets.map(({name, size, sha256}) => ({name, size, sha256}))};
};
function compare(left, right) {
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
async function readCatalog(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    assert.ok(size <= 65536, 'Download catalog exceeds 64 KiB');
    chunks.push(chunk);
  }
  return manifest(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))));
}
async function readCurrent(client) {
  try {
    const {stream} = await client.getStream(downloadStorage.prefix + 'current.json');
    return await readCatalog(stream);
  } catch (error) {
    if (error.code === 'NoSuchKey') return null;
    throw error;
  }
}
function checkCurrent(current, next) {
  if (!current) return;
  assert.ok(compare(next.version, current.version) >= 0, 'Cannot downgrade website downloads');
  if (next.version === current.version) assert.deepEqual(current, next, 'Published version is immutable');
}

export async function mirrorSiteDownloads({env = process.env, run = execute, fetcher = fetch, client, receiptPath = resolve('site-download-receipt.json')} = {}) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Upload runs only in GitHub Actions');
  assert.equal(env.GITHUB_REPOSITORY, 'RoyalLiang/LingJi-Meeting-Studio');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.match(env.RELEASE_TAG || '', /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/);
  assert.ok(env.GH_TOKEN, 'GitHub release read token is required');
  assert.ok(env.ALIBABA_CLOUD_ACCESS_KEY_ID && env.ALIBABA_CLOUD_ACCESS_KEY_SECRET && env.ALIBABA_CLOUD_SECURITY_TOKEN, 'Configure OIDC STS authorization first');
  client ||= new OSS({...downloadStorage, secure: true, authorizationV4: true, accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID, accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, stsToken: env.ALIBABA_CLOUD_SECURITY_TOKEN, timeout: 900000});
  const {versionStatus} = await client.getBucketVersioning(downloadStorage.bucket);
  assert.equal(versionStatus, undefined, 'Versioned buckets cannot enforce immutable upload paths');
  const sourceSha = (await run('git', ['rev-parse', '--verify', `refs/tags/${env.RELEASE_TAG}^{commit}`])).stdout.trim();
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  await run('git', ['merge-base', '--is-ancestor', sourceSha, 'origin/main']);
  if (env.EXPECTED_RELEASE_SHA) assert.equal(sourceSha, env.EXPECTED_RELEASE_SHA, 'Release source differs from verified build');
  const response = await fetcher(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/releases/tags/${env.RELEASE_TAG}`, {headers: {Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, redirect: 'error', signal: AbortSignal.timeout(30000)});
  assert.ok(response.ok, `Release metadata HTTP ${response.status}`);
  const release = await response.json();
  assert.equal(release.draft, false, 'Only published releases can be copied');
  assert.equal(release.tag_name, env.RELEASE_TAG);
  assert.equal(release.body?.match(/源码 SHA：`([a-f0-9]{40})`/)?.[1], sourceSha, 'Release source does not match its tag');
  const version = env.RELEASE_TAG.slice(1);
  const next = manifest({version, assets: ['macos-arm64.dmg', 'windows-x64-setup.exe', 'linux-amd64.deb'].map(suffix => {
    const name = `Lingji-${version}-${suffix}`, asset = release.assets.find(item => item.name === name && item.state === 'uploaded');
    assert.match(asset?.digest || '', /^sha256:[a-f0-9]{64}$/, 'Release asset digest is required');
    assert.ok(asset.size < 5 * 1024 ** 3, 'Single PUT size limit exceeded');
    return {name, size: asset.size, sha256: asset.digest.slice(7)};
  })});
  checkCurrent(await readCurrent(client), next);
  const scratch = await mkdtemp(join(tmpdir(), 'lingji-oss-downloads-'));
  try {
    for (const asset of next.assets) {
      await run('gh', ['release', 'download', env.RELEASE_TAG, '--repo', env.GITHUB_REPOSITORY, '--pattern', asset.name, '--dir', scratch], {env, maxBuffer: 1024 * 1024});
      const file = join(scratch, asset.name), sha256 = createHash('sha256'), md5 = createHash('md5');
      assert.equal((await stat(file)).size, asset.size);
      for await (const chunk of createReadStream(file)) { sha256.update(chunk); md5.update(chunk); }
      assert.equal(sha256.digest('hex'), asset.sha256, 'Release asset digest mismatch');
      const checksum = md5.digest(), key = `${downloadStorage.prefix}v${version}/${asset.name}`;
      const stream = createReadStream(file);
      try {
        await client.putStream(key, stream, {contentLength: asset.size, mime: 'application/octet-stream', meta: {sha256: asset.sha256}, headers: {'Content-MD5': checksum.toString('base64'), 'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'public-read', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': `attachment; filename="${asset.name}"`}});
      } catch (error) {
        if (error.code !== 'FileAlreadyExists') throw error;
      } finally { stream.destroy(); }
      const stored = await client.head(key);
      assert.equal(Number(stored.res.headers['content-length']), asset.size);
      assert.equal(stored.meta?.sha256, asset.sha256);
      assert.equal(stored.res.headers.etag?.replaceAll('"', '').toLowerCase(), checksum.toString('hex'), 'Stored object checksum mismatch');
      assert.equal((await client.getACL(key)).acl, 'public-read', 'Release object must be public');
      const publicHead = await fetcher(downloadOrigin + `v${version}/${asset.name}`, {method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30000)});
      assert.equal(publicHead.status, 200, 'OSS release is not publicly readable');
      assert.equal(Number(publicHead.headers.get('content-length')), asset.size);
      await rm(file);
    }
    checkCurrent(await readCurrent(client), next);
    const bytes = Buffer.from(JSON.stringify(next) + '\n');
    // shortcut: OSS has no conditional PutObject; add coordination before allowing a second publisher.
    await client.put(downloadStorage.prefix + 'current.json', bytes, {mime: 'application/json', headers: {'Content-MD5': createHash('md5').update(bytes).digest('base64'), 'x-oss-object-acl': 'public-read', 'Cache-Control': 'no-cache'}});
    assert.deepEqual(await readCurrent(client), next, 'OSS catalog readback differs');
    const publicCatalog = await fetcher(downloadOrigin + 'current.json', {redirect: 'error', signal: AbortSignal.timeout(30000)});
    assert.equal(publicCatalog.status, 200);
    assert.deepEqual(await readCatalog(publicCatalog.body), next, 'Public catalog readback differs');
    const receipt = {version, sourceSha, source: release.html_url, origin: downloadOrigin, assets: next.assets, publishedAt: new Date().toISOString()};
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } finally { await rm(scratch, {recursive: true, force: true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  mirrorSiteDownloads().then(value => console.log(JSON.stringify(value))).catch(error => {
    console.error('OSS publication failed:', error.code || error.name, error.status || '');
    process.exitCode = 1;
  });
}
