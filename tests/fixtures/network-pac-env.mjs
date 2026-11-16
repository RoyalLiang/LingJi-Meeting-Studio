import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { once } from 'node:events';
import { installNetworkProxy } from '../../services/records/src/network-proxy.mjs';

const root = process.argv[2];
assert.ok(root);
const servers = [], sockets = new Set();
let network, pacHits = 0;
async function listen(server) {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
try {
  const originPort = await listen(http.createServer((_, response) => response.end('origin-ok')));
  const proxy = http.createServer((_, response) => response.end('proxy-ok'));
  proxy.on('connect', (_, client, head) => {
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const pacPort = await listen(http.createServer((_, response) => {
    pacHits++;
    response.end('function FindProxyForURL(){return "PROXY 127.0.0.1:' + proxyPort + '";}');
  }));
  // A DNS stub keeps the PAC URL non-loopback without changing host DNS or reaching the network.
  const lookup = dns.lookup;
  dns.lookup = (hostname, options, callback) => {
    if (!['pac.fixture.invalid', 'origin.fixture.invalid'].includes(hostname)) return lookup(hostname, options, callback);
    queueMicrotask(() => options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4));
  };
  for (const key of Object.keys(process.env)) if (/^(?:https?|all|no)_proxy$/i.test(key)) delete process.env[key];
  process.env.ALL_PROXY = 'pac+http://pac.fixture.invalid:' + pacPort + '/proxy.pac';
  network = installNetworkProxy(root);
  const core = await new Promise((resolve, reject) => {
    http.get('http://198.51.100.10/audit', response => {
      let body = ''; response.on('data', bytes => body += bytes);
      response.on('end', () => resolve(body)); response.on('error', reject);
    }).on('error', reject);
  });
  assert.equal(core, 'proxy-ok');
  assert.equal(await (await fetch('http://198.51.100.10/audit')).text(), 'origin-ok');
  assert.equal(pacHits, 2);
  const direct = await new Promise((resolve, reject) => {
    http.get('http://origin.fixture.invalid:' + originPort + '/direct', { agent: false }, response => {
      let body = ''; response.on('data', bytes => body += bytes);
      response.on('end', () => resolve(body)); response.on('error', reject);
    }).on('error', reject);
  });
  assert.equal(direct, 'origin-ok');
  await network.close(); network = undefined;
  let started, closed;
  const pendingStarted = new Promise(resolve => started = resolve), pendingClosed = new Promise(resolve => closed = resolve);
  const stalledPort = await listen(http.createServer((request, response) => {
    request.socket.once('close', closed);
    response.write('function FindProxyForURL() {');
    started();
  }));
  process.env.ALL_PROXY = 'pac+http://pac.fixture.invalid:' + stalledPort + '/proxy.pac';
  network = installNetworkProxy(root);
  const pending = http.get('http://198.51.100.10/audit');
  pending.on('error', () => {});
  await pendingStarted;
  await network.close(); network = undefined;
  await pendingClosed;
  pending.destroy();
  console.log(JSON.stringify({ core: true, fetch: true, pacHits, explicitDirect: true, pendingPacClosed: true }));
} finally {
  await network?.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
