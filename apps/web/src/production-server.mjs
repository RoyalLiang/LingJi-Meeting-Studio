import {sendHttpPayload} from '../../../services/records/src/http-response.mjs';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const defaultRoot = fileURLToPath(new URL('../dist/', import.meta.url));
export function createProductionServer({ root = defaultRoot, apiUrl = process.env.RECORD_API_URL || 'http://127.0.0.1:3030' } = {}) {
const target = new URL(apiUrl);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
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
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname); let file = resolve(root, `.${pathname}`);
    if (!file.startsWith(resolve(root) + '/') && file !== resolve(root)) { res.writeHead(403); res.end(); return; }
    if (!(await stat(file).catch(() => null))?.isFile()) {
      if (extname(pathname)) { res.writeHead(404); res.end(); return; } file = resolve(root, 'index.html');
    }
    await sendHttpPayload(res,200,await content(file), { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cache-Control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
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
