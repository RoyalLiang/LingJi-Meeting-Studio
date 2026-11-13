import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mirrorSiteDownloads, downloadStorage, downloadOrigin} from '../scripts/mirror-site-downloads.mjs';

const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const env = {GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'RoyalLiang/LingJi-Meeting-Studio', GITHUB_REF: 'refs/heads/main', RELEASE_TAG: 'v0.3.29', GH_TOKEN: 'test-github-token', ALIBABA_CLOUD_ACCESS_KEY_ID: 'test-sts-id', ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'test-sts-secret', ALIBABA_CLOUD_SECURITY_TOKEN: 'test-sts-token'};
const sourceSha = 'a'.repeat(40);
function fixture() {
  const files = new Map(['macos-arm64.dmg', 'windows-x64-setup.exe', 'linux-amd64.deb'].map(suffix => [`Lingji-0.3.29-${suffix}`, Buffer.from('synthetic release fixture: ' + suffix)]));
  const release = {draft: false, tag_name: env.RELEASE_TAG, body: '源码 SHA：`' + sourceSha + '`；工作流 SHA：`' + 'b'.repeat(40) + '`。', html_url: `https://github.com/${env.GITHUB_REPOSITORY}/releases/tag/${env.RELEASE_TAG}`, assets: [...files].map(([name, bytes]) => ({name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + hash('sha256', bytes)}))};
  const objects = new Map(), writes = [], directories = [];
  let versionStatus;
  const missing = () => Object.assign(new Error('missing'), {code: 'NoSuchKey'});
  const client = {
    async getBucketVersioning(bucket) { assert.equal(bucket, downloadStorage.bucket); return {versionStatus}; },
    async getStream(key) { const object = objects.get(key); if (!object) throw missing(); return {stream: Readable.from([object.bytes])}; },
    async putStream(key, stream, options) {
      assert.ok(key.startsWith('releases/v0.3.29/'));
      assert.equal(options.headers['x-oss-forbid-overwrite'], 'true');
      if (objects.has(key)) throw Object.assign(new Error('exists'), {code: 'FileAlreadyExists'});
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(options.contentLength, bytes.length);
      assert.equal(options.headers['Content-MD5'], createHash('md5').update(bytes).digest('base64'));
      objects.set(key, {bytes, meta: options.meta, acl: options.headers['x-oss-object-acl']});
      writes.push(key);
    },
    async put(key, bytes, options) {
      assert.equal(key, 'releases/current.json');
      assert.equal(options.headers['Cache-Control'], 'no-cache');
      assert.equal(options.headers['x-oss-object-acl'], 'public-read');
      assert.equal(options.headers['Content-MD5'], createHash('md5').update(bytes).digest('base64'));
      objects.set(key, {bytes, acl: 'public-read'}); writes.push(key);
    },
    async head(key) { const object = objects.get(key); if (!object) throw missing(); return {meta: object.meta, res: {headers: {'content-length': String(object.bytes.length), etag: `"${hash('md5', object.bytes).toUpperCase()}"`}}}; },
    async getACL(key) { return {acl: objects.get(key)?.acl}; }
  };
  const fetcher = async (url, options) => {
    if (url.startsWith('https://api.github.com/')) {
      assert.equal(options.headers.Authorization, 'Bearer ' + env.GH_TOKEN);
      return Response.json(release);
    }
    assert.ok(url.startsWith(downloadOrigin));
    assert.equal(options.headers, undefined, 'Public requests must not contain credentials');
    const object = objects.get('releases/' + url.slice(downloadOrigin.length));
    if (!object || object.acl !== 'public-read') return new Response(null, {status: 403});
    return new Response(options.method === 'HEAD' ? null : object.bytes, {headers: {'content-length': String(object.bytes.length)}});
  };
  const run = async (program, args) => {
    if (program === 'git') return {stdout: args[0] === 'rev-parse' ? sourceSha : ''};
    assert.equal(program, 'gh');
    const directory = args[args.indexOf('--dir') + 1], name = args[args.indexOf('--pattern') + 1];
    directories.push(directory);
    await writeFile(join(directory, name), files.get(name));
    return {stdout: ''};
  };
  return {client, run, fetcher, objects, writes, release, files, directories, setVersioning(value) { versionStatus = value; }};
}
async function withFixture(body) {
  const dir = await mkdtemp(join(tmpdir(), 'lingji-oss-test-')), fixtureData = fixture();
  const options = {...fixtureData, env: {...env}, receiptPath: join(dir, 'receipt.json')};
  try { await body(fixtureData, options); } finally { await rm(dir, {recursive: true, force: true}); }
}

