import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {downloadBase, downloadManifest, downloadRoute, microsoftStoreListing} from '../apps/site/src/downloads.mjs';

const assets = ['macos-arm64.dmg', 'windows-x64-setup.exe', 'linux-amd64.deb'].map(suffix => ({name: `Lingji-0.3.29-${suffix}`, size: 10, sha256: 'a'.repeat(64)}));
const manifest = {version: '0.3.29', assets}, env = {DOWNLOADS_BASE_URL: 'https://downloads.example.test/lingji/'};
const url = 'https://rookiecode.com/downloads/v0.3.29/Lingji-0.3.29-windows-x64-setup.exe';
const request = (headers = {}, method = 'GET') => new Request(url, {headers, method});

test('native Workers fetch accepts download options and never follows upstream redirects', async t => {
  const result = await build({stdin: {contents: `import {downloadRoute} from './apps/site/src/downloads.mjs'; export default {fetch(request){return downloadRoute(request,${JSON.stringify(env)});}};`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'native-download-test.mjs'}, bundle: true, write: false, format: 'esm', platform: 'browser'});
  let redirects = false;
  const calls = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-10-29', outboundService: async upstream => {
    calls.push(upstream.url);
    assert.equal(new URL(upstream.url).hostname, 'downloads.example.test');
    assert.equal(upstream.headers.get('cookie'), null);
    assert.equal(upstream.headers.get('authorization'), null);
    if (redirects) return new Response(null, {status: 302, headers: {Location: 'https://github.com/must-not-be-requested'}});
    if (new URL(upstream.url).pathname.endsWith('/current.json')) return Response.json(manifest);
    const headers = {'Content-Type': 'application/octet-stream', 'Content-Length': '10'};
    if (upstream.headers.get('range') === 'bytes=2-5') return new Response('2345', {status: 206, headers: {...headers, 'Content-Length': '4', 'Content-Range': 'bytes 2-5/10'}});
    return new Response(upstream.method === 'HEAD' ? null : '0123456789', {headers});
  }}));
  t.after(() => runtime.dispose());
  const catalog = await runtime.dispatchFetch('https://rookiecode.com/api/downloads');
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), downloadManifest(manifest));
  const file = await runtime.dispatchFetch(url, {headers: {Range: 'bytes=2-5', Cookie: 'private', Authorization: 'Bearer private'}});
  assert.equal(file.status, 206);
  assert.equal(file.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await file.text(), '2345');
  const head = await runtime.dispatchFetch(url, {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  redirects = true;
  const before = calls.length;
  assert.equal((await runtime.dispatchFetch('https://rookiecode.com/api/downloads')).status, 503);
  assert.equal((await runtime.dispatchFetch(url)).status, 502);
  assert.equal(calls.length, before + 2);
});

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
    assert.equal(options.redirect, 'manual');
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


test('Store downloads stay hidden until the published product version matches the direct-download catalog', async () => {
  const config = {MICROSOFT_STORE_ID: '9TESTMSIX001', MICROSOFT_STORE_PUBLISHED_VERSION: '0.3.29'};
  assert.equal(microsoftStoreListing({}), null);
  assert.equal(microsoftStoreListing({MICROSOFT_STORE_ID: config.MICROSOFT_STORE_ID}), null);
  assert.equal(microsoftStoreListing(config, '0.3.30'), null);
  assert.throws(() => microsoftStoreListing({...config, MICROSOFT_STORE_ID: 'https://example.test'}));
  const listing = microsoftStoreListing(config, manifest.version);
  assert.equal(listing.href, 'https://apps.microsoft.com/detail/9TESTMSIX001?mode=direct');
  for (const extra of [{MICROSOFT_STORE_ID: config.MICROSOFT_STORE_ID}, config, {...config, MICROSOFT_STORE_PUBLISHED_VERSION: '0.3.28'}]) {
    const response = await downloadRoute(new Request('https://rookiecode.com/api/downloads'), {...env, ...extra}, async () => Response.json(manifest));
    const catalog = await response.json();
    assert.deepEqual(catalog.assets, downloadManifest(manifest).assets);
    assert.deepEqual(catalog.windowsStore, extra === config ? listing : undefined);
  }
});

async function downloadPage(catalog) {
  let finish;
  const done = new Promise(resolve => {finish = resolve;});
  const status = {set textContent(value) {finish(value);}};
  const tabs = ['macos','windows','linux'].map(platform => ({dataset:{downloadPlatform:platform},setAttribute(){},addEventListener(){}}));
  const panels = tabs.map(tab => {
    const attrs = {'aria-disabled':'true',tabindex:'-1'};
    const link = {download:'',setAttribute(name,value){attrs[name]=value;},removeAttribute(name){delete attrs[name];if(name==='download')this.download='';}};
    const size = {}, requirements = {}, standalone = {hidden:true};
    return {dataset:{downloadPanel:tab.dataset.downloadPlatform},link,size,requirements,standalone,attrs,querySelector(selector){return selector==='a[data-installer]'?link:selector==='[data-file-size]'?size:selector==='[data-system-requirements]'?requirements:selector==='[data-standalone-installer]'?standalone:null;}};
  });
  const elements = {'#download-status':status,'#download-device':{},'#download-version':{}};
  const source = await readFile(new URL('../apps/site/public/downloads.js', import.meta.url), 'utf8');
  runInNewContext(source.replace('export function', 'function'), {document:{querySelectorAll:selector=>selector==='[data-download-platform]'?tabs:selector==='[data-download-panel]'?panels:[],querySelector:selector=>elements[selector]},navigator:{platform:'Win32'},AbortSignal,fetch:async()=>({ok:true,json:async()=>catalog})});
  return {status:await done,panels};
}

test('download page enables all three installers and changes only Windows to a verified Store entry', async () => {
  const catalog = downloadManifest(manifest);
  const direct = await downloadPage(catalog);
  assert.equal(direct.status, '');
  assert.ok(direct.panels.every(panel => panel.link.href.startsWith('/downloads/') && !panel.attrs['aria-disabled']));
  const windowsStore = microsoftStoreListing({MICROSOFT_STORE_ID:'9TESTMSIX001',MICROSOFT_STORE_PUBLISHED_VERSION:manifest.version});
  const store = await downloadPage({...catalog,windowsStore});
  assert.equal(store.status, '');
  assert.equal(store.panels[1].link.href, windowsStore.href);
  assert.equal(store.panels[1].link.download, '');
  assert.equal(store.panels[1].size.textContent, '');
  assert.equal(direct.panels[1].standalone.hidden, true);
  assert.equal(store.panels[1].standalone.hidden, false);
  assert.equal(store.panels[1].standalone.href, direct.panels[1].link.href);
  assert.ok(store.panels[0].link.href.endsWith('.dmg') && store.panels[2].link.href.endsWith('.deb'));
  const invalid = await downloadPage({...catalog,windowsStore:{...windowsStore,href:'https://example.test/installer.exe'}});
  assert.match(invalid.status, /暂不可用/);
  assert.ok(invalid.panels.every(panel => !panel.link.href));
});
