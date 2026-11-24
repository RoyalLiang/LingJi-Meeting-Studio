import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const dist = new URL('../web/dist-ios/', import.meta.url);
const read = name => readFile(new URL(name, dist), 'utf8');
const theme = await readFile(new URL('../web/public/mobile-theme.js', import.meta.url), 'utf8');
let html = await read('mobile-app.html');
const scriptTag = /<script type="module"[^>]* src="\/(assets\/[^"]+)"[^>]*><\/script>/;
const styleTag = /<link rel="stylesheet"[^>]* href="\/(assets\/[^"]+)"[^>]*>/;
const module = (await read(html.match(scriptTag)?.[1] ?? '')).replace(/<\/script/gi, '<\\/script');
const css = await read(html.match(styleTag)?.[1] ?? '');
assert.ok(!/<\/script/i.test(theme) && !/<\/style/i.test(css));
const hash = script => "'sha256-" + createHash('sha256').update(script).digest('base64') + "'";
const policy = [
  "default-src 'none'",
  "script-src " + hash(theme) + " " + hash(module) + " 'wasm-unsafe-eval' blob:",
  "style-src 'unsafe-inline'", "connect-src 'self'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "media-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
].join('; ');
html = html
  .replace('<meta charset="UTF-8">', () => '<meta charset="UTF-8">\n  <meta http-equiv="Content-Security-Policy" content="' + policy + '">')
  .replace('<script src="/mobile-theme.js"></script>', () => '<script>' + theme + '</script>')
  .replace(/<link rel="icon"[^>]*>/, '')
  .replace(scriptTag, () => '<script type="module">' + module + '</script>')
  .replace(styleTag, () => '<style>' + css + '</style>');
assert.ok(!/<script[^>]*\bsrc=|<link[^>]*rel="stylesheet"/i.test(html));
const generated = new URL('Generated/', import.meta.url);
await mkdir(generated, { recursive: true });
await writeFile(new URL('mobile.html', generated), html);