test('OSS publication validates bytes, publishes the complete catalog last, and can retry without overwriting assets', () => withFixture(async (fixtureData, options) => {
  const receipt = await mirrorSiteDownloads(options);
  assert.equal(receipt.version, '0.3.29'); assert.equal(receipt.sourceSha, sourceSha);
  assert.equal(receipt.assets.length, 3);
  assert.deepEqual(JSON.parse(await readFile(options.receiptPath, 'utf8')), receipt);
  assert.equal(fixtureData.writes.at(-1), 'releases/current.json');
  assert.equal(fixtureData.objects.size, 4);
  await assert.rejects(readFile(join(fixtureData.directories[0], [...fixtureData.files.keys()][0])), {code: 'ENOENT'});
  await mirrorSiteDownloads(options);
  assert.equal(fixtureData.writes.filter(key => key !== 'releases/current.json').length, 3);
}));

test('wrong digests, incomplete releases, unverified sources, and missing STS cannot update the catalog', async () => {
  for (const change of [
    (f) => { f.release.assets[1].digest = 'sha256:' + '0'.repeat(64); },
    (f) => { f.release.assets.pop(); },
    (f) => { f.release.draft = true; },
    (f) => { f.release.body = 'unknown source'; },
    (f) => { f.release.body = '源码 SHA：`' + 'b'.repeat(40) + '`；工作流 SHA：`' + sourceSha + '`。'; },
    (_f, o) => { o.env.EXPECTED_RELEASE_SHA = 'b'.repeat(40); },
    (_f, o) => { delete o.env.ALIBABA_CLOUD_SECURITY_TOKEN; },
    (_f, o) => { o.env.GITHUB_REF = 'refs/pull/1/merge'; }
  ]) await withFixture(async (f, options) => {
    change(f, options); await assert.rejects(mirrorSiteDownloads(options));
    assert.equal(f.objects.has('releases/current.json'), false);
  });
});

test('network or public-read failure preserves the previous catalog', async () => {
  for (const failure of ['upload', 'acl', 'anonymous']) await withFixture(async (f, options) => {
    if (failure === 'upload') f.client.putStream = async () => { throw Object.assign(new Error('network failed'), {code: 'ConnectionError'}); };
    if (failure === 'acl') f.client.getACL = async () => ({acl: 'private'});
    if (failure === 'anonymous') options.fetcher = (url, options) => url.startsWith(downloadOrigin) ? new Response(null, {status: 403}) : f.fetcher(url, options);
    await assert.rejects(mirrorSiteDownloads(options));
    assert.equal(f.objects.has('releases/current.json'), false);
  });
});

test('existing changed bytes, unsafe bucket versioning, oversized catalog, and downgrades are rejected', async () => {
  for (const failure of ['bytes', 'Enabled', 'Suspended', 'catalog', 'downgrade', 'changed-version']) await withFixture(async (f, options) => {
    if (failure === 'bytes') {
      const asset = f.release.assets[0];
      f.objects.set('releases/v0.3.29/' + asset.name, {bytes: Buffer.alloc(asset.size), meta: {sha256: asset.digest.slice(7)}, acl: 'public-read'});
    } else if (['Enabled', 'Suspended'].includes(failure)) f.setVersioning(failure);
    else if (failure === 'catalog') f.objects.set('releases/current.json', {bytes: Buffer.alloc(65537)});
    else {
      const version = failure === 'downgrade' ? '0.3.30' : '0.3.29';
      const assets = f.release.assets.map(asset => ({name: asset.name.replace('0.3.29', version), size: asset.size, sha256: 'f'.repeat(64)}));
      f.objects.set('releases/current.json', {bytes: Buffer.from(JSON.stringify({version, assets})), acl: 'public-read'});
    }
    const before = f.objects.get('releases/current.json')?.bytes;
    await assert.rejects(mirrorSiteDownloads(options));
    assert.deepEqual(f.objects.get('releases/current.json')?.bytes, before);
  });
});
