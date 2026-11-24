import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ProxyAgent } from 'proxy-agent';
import { Agent, Dispatcher, buildConnector, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';

class ApplicationProxyAgent extends ProxyAgent {
  // Node clones globalAgent.constructor for agent:false; that clone must stay direct.
  constructor(options = {}) { super({ getProxyForUrl: () => '', ...options }); }
  // ProxyAgent delegates direct sockets to separate pools that its destroy() leaves open.
  destroy() { super.destroy(); this.httpAgent.destroy(); this.httpsAgent.destroy(); }
}

const execute = promisify(execFile);
const defaults = { mode: 'system', url: '', username: '', password: '' };
const file = root => join(root, 'network-proxy.json');
const localAddresses = new BlockList();
localAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
localAddresses.addAddress('::1', 'ipv6');
const loopback = host => { const address = host.replace(/^\[|\]$/g, ''); const family = isIP(address); return address === 'localhost' || address.endsWith('.localhost') || Boolean(family && localAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6')); };
const publicSettings = ({ password, ...value }) => ({ ...value, hasPassword: Boolean(password) });
const command = async (binary, args) => (await execute(binary, args, { timeout: 4000, maxBuffer: 128 * 1024, windowsHide: true })).stdout;

export async function readProxySettings(root) {
  try { return { ...defaults, ...JSON.parse(await readFile(file(root), 'utf8')) }; }
  catch (error) { if (error.code === 'ENOENT') return { ...defaults }; throw error; }
}
export async function proxySettings(root) { return publicSettings(await readProxySettings(root)); }

let activeAgent;
export const networkAgent = () => activeAgent;
const saves = new Map();
const settingReads = new Map();
export async function saveProxySettings(root, input) {
  const previous = saves.get(root) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    requireThat(input && typeof input === 'object' && !Array.isArray(input), 'invalid_proxy_config', 400);
    requireThat(input.clearPassword === undefined || typeof input.clearPassword === 'boolean', 'invalid_proxy_config', 400);
    requireThat(['system', 'manual', 'direct'].includes(input.mode), 'invalid_proxy_config', 400);
    for (const key of ['url', 'username', 'password']) requireThat(typeof input[key] === 'string' && input[key].length <= 2048 && !/[\r\n\0]/.test(input[key]), 'invalid_proxy_config', 400);
    const current = await readProxySettings(root);
    const next = { mode: input.mode, url: input.url.trim(), username: input.username.trim(), password: input.clearPassword ? '' : input.password };
    if (next.url) {
      let address; try { address = new URL(next.url); } catch { throw new DomainError('invalid_proxy_url', 400); }
      requireThat(['http:', 'https:', 'socks5:', 'socks5h:'].includes(address.protocol) && address.hostname && !address.username && !address.password && !address.search && !address.hash && ['/', ''].includes(address.pathname), 'invalid_proxy_url', 400);
      requireThat(!address.protocol.startsWith('socks') || address.port, 'invalid_proxy_url', 400);
      next.url = address.href;
    }
    requireThat(next.mode !== 'manual' || next.url, 'invalid_proxy_url', 400);
    if (!next.password && !input.clearPassword && next.url === current.url && next.username === current.username) next.password = current.password;
    const temporary = file(root) + '.' + randomUUID();
    try { await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, file(root)); settingReads.delete(root); }
    finally { await rm(temporary, { force: true }); }
    return publicSettings(next);
  });
  saves.set(root, operation);
  try { return await operation; } finally { if (saves.get(root) === operation) saves.delete(root); }
}

