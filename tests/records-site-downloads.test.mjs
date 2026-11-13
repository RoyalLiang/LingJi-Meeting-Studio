import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {downloadBase, downloadManifest, downloadRoute} from '../apps/site/src/downloads.mjs';

const assets = ['macos-arm64.dmg', 'windows-x64-setup.exe', 'linux-amd64.deb'].map(suffix => ({name: `Lingji-0.3.29-${suffix}`, size: 10, sha256: 'a'.repeat(64)}));
const manifest = {version: '0.3.29', assets}, env = {DOWNLOADS_BASE_URL: 'https://downloads.example.test/lingji/'};
const url = 'https://rookiecode.com/downloads/v0.3.29/Lingji-0.3.29-windows-x64-setup.exe';
const request = (headers = {}, method = 'GET') => new Request(url, {headers, method});

test('download catalog allows only complete, exact versioned desktop installers', () => {
  const catalog = downloadManifest(manifest);
  assert.equal(catalog.assets.length, 3); assert.equal(catalog.assets[1].href, new URL(url).pathname);
  for (const input of [{...manifest, version: '../29'}, {...manifest, assets: assets.slice(1)}, {...manifest, assets: assets.map(asset => ({...asset, sha256: 'bad'}))}]) assert.throws(() => downloadManifest(input));
  assert.equal(downloadBase(env.DOWNLOADS_BASE_URL), env.DOWNLOADS_BASE_URL);
  for (const base of ['http://example.test/', 'https://github.com/releases/', 'https://release-assets.githubusercontent.com/', 'https://user:password@example.test/', 'https://example.test/?secret=value', 'https://localhost/']) assert.throws(() => downloadBase(base));
});

test('CDN downloads stream as browser attachments and preserve range and cache responses', async () => {
  const bytes = new TextEncoder().encode('0123456789'), calls = [];
  const fetcher = async (href, options) => {
    calls.push({href, options});
    assert.equal(href, env.DOWNLOADS_BASE_URL + 'v0.3.29/Lingji-0.3.29-windows-x64-setup.exe');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.get('accept-encoding'), 'identity');
    const headers = {'Content-Type': 'application/octet-stream', ETag: '"versioned"', 'Accept-Ranges': 'bytes'};
    if (options.headers.has('if-none-match')) return new Response(null, {status: 304, headers});
    if (options.headers.get('range') === 'bytes=99-') return new Response(null, {status: 416, headers: {...headers, 'Content-Range': 'bytes */10'}});
    if (options.headers.get('range') === 'bytes=2-5') return new Response(bytes.slice(2, 6), {status: 206, headers: {...headers, 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4'}});
    return new Response(options.method === 'HEAD' ? null : bytes, {headers: {...headers, 'Content-Length': '10'}});
  };
  let response = await downloadRoute(request(), env, fetcher);
  assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="Lingji-0\.3\.29-windows-x64-setup\.exe"/); assert.equal(response.headers.get('location'), null);
  response = await downloadRoute(request({range: 'bytes=2-5', 'if-range': '"versioned"'}), env, fetcher);
  assert.equal(response.status, 206); assert.equal(await response.text(), '2345'); assert.equal(response.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(response.headers.get('content-length'), '4'); assert.equal(calls.at(-1).options.headers.get('if-range'), '"versioned"');
  response = await downloadRoute(request({range: 'bytes=99-'}), env, fetcher); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */10'); assert.equal(response.headers.get('cache-control'), 'no-store');
  response = await downloadRoute(request({'if-none-match': '"versioned"'}), env, fetcher); assert.equal(response.status, 304);
  response = await downloadRoute(request({}, 'HEAD'), env, fetcher); assert.equal(response.status, 200); assert.equal(await response.text(), ''); assert.equal(calls.at(-1).options.method, 'HEAD');
});

test('catalog size, upstream errors, wrong filenames and missing configuration fail closed', async () => {
  let calls = 0; const catalogRequest = new Request('https://rookiecode.com/api/downloads');
  const fetcher = async () => {calls++; return Response.json(manifest);};
  assert.equal((await downloadRoute(request(), {}, fetcher)).status, 503);
  assert.equal((await downloadRoute(request({}, 'POST'), env, fetcher)).status, 405);
  assert.equal((await downloadRoute(new Request(url.replace('v0.3.29', 'v0.3.28')), env, fetcher)).status, 404); assert.equal(calls, 0);
  const valid = await downloadRoute(catalogRequest, env, fetcher); assert.equal(valid.status, 200); assert.deepEqual(await valid.json(), downloadManifest(manifest));
  for (const upstream of [new Response('x'.repeat(65537)), Response.json({...manifest, assets: []}), new Response('bad', {status: 503}), new Response(new Uint8Array([255]))]) {
    const response = await downloadRoute(catalogRequest, env, async () => upstream); assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await downloadRoute(request(), env, async () => new Response('<html>error</html>', {headers: {'Content-Type': 'text/html'}}))).status, 502);
  assert.equal((await downloadRoute(request(), env, async () => new Response(null, {status: 302, headers: {Location: 'https://github.com/asset'}}))).status, 502);
  assert.equal((await downloadRoute(request(), env, async () => new Response('encoded', {headers: {'Content-Encoding': 'gzip'}}))).status, 502);
  assert.equal((await downloadRoute(request(), env, async () => {throw new Error('offline');})).status, 503);
});

test('system selection distinguishes desktops, iOS desktop mode and mobile devices', async () => {
  const source = await readFile(new URL('../apps/site/public/downloads.js', import.meta.url), 'utf8');
  const detect = runInNewContext(source.replace('export function platformFor', 'function platformFor') + '\nplatformFor', {document: {querySelectorAll: () => [], querySelector: () => null}, navigator: {}});
  assert.equal(detect({platform: 'Win32'}), 'windows'); assert.equal(detect({userAgentData: {platform: 'macOS'}}), 'macos'); assert.equal(detect({platform: 'Linux x86_64'}), 'linux');
  assert.equal(detect({userAgent: 'Android Linux'}), null); assert.equal(detect({platform: 'MacIntel', maxTouchPoints: 5}), null); assert.equal(detect({userAgent: 'iPhone'}), null); assert.equal(detect({}), null);
});
