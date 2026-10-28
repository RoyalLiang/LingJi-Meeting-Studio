import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordServer } from '../services/records/src/server.mjs';
import { digest } from '../packages/records/src/record.mjs';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { releaseTargets, releaseVersion, buildUpdateManifest, hash } from '../scripts/client-release-contract.mjs';

test('release contract requires all signed targets, immutable tag URLs and matching source/hash/version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-release-contract-'));
  const tag = 'client-v1.2.0', commit = 'a'.repeat(40), groups = [];
  try {
    for (const target of releaseTargets) {
      const directory = join(root, target.key); await mkdir(directory);
      const extension = target.format === 'app' ? '.app.tar.gz' : target.format === 'nsis' ? '-setup.exe' : '.AppImage';
      const name = `Lingji-1.2.0-${target.key}${extension}`;
      const signature = Buffer.from('untrusted comment: fixture\nfixture\ntrusted comment: timestamp:0\tversion:1.2.0\nfixture\n').toString('base64');
      const metadata = { key: target.key, tag, commit, version: '1.2.0', osSignatureVerified: true, files: [] };
      for (const [file, role, bytes] of [[name, 'updater', Buffer.from(target.key)], [`${name}.sig`, 'signature', Buffer.from(signature)],
        ...(target.format === 'app' ? [[`Lingji-1.2.0-${target.key}.dmg`, 'installer', Buffer.from('fixture dmg')]] : [])]) {
        await writeFile(join(directory, file), bytes); metadata.files.push({ name: file, role, bytes: bytes.length, sha256: hash(bytes) });
      }
      groups.push({ directory, metadata });
    }
    // Cryptography is exercised with real temporary keys by test-client-updater.mjs; here verification is injected to test assembly failures.
    let verified = 0; const options = { tag, commit, repository: 'example/client-releases', publicKey: 'fixture', verify: async () => { verified++; } };
    const { manifest } = await buildUpdateManifest(groups, options); assert.equal(verified, 4); assert.equal(Object.keys(manifest.platforms).length, 8);
    for (const entry of Object.values(manifest.platforms)) { assert.ok(entry.url.includes('/releases/download/client-v1.2.0/')); assert.equal(entry.url.includes('/latest/'), false); }
    await assert.rejects(buildUpdateManifest(groups.slice(1), options), /All four/);
    await assert.rejects(buildUpdateManifest([groups[0], groups[0], ...groups.slice(2)], options), /Duplicate/);
    groups[0].metadata.osSignatureVerified = false; await assert.rejects(buildUpdateManifest(groups, options), /OS signature/); groups[0].metadata.osSignatureVerified = true;
    groups[0].metadata.commit = 'b'.repeat(40); await assert.rejects(buildUpdateManifest(groups, options), /does not match/); groups[0].metadata.commit = commit;
    await assert.rejects(buildUpdateManifest(groups, { ...options, verify: async () => { throw new Error('bad signature'); } }), /bad signature/);
    const signatureFile = groups[0].metadata.files[1], original = await readFile(join(groups[0].directory, signatureFile.name));
    const wrong = Buffer.from(original.toString(), 'base64').toString().replace('version:1.2.0', 'version:1.1.0'); const encoded = Buffer.from(wrong).toString('base64');
    await writeFile(join(groups[0].directory, signatureFile.name), encoded); signatureFile.bytes = Buffer.byteLength(encoded); signatureFile.sha256 = hash(encoded);
    await assert.rejects(buildUpdateManifest(groups, options), /bind the exact release version/);
    await writeFile(join(groups[0].directory, signatureFile.name), original); signatureFile.bytes = original.length; signatureFile.sha256 = hash(original);
    await writeFile(join(groups[0].directory, groups[0].metadata.files[0].name), 'tampered'); await assert.rejects(buildUpdateManifest(groups, options), /size\/hash changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release tag grammar rejects shell/path/version ambiguity and remote publisher cannot run locally', () => {
  assert.equal(releaseVersion('client-v0.1.0-rc.1'), '0.1.0-rc.1');
  for (const tag of ['v1.2.3', 'client-v01.2.3', 'client-v1.2.3+build.2', 'client-v1.2.3-rc.01', 'client-v1.2.3;touch /tmp/x', '../client-v1.2.3']) assert.throws(() => releaseVersion(tag));
  const result = spawnSync(process.execPath, ['scripts/publish-client-release.mjs', 'draft'], { env: { ...process.env, CI: 'false' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /configured CI release environment/);
});

const engineSource = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/client-updates.ts', import.meta.url), 'utf8'));
const { ClientUpdates, defaultUpdatePreferences, normalizeUpdatePreferences, preferencesForPolicy, updatePolicy, updateReleaseItems, updateDownloadProgress } = await import(`data:text/javascript;base64,${Buffer.from(engineSource).toString('base64')}`);
const idle = { authenticated: true, recording: false, paused: false, busy: false };
function engineFixture() {
  let activity = { ...idle }, queue = { pendingBytes: 0, pendingCount: 0, queueBusy: false }, preferences = { ...defaultUpdatePreferences };
  let status = { phase: 'ready', currentVersion: '1.0.0', version: '1.1.0', downloaded: 100 };
  const calls = [], freezes = [], order = [];
  const engine = new ClientUpdates({ invoke: async (command, args) => {
    calls.push([command, args]); order.push(command);
    if (command === 'update_check') status = { ...status, phase: 'available' };
    if (command === 'update_download') status = { ...status, phase: 'ready' };
    return status;
  }, queue: async () => { order.push('queue'); return queue; }, activity: () => activity,
  preferences: () => preferences, preferencesChanged: value => { preferences = value; }, changed() {}, freeze: value => { freezes.push(value); order.push(`freeze:${value}`); } });
  engine.apply(status);
  return { engine, calls, freezes, order, activity: value => { activity = value; }, queue: value => { queue = value; }, preferences: value => { preferences = value; } };
}

test('updater freezes input before fresh queue check and never installs while recording, paused or saving', async () => {
  for (const unsafe of [{ ...idle, authenticated: false }, { ...idle, recording: true }, { ...idle, paused: true }, { ...idle, busy: true }]) {
    const h = engineFixture(); h.activity(unsafe); await h.engine.install();
    assert.equal(h.calls.some(([name]) => name === 'update_install'), false); assert.deepEqual(h.freezes, [true, false]);
  }
  for (const queue of [{ pendingBytes: 0, pendingCount: 1, queueBusy: false }, { pendingBytes: 1, pendingCount: 1, queueBusy: false }, { pendingBytes: 0, pendingCount: 0, queueBusy: true }]) {
    const h = engineFixture(); h.queue(queue); await h.engine.install(); assert.equal(h.calls.some(([name]) => name === 'update_install'), false);
  }
  const h = engineFixture(); await h.engine.install();
  assert.deepEqual(h.order, ['freeze:true', 'queue', 'update_activity', 'update_install', 'freeze:false']);
});

test('update dropdown policies normalize legacy profiles and never retain automatic installation', () => {
  for (const policy of ['manual', 'check', 'background']) {
    const settings = preferencesForPolicy(policy);
    assert.equal(updatePolicy(settings), policy);
    assert.equal(settings.autoCheck, policy !== 'manual');
    assert.equal(settings.autoDownload, policy === 'background');
    assert.equal(settings.autoInstall, false);
  }
  assert.deepEqual(normalizeUpdatePreferences({ autoCheck: false, autoDownload: true, autoInstall: true }), preferencesForPolicy('manual'));
  assert.deepEqual(normalizeUpdatePreferences({ autoCheck: true, autoDownload: true, autoInstall: true }), preferencesForPolicy('background'));
  assert.deepEqual(normalizeUpdatePreferences(null), defaultUpdatePreferences);
});

test('automatic check does not imply automatic download/install and backoff avoids repeated network work', async () => {
  const h = engineFixture(); await h.engine.tick(0); await h.engine.tick(1000);
  assert.deepEqual(h.calls.map(([name]) => name), ['update_check']);
  h.preferences({ autoCheck: true, autoDownload: true, autoInstall: true }); h.activity({ ...idle, recording: true });
  await h.engine.tick(2000); assert.equal(h.calls.filter(([name]) => name === 'update_download').length, 1);
  assert.equal(h.calls.some(([name]) => name === 'update_install'), false);
  h.activity(idle); await h.engine.tick(63_000); assert.equal(h.calls.filter(([name]) => name === 'update_install').length, 0);
});

test('failed automatic downloads retry after backoff without waiting six hours', async () => {
  let now = 0, attempts = 0;
  const h = engineFixture(); h.preferences(preferencesForPolicy('background'));
  h.engine.apply({ phase: 'available', currentVersion: '1.0.0', downloaded: 0, error: 'network interrupted' });
  await h.engine.tick(now);
  attempts = h.calls.filter(([name]) => name === 'update_download').length;
  assert.equal(attempts, 1);
  h.engine.apply({ ...h.engine.status, phase: 'available', error: 'network interrupted' });
  await h.engine.tick(now += 1000);
  assert.equal(h.calls.filter(([name]) => name === 'update_download').length, 1);
  await h.engine.tick(now += 15 * 60 * 1000);
  assert.equal(h.calls.filter(([name]) => name === 'update_download').length, 2);
});

test('native update menu shares check, background preference and explicit safe installation actions', async () => {
  const h = engineFixture();
  h.preferences(preferencesForPolicy('manual'));
  await h.engine.tick(0); assert.equal(h.calls.length, 0);
  h.engine.apply({ ...h.engine.status, phase: 'available' });
  h.activity({ ...idle, recording: true });
  await h.engine.menuAction('status-update-background');
  assert.equal(h.calls.filter(([name]) => name === 'update_download').length, 1);
  assert.equal(h.calls.find(([name]) => name === 'update_activity')[1].autoDownload, true);
  assert.equal(h.calls.some(([name]) => name === 'update_install'), false);
  await h.engine.menuAction('status-update-background');
  assert.equal(h.calls.filter(([name]) => name === 'update_activity').at(-1)[1].autoDownload, false);
  await h.engine.menuAction('status-update-check');
  assert.equal(h.calls.filter(([name]) => name === 'update_check').length, 1);
  assert.equal(h.calls.filter(([name]) => name === 'update_download').length, 1);
  const installer = engineFixture();
  for (const unsafe of [{ ...idle, recording: true }, { ...idle, paused: true }]) {
    installer.activity(unsafe); await installer.engine.menuAction('status-update-install');
    assert.equal(installer.calls.some(([name]) => name === 'update_install'), false);
  }
  installer.activity(idle); installer.queue({ pendingCount: 1, pendingBytes: 1, queueBusy: false });
  await installer.engine.menuAction('status-update-install');
  assert.equal(installer.calls.some(([name]) => name === 'update_install'), false);
  installer.queue({ pendingCount: 0, pendingBytes: 0, queueBusy: false });
  await installer.engine.menuAction('status-update-install');
  assert.equal(installer.calls.filter(([name]) => name === 'update_install').length, 1);
  const disabled = engineFixture(); disabled.engine.apply({ ...disabled.engine.status, phase: 'disabled' });
  for (const action of ['status-update-check', 'status-update-background', 'status-update-install']) await disabled.engine.menuAction(action);
  assert.equal(disabled.calls.length, 0);
});

test('queue safety includes another account record and in-flight ACK, so filtered lists cannot hide saved audio', async () => {
  const source = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/queue.ts', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replaceAll('export ', '') + '\nObject.assign(exports,{enqueue,drainQueue,setQueueRecords,updateQueueState});';
  const exports = {}, indexedDB = new IDBFactory(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const upload = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  vm.runInNewContext(source, { exports, indexedDB, IDBKeyRange, ApiError: class extends Error {}, api: upload, uploadAudio: upload, navigator: { onLine: true },
    performance, trace() {}, traceEnabled: () => false, sessionStorage: { getItem: () => null } });
  await exports.enqueue('other-account-record', { sourceId: 's', epoch: 'e', sequence: 0, sampleOffset: 0, sampleCount: 1600, digest: 'a' });
  exports.setQueueRecords([]); let safety = await exports.updateQueueState(); assert.equal(safety.pendingBytes, 3200); assert.equal(safety.pendingCount, 1);
  exports.setQueueRecords(['other-account-record']); const drain = exports.drainQueue(); await started;
  safety = await exports.updateQueueState(); assert.equal(safety.queueBusy, true); assert.equal(safety.pendingBytes, 3200);
  release(); await drain; safety = await exports.updateQueueState(); assert.equal(safety.queueBusy, false); assert.equal(safety.pendingBytes, 0);
});

test('authenticated update barrier exposes only owner stop and ACK metadata across pause, seal and expiry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-update-barrier-'));
  const api = await createRecordServer({ root, port: 0, host: '127.0.0.1', databaseUrl: '', seedDevelopment: false });
  try {
    const address = await api.start(), base = `http://127.0.0.1:${address.port}/api`;
    assert.equal((await fetch(`${base}/client/update-barrier`)).status, 401);
    const register = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'update@local.test', password: 'FixtureOnly2026!' }) });
    const cookie = register.headers.get('set-cookie').split(';')[0], { csrf } = await register.json();
    const request = async (path, method = 'GET', body) => {
      const response = await fetch(base + path, { method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
    };
    assert.deepEqual(await request('/client/update-barrier'), { protocol: 1, records: [] });
    const record = await request('/records', 'POST', { title: 'private title must not leave the API' });
  const other = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'other-update@local.test', password: 'FixtureOnly2026!' }) });
  assert.equal(other.ok, true);
  const otherCookie = other.headers.get('set-cookie').split(';')[0], { csrf: otherCsrf } = await other.json();
  for (let index = 0; index < 2; index++) {
    const created = await fetch(`${base}/records`, { method: 'POST', headers: { cookie: otherCookie, 'x-csrf-token': otherCsrf, 'content-type': 'application/json' }, body: JSON.stringify({ title: `other account ${index}` }) });
    assert.equal(created.ok, true);
  }
  assert.equal((await request('/client/update-barrier')).records.length, 1);
  const otherBarrier = await fetch(`${base}/client/update-barrier`, { headers: { cookie: otherCookie } });
  assert.equal((await otherBarrier.json()).records.length, 2);
    const source = await request(`/records/${record.id}/sources`, 'POST', { kind: 'display' });
    let barrier = await request('/client/update-barrier'); assert.equal(barrier.records[0].capture, 'recording');
    const bytes = Buffer.alloc(3200, 3);
    await request(`/records/${record.id}/audio`, 'POST', { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence: 0, sampleOffset: 0, sampleCount: 1600, sampleRate: 16000, digest: digest(bytes), pcm: bytes.toString('base64') });
    const manifest = { sources: [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 0 }] };
    await request(`/records/${record.id}/pause`, 'POST', manifest);
    barrier = await request('/client/update-barrier'); assert.equal(barrier.records[0].capture, 'paused');
    await request(`/records/${record.id}/seal`, 'POST', manifest);
    barrier = await request('/client/update-barrier'); assert.equal(barrier.records[0].capture, 'sealed');
    assert.deepEqual(barrier.records[0].sources, [{ stopped: true, lastSequence: 0, watermark: 0 }]);
    const text = JSON.stringify(barrier); for (const privateValue of [record.id, source.id, source.epoch, 'private title', 'update@']) assert.equal(text.includes(privateValue), false);
    await api.repo.change(record.id, value => { value.deleteAt = new Date(Date.now() - 1000).toISOString(); });
    assert.deepEqual(await request('/client/update-barrier'), { protocol: 1, records: [] });
  } finally { await api.stop(); await rm(root, { recursive: true, force: true }); }
});