export function parseMacProxy(text) {
  const value = key => new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm').exec(text)?.[1];
  const address = (prefix, scheme) => value(prefix + 'Enable') === '1' && value(prefix + 'Proxy') && value(prefix + 'Port') ? `${scheme}://${value(prefix + 'Proxy')}:${value(prefix + 'Port')}` : '';
  return { http: address('HTTP', 'http'), https: address('HTTPS', 'http'), all: address('SOCKS', 'socks5h'), pac: value('ProxyAutoConfigEnable') === '1' ? value('ProxyAutoConfigURLString') : '', bypass: /ExceptionsList\s*:\s*<array>\s*{([^}]+)}/.exec(text)?.[1].split('\n').flatMap(line => /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line)?.[1] || []) || [], local: value('ExcludeSimpleHostnames') === '1', autodiscovery: value('ProxyAutoDiscoveryEnable') === '1' };
}
export function parseWindowsProxy(value) {
  const result = { bypass: String(value.ProxyOverride || '').split(';'), local: String(value.ProxyOverride || '').includes('<local>'), pac: value.AutoConfigURL || '' };
  if (!value.ProxyEnable || !value.ProxyServer) return result;
  const address = (text, socks = false) => text.includes('://') ? text : `${socks ? 'socks5h' : 'http'}://${text}`;
  if (!value.ProxyServer.includes('=')) result.http = result.https = address(value.ProxyServer);
  else for (const item of value.ProxyServer.split(';')) { const [scheme, target] = item.trim().split('='); if (target && ['http', 'https', 'socks'].includes(scheme)) result[scheme === 'socks' ? 'all' : scheme] = address(target, scheme === 'socks'); }
  return result;
}
export function parseLinuxProxy(text) {
  const value = (schema, key) => new RegExp(`^${schema.replaceAll('.', '\\.')} ${key} (.+)$`, 'm').exec(text)?.[1];
  const unquote = text => text?.replace(/^'(.*)'$/, '$1') || '';
  const mode = unquote(value('org.gnome.system.proxy', 'mode'));
  if (mode === 'none') return {};
  if (mode === 'auto') return { pac: unquote(value('org.gnome.system.proxy', 'autoconfig-url')) };
  const result = { bypass: [...(value('org.gnome.system.proxy', 'ignore-hosts') || '').matchAll(/'([^']+)'/g)].map(match => match[1]) };
  for (const scheme of ['http', 'https', 'socks']) {
    const host = unquote(value(`org.gnome.system.proxy.${scheme}`, 'host')), port = value(`org.gnome.system.proxy.${scheme}`, 'port');
    if (host && /^\d+$/.test(port) && Number(port) > 0) result[scheme === 'socks' ? 'all' : scheme] = `${scheme === 'socks' ? 'socks5h' : 'http'}://${host}:${port}`;
  }
  if (value('org.gnome.system.proxy', 'use-same-proxy') === 'true') result.https = result.http;
  return result;
}
// shortcut: WPAD and non-GNOME desktop discovery require native resolvers; use a manual address there.
async function systemProxy(env) {
  const inherited = { http: env.http_proxy || env.HTTP_PROXY, https: env.https_proxy || env.HTTPS_PROXY, all: env.all_proxy || env.ALL_PROXY, bypass: (env.no_proxy || env.NO_PROXY || '').split(',') };
  if (inherited.http || inherited.https || inherited.all) return inherited;
  try {
    if (process.platform === 'darwin') return parseMacProxy(await command('/usr/sbin/scutil', ['--proxy']));
    if (process.platform === 'win32') return parseWindowsProxy(JSON.parse(await command(join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL | ConvertTo-Json -Compress"])));
    if (process.platform === 'linux') return parseLinuxProxy(await command('gsettings', ['list-recursively', 'org.gnome.system.proxy']));
  } catch (error) { if (process.platform !== 'linux' || !['ENOENT', 1].includes(error.code)) throw new DomainError('system_proxy_unavailable', 503); }
  return {};
}
export function bypassProxy(url, settings) {
  if (loopback(url.hostname)) return true;
  if (settings.local && !isIP(url.hostname) && !url.hostname.includes('.')) return true;
  return (settings.bypass || []).some(value => {
    let host = value.trim().toLowerCase();
    if (!host || host === '<local>') return false;
    if (host === '*') return true;
    if (host === url.host.toLowerCase() || host === url.hostname.toLowerCase()) return true;
    if (host.startsWith('*.')) host = host.slice(1);
    return host.startsWith('.') && (url.hostname.endsWith(host) || url.hostname === host.slice(1));
  });
}

export function createProxyResolver(root, { env = process.env, readSystem = () => systemProxy(env) } = {}) {
  let system, expires = 0, pendingSystem;
  return async value => {
    const url = new URL(value);
    if (loopback(url.hostname)) return '';
    let entry = settingReads.get(root);
    if (!entry || Date.now() >= entry.expires) {
      entry = { expires: Date.now() + 1000, value: readProxySettings(root) };
      if (settingReads.size >= 16) settingReads.delete(settingReads.keys().next().value);
      settingReads.set(root, entry);
    }
    const settings = await entry.value;
    if (settings.mode === 'direct') return '';
    if (settings.mode === 'manual') {
      const proxy = new URL(settings.url);
      if (proxy.protocol === 'socks5:') proxy.protocol = 'socks5h:';
      proxy.username = settings.username; proxy.password = settings.password;
      return proxy.href;
    }
    if (Date.now() >= expires) { pendingSystem ||= Promise.resolve().then(readSystem).finally(() => { pendingSystem = undefined; }); system = await pendingSystem; expires = Date.now() + 15000; }
    if (bypassProxy(url, system)) return '';
    if (system.pac) { const pac = new URL(system.pac); requireThat(['http:', 'https:', 'file:'].includes(pac.protocol), 'system_proxy_unavailable', 503); return 'pac+' + pac.href; }
    requireThat(!system.autodiscovery, 'system_proxy_autodiscovery_unsupported', 503);
    const proxy = system[url.protocol === 'https:' || url.protocol === 'wss:' ? 'https' : 'http'] || system.all || '';
    return proxy && !proxy.includes('://') ? 'http://' + proxy : proxy;
  };
}

// Always select the CONNECT agent; native updater tunnels carry their own TLS.
async function tunnel(agent, target, secureEndpoint) {
  const url = new URL(target), req = new EventEmitter();
  req.path = url.pathname + url.search;
  req.getHeader = name => name === 'host' ? url.host : undefined;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const options = { host, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), servername: isIP(host) ? undefined : host, secureEndpoint };
  const selected = await agent.connect(req, { ...options, secureEndpoint: true });
  if (selected.getResolver) {
    const result = String(await (await selected.getResolver())(url.href));
    for (const entry of result.split(';')) {
      const [kind, address] = entry.trim().split(/\s+/);
      const route = kind === 'DIRECT' ? '' : ({ PROXY: 'http', HTTP: 'http', HTTPS: 'https', SOCKS: 'socks5h', SOCKS5: 'socks5h', SOCKS4: 'socks4a' })[kind];
      if (route === undefined) continue;
      const next = new ApplicationProxyAgent({ agent: false, getProxyForUrl: () => route ? `${route}://${address}` : '' });
      try { const socket = await tunnel(next, target, secureEndpoint); socket.once('close', () => next.destroy()); return socket; } catch { next.destroy(); /* PAC explicitly defines failover order. */ }
    }
    throw new Error('proxy_connection_failed');
  }
  if (selected.connect) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    const connection = new selected.constructor(await agent.getProxyForUrl(url.href), { signal: controller.signal, timeout: 15000 });
    let rejected = false;
    req.on('proxyConnect', response => { if (response.statusCode !== 200) rejected = true; });
    try {
      const socket = await connection.connect(req, options);
      if (rejected) { socket.destroy(); throw new Error('proxy_connection_failed'); }
      socket.setTimeout(0); socket.once('close', () => connection.destroy());
      return socket;
    } catch (error) { connection.destroy(); throw error; }
    finally { clearTimeout(timeout); }
  }
  return new Promise((resolve, reject) => buildConnector({})( { hostname: options.host, port: String(options.port), protocol: secureEndpoint ? 'https:' : 'http:', servername: options.servername }, (error, socket) => error ? reject(error) : resolve(socket)));
}

export function createProxyDispatcher(resolveProxy) {
  // An owned DIRECT agent also closes unfinished PAC downloads during shutdown.
  const directAgent = new ApplicationProxyAgent({ getProxyForUrl: () => '' });
  const agents = new Map();
  let closed = false;
  return new class extends Dispatcher {
    dispatch(options, handler) {
      const target = new URL(options.path, options.origin).href;
      Promise.resolve(resolveProxy(target)).then(proxy => {
        if (closed) throw new Error('proxy_closed');
        const key = proxy.startsWith('pac+') ? proxy + '\n' + target : proxy;
        let entry = agents.get(key);
        if (!entry) {
          const routing = new ApplicationProxyAgent({ agent: directAgent, getProxyForUrl: () => proxy });
          const agent = new Agent({ connect: (options, callback) => {
            const origin = `${options.protocol}//${options.hostname.includes(':') ? `[${options.hostname}]` : options.hostname}:${options.port}`;
            tunnel(routing, proxy.startsWith('pac+') ? target : origin, options.protocol === 'https:').then(socket => callback(null, socket), () => callback(new Error('proxy_connection_failed'), null));
          } });
          if (agents.size >= 8) { const [oldKey, old] = agents.entries().next().value; agents.delete(oldKey); void old.agent.close().finally(() => old.routing.destroy()).catch(() => {}); }
          entry = { agent, routing };
          agents.set(key, entry);
        }
        entry.agent.dispatch(options, handler);
      }).catch(() => handler.onError(new Error('proxy_connection_failed')));
      return true;
    }
    async close() { closed = true; try { await Promise.all([...agents.values()].map(async ({agent,routing}) => { try { await agent.close(); } finally { routing.destroy(); } })); } finally { directAgent.destroy(); } }
    async destroy(error) { closed = true; directAgent.destroy(); await Promise.all([...agents.values()].map(async ({agent,routing}) => { try { await agent.destroy(error); } finally { routing.destroy(); } })); }
  }();
}

export function installNetworkProxy(root) {
  const directAgent = new ApplicationProxyAgent({ getProxyForUrl: () => '' });
  const resolveProxy = createProxyResolver(root), agent = new ApplicationProxyAgent({ agent: directAgent, getProxyForUrl: resolveProxy, keepAlive: true });
  const previous = { http: http.globalAgent, https: https.globalAgent, dispatcher: getGlobalDispatcher() };
  const dispatcher = createProxyDispatcher(resolveProxy);
  const previousAgent = activeAgent;
  activeAgent = agent;
  http.globalAgent = https.globalAgent = agent;
  setGlobalDispatcher(dispatcher);
  return {
    async close() { activeAgent = previousAgent; http.globalAgent = previous.http; https.globalAgent = previous.https; setGlobalDispatcher(previous.dispatcher); directAgent.destroy(); agent.destroy(); await dispatcher.destroy(); },
    attachNativeTunnel(server, secret) {
      const expected = Buffer.from('Basic ' + Buffer.from('lingji:' + secret).toString('base64'));
      const sockets = new Set();
      const connect = async (request, socket, head) => {
        const authorization = Buffer.from(request.headers['proxy-authorization'] || '');
        if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n'); return; }
        sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
        socket.setTimeout(20000, () => socket.destroy());
        try {
          const target = new URL('https://' + request.url);
          requireThat(Number(target.port || 443) > 0 && !target.username && !target.password && request.url === target.host + (target.port ? '' : ':443'), 'invalid_proxy_target', 400);
          const upstream = await tunnel(agent, target.href, false);
          if (socket.destroyed) { upstream.destroy(); return; }
          sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream)); upstream.on('error', () => socket.destroy());
          socket.once('close', () => upstream.destroy()); socket.setTimeout(0);
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        } catch { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }
      };
      server.on('connect', connect);
      return () => { server.off('connect', connect); for (const socket of sockets) socket.destroy(); };
    }
  };
}
