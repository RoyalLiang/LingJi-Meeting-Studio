const platforms = {macos: 'macos-arm64.dmg', windows: 'windows-x64-setup.exe', linux: 'linux-amd64.deb'};
const failure = (status, error) => Response.json({error}, {status, headers: {'Cache-Control': 'no-store'}});

export function downloadBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname.includes('.') || /(^|\.)(github\.com|githubusercontent\.com|localhost)$/i.test(url.hostname)) throw new Error('invalid_download_origin');
  return url.href.replace(/\/$/, '') + '/';
}

export function downloadManifest(input) {
  if (!input || !/^\d+\.\d+\.\d+$/.test(input.version) || !Array.isArray(input.assets)) throw new Error('invalid_download_manifest');
  const assets = Object.entries(platforms).map(([platform, suffix]) => {
    const name = `Lingji-${input.version}-${suffix}`, asset = input.assets.find(item => item.name === name);
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 5 * 1024 ** 3) throw new Error('invalid_download_asset');
    return {platform, name, size: asset.size, sha256: asset.sha256, href: `/downloads/v${input.version}/${name}`};
  });
  return {version: input.version, assets};
}

export async function downloadRoute(request, env, fetcher = fetch) {
  const path = new URL(request.url).pathname;
  if (path !== '/api/downloads' && !path.startsWith('/downloads/')) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'method_not_allowed');
  if (!env.DOWNLOADS_BASE_URL) return failure(503, 'downloads_not_configured');
  try {
    const base = downloadBase(env.DOWNLOADS_BASE_URL);
    if (path === '/api/downloads') {
      const response = await fetcher(base + 'current.json', {redirect: 'manual', signal: AbortSignal.timeout(15000)});
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return failure(503, 'downloads_not_ready');
      }
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        for (;;) {
          const {value, done} = await reader.read(); if (done) break;
          length += value.byteLength; if (length > 65536) throw new Error('catalog_too_large'); chunks.push(value);
        }
      } finally {await reader.cancel().catch(() => {});}
      const data = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) {data.set(chunk, offset); offset += chunk.byteLength;}
      const manifest = downloadManifest(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(data)));
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(manifest), {headers: {'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff'}});
    }
    const match = path.match(/^\/downloads\/v(\d+\.\d+\.\d+)\/(Lingji-(\d+\.\d+\.\d+)-(macos-arm64\.dmg|windows-x64-setup\.exe|linux-amd64\.deb))$/);
    if (!match || match[1] !== match[3]) return failure(404, 'download_not_found');
    const forwarded = new Headers({'Accept-Encoding': 'identity'});
    for (const header of ['range', 'if-range', 'if-none-match', 'if-modified-since']) if (request.headers.has(header)) forwarded.set(header, request.headers.get(header));
    const response = await fetcher(`${base}v${match[1]}/${match[2]}`, {method: request.method, headers: forwarded, redirect: 'manual', signal: request.signal});
    if (![200, 206, 304, 416].includes(response.status)) {await response.body?.cancel(); return failure(response.status === 404 ? 404 : 502, 'download_unavailable');}
    if (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') {await response.body?.cancel(); return failure(502, 'download_encoded_response');}
    if (/text\/html|application\/json/i.test(response.headers.get('content-type') || '')) {await response.body?.cancel(); return failure(502, 'download_invalid_response');}
    const headers = new Headers({'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${match[2]}"`, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff'});
    if (response.status === 416) headers.set('Cache-Control', 'no-store');
    for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (response.headers.has(header)) headers.set(header, response.headers.get(header));
    let body = request.method === 'HEAD' ? null : response.body;
    const length = Number(response.headers.get('content-length'));
    if (body && response.headers.has('content-length') && Number.isSafeInteger(length) && length >= 0 && typeof globalThis.FixedLengthStream === 'function') {
      const fixed = new globalThis.FixedLengthStream(length);
      // The readable reports truncated/oversized transfers to the browser.
      void body.pipeTo(fixed.writable).catch(() => {});
      body = fixed.readable;
    }
    return new Response(body, {status: response.status, headers});
  } catch {return failure(503, 'download_unavailable');}
}