test('one explicit update action checks, downloads and installs once through the existing safety barrier',async()=>{
 const h=engineFixture();h.engine.apply({phase:'idle',currentVersion:'1.0.0',downloaded:0});await Promise.all([h.engine.downloadAndInstall(),h.engine.downloadAndInstall()]);
 assert.equal(h.calls.filter(([name])=>name==='update_check').length,1);assert.equal(h.calls.filter(([name])=>name==='update_download').length,1);assert.equal(h.calls.filter(([name])=>name==='update_install').length,1);assert.deepEqual(h.freezes,[true,false]);
 const unsafe=engineFixture();unsafe.activity({...idle,recording:true});await unsafe.engine.downloadAndInstall();assert.equal(unsafe.calls.some(([name])=>name==='update_install'),false);
});

test('settings update action follows automatic-download readiness and keeps recording blockers',async()=>{
 const {transform}=await import('esbuild');const source=await readFile(new URL('../apps/web/src/components/ClientUpdates.tsx',import.meta.url),'utf8');const code=(await transform(source.replace(/^import .*$/gm,''),{loader:'tsx',format:'cjs'})).code;
 const box={module:{exports:{}},updatePolicy,preferencesForPolicy,DownloadSimple:()=>null,Select:()=>null,Button:props=>({tag:'button',props})};box.React={createElement:(tag,props,...children)=>typeof tag==='function'?tag({...props,children}):({tag,props,children})};vm.runInNewContext(code,box);
 for(const [background,phase,reason,disabled,label] of [[false,'available','',false,'下载并更新'],[true,'available','',true,'立即更新'],[true,'downloading','',true,'立即更新'],[true,'ready','',false,'立即更新'],[true,'ready','正在录音',true,'立即更新']]){
  let clicked=0;const tree=box.module.exports.ClientUpdateActions({updates:{native:true,status:{phase,currentVersion:'1'},settings:preferencesForPolicy(background?'background':'check'),installReason:reason,update:()=>{clicked++;}}});
  const button=tree.children.flat().find(x=>x?.tag==='button');assert.equal(button.props.disabled,disabled);assert.ok(button.props.children.includes(label));if(!disabled){button.props.onClick();assert.equal(clicked,1);}
 }
});


