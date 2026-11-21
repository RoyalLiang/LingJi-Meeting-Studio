import {sendHttpPayload} from '../../../services/records/src/http-response.mjs';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const defaultRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const mobileUpgrade = Buffer.from(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>更新聆记 App</title><style>
:root{color-scheme:light dark}body{margin:0;font:1rem/1.65 system-ui,sans-serif}
main{max-width:28rem;margin:18vh auto 0;padding:1.5rem}h1{font-size:1.5rem;line-height:1.35}
</style></head><body><main id="root"><h1>请更新聆记 App</h1>
<p>手机录音已移到新版 Android App。请从原安装渠道获取新版 APK，直接覆盖安装，保留本机录音。</p>
</main></body></html>`);
const retireMobileWorker = Buffer.from(`
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith('lingji-quick-record-')).map(key => caches.delete(key)));
  await self.clients.claim();
  await self.registration.unregister();
})()));
`);

export function createProductionServer({ root = defaultRoot, apiUrl = process.env.RECORD_API_URL || 'http://127.0.0.1:3030' } = {}) {
const target = new URL(apiUrl);
  const syncHost = process.env.RECORD_SYNC_ORIGIN ? new URL(process.env.RECORD_SYNC_ORIGIN).host : null;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const files=new Map();let fileBytes=0;
async function content(file){
  const info=await stat(file),key=`${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`,cached=files.get(file);
  if(cached?.key===key){files.delete(file);files.set(file,cached);return cached.body;}
  if(cached){files.delete(file);fileBytes-=cached.body.length;}
  const body=await readFile(file);
  if(body.length<=16*1024*1024){while(files.size>=64||fileBytes+body.length>16*1024*1024){const first=files.keys().next().value;fileBytes-=files.get(first).body.length;files.delete(first);}files.set(file,{key,body});fileBytes+=body.length;}
  return body;
}
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const upstream = http.request(new URL(req.url, target), { method: req.method, headers: { ...req.headers, 'x-record-client-ip': req.socket.remoteAddress } }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    }); upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":"service_unavailable"}'); });
    req.pipe(upstream); res.on('close', () => upstream.destroy()); return;
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (/^\/(?:quick-record|mobile-app)\/?$/.test(pathname) || pathname === '/quick-record-sw.js') {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      const worker = pathname === '/quick-record-sw.js';
      await sendHttpPayload(res, 200, worker ? retireMobileWorker : mobileUpgrade, {
        'Content-Type': worker ? mime['.js'] : mime['.html'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        ...(worker ? {} : { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" }),
      });
      return;
    }
    let file = resolve(root, `.${pathname}`);
    if (!file.startsWith(resolve(root) + '/') && file !== resolve(root)) { res.writeHead(403); res.end(); return; }
    if (!(await stat(file).catch(() => null))?.isFile()) {
      if (extname(pathname)) { res.writeHead(404); res.end(); return; } file = resolve(root, 'index.html');
    }
    await sendHttpPayload(res,200,await content(file), { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cache-Control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'${syncHost && (!req.headers.host || req.headers.host === syncHost) ? " 'wasm-unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`,
      'Permissions-Policy': 'microphone=(self), display-capture=(self), camera=()' });
  } catch { res.writeHead(500); res.end('Unable to load application'); }
});
return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createProductionServer();
  server.listen(Number(process.env.WEB_PORT || 3000), '127.0.0.1', () => console.log('[web] http://127.0.0.1:' + (process.env.WEB_PORT || 3000)));
  process.once('SIGTERM', () => server.close());
}