test('release display keeps only change items and removes Markdown destinations and release metadata', () => {
  const notes = '# Preview v1.2.0\r\n\r\n## 版本改动与修复\r\n- 修复 **自动下载** 与 `离线转录`。\r\n  保留录音。\r\n- 优化 [设置页面](https://example.test/settings)。\r\n\r\n## 下载与安装\r\n[安装包](https://example.test/private-installer)\r\n## SHA-256\r\ndeadbeef\r\n## 构建来源与验证\r\nsource-secret';
  assert.deepEqual(updateReleaseItems(notes), ['修复 自动下载 与 离线转录。 保留录音。', '优化 设置页面。']);
  assert.deepEqual(updateReleaseItems('## 下载与安装\nDo not display this section'), []);
  assert.deepEqual(updateReleaseItems('## Changes\n- Keep names.\n## Checksums\nDo not display'), ['Keep names.']);
  assert.deepEqual(updateReleaseItems('- 修复下载。\n- 保留音频。'), ['修复下载。', '保留音频。']);
  assert.deepEqual(updateReleaseItems(null), []);
});

test('current real publisher body displays changes without install instructions, hashes or CI links', async () => {
  const {previewNotes}=await import('../scripts/publish-preview-release.mjs');
  const {version}=JSON.parse(await readFile(new URL('../apps/desktop/package.json',import.meta.url),'utf8'));
  const guide=await readFile(new URL(`../docs/releases/v${version}-preview.md`,import.meta.url),'utf8');
  const body=previewNotes({tag:`v${version}`,commit:'a'.repeat(40),workflowSha:'b'.repeat(40),runUrl:'https://github.com/example/test/actions/runs/1',guide,metadata:{platform:'macos',architecture:'arm64',artifact:`Lingji-${version}-macos-arm64.dmg`,sha256:'c'.repeat(64)}});
  const items=updateReleaseItems(body);assert.ok(items.length>0);
  assert.ok(!items.join(' ').includes('下载与安装'));assert.ok(!items.join(' ').includes('SHA-256\n'));
  assert.ok(!items.join(' ').includes('c'.repeat(64)));assert.ok(!items.join(' ').includes('/actions/runs/'));
});

test('download display preserves unknown totals, byte counts and verification boundary', () => {
  const unit=1024*1024;
  assert.deepEqual(updateDownloadProgress({downloaded:50*unit,total:100*unit}),{percent:50,complete:false,size:'50.0 MB / 100.0 MB'});
  assert.equal(updateDownloadProgress({downloaded:999,total:1000}).percent,99);
  assert.equal(updateDownloadProgress({downloaded:999,total:1000}).complete,false);
  assert.deepEqual(updateDownloadProgress({downloaded:101*unit,total:100*unit}),{percent:100,complete:true,size:'100.0 MB / 100.0 MB'});
  for(const total of [null,undefined,0,-1,NaN,Infinity]){
    const progress=updateDownloadProgress({downloaded:1024,total});assert.equal(progress.percent,null);assert.equal(progress.complete,false);assert.equal(progress.size,'已下载 1.0 KB');
  }
  assert.equal(updateDownloadProgress({downloaded:-1,total:100}).percent,0);
  assert.equal(updateDownloadProgress({downloaded:NaN,total:100}).size,'0 B / 100 B');
});

test('update panel distinguishes download, indeterminate and verification states with accessible progress', async () => {
  const {transform}=await import('esbuild'), source=await readFile(new URL('../apps/web/src/components/ClientUpdates.tsx',import.meta.url),'utf8');
  const code=(await transform(source.replace(/^import .*$/gm,''),{loader:'tsx',format:'cjs'})).code;
  const box={module:{exports:{}},updatePolicy,preferencesForPolicy,updateReleaseItems,updateDownloadProgress,DownloadSimple:()=>null,ArrowsClockwise:()=>null,Select:props=>({tag:'select',props,children:[]}),Button:()=>null};
  box.React={createElement:(tag,props,...children)=>typeof tag==='function'?tag({...props,children}):({tag,props,children})};vm.runInNewContext(code,box);
  const render=(downloaded,total)=>box.module.exports.ClientUpdatesPanel({updates:{native:true,status:{phase:'downloading',currentVersion:'1',downloaded,total,notes:'## 版本改动与修复\n- 修复下载。\n## SHA-256\nNOT-A-CHANGE'},settings:defaultUpdatePreferences,installReason:'',saveSettings(){}}});
  const nodes=tree=>[tree,...(tree?.children||[]).flat(Infinity).filter(x=>x&&typeof x==='object').flatMap(nodes)];
  const known=nodes(render(50,100)), unknown=nodes(render(50,null)), complete=nodes(render(100,100));
  assert.equal(known.find(n=>n.props?.role==='progressbar').props['aria-valuenow'],50);
  assert.equal(unknown.find(n=>n.props?.role==='progressbar').props['aria-valuenow'],undefined);
  assert.match(JSON.stringify(complete),/下载完成，正在校验更新/);assert.ok(!JSON.stringify(complete).includes('完整性校验'));
  assert.ok(!JSON.stringify(known).includes('NOT-A-CHANGE'));
  const select=known.find(n=>n.tag==='select'), background=select.props.options.find(o=>o.label==='自动检查并后台下载');
  assert.equal(preferencesForPolicy(background.value).autoDownload,true);
  assert.equal(select.props.label,'更新策略');
});
