import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRecordServer } from '../services/records/src/server.mjs';

const root = await mkdtemp(join(tmpdir(), 'tts-native-fixture-'));
const output = join(root, 'probe.json');
// Isolated fixture: no worker or provider is started.
process.env.RECORD_PROVIDER = 'fixture'; process.env.NODE_ENV = 'test';
const apiOptions = { onError:error=>{if(['EPERM','EBUSY','EACCES','ENAMETOOLONG'].includes(error.code))console.error('[native filesystem]',error.stack);}, root: join(root, 'records'), port: 0, host: '127.0.0.1', databaseUrl: '', seedDevelopment: false };
const api = await createRecordServer(apiOptions);
let child, logs = '';
let failure;
const terminateClient=()=>{if(process.platform==='win32'){try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:5000});}catch{child.kill('SIGTERM');}}else child.kill('SIGTERM');};
try {
  const address = await api.start();
  apiOptions.origin = `http://127.0.0.1:${address.port}`;
  const backgroundMs=Math.max(9000,Math.min(600000,Number(process.env.TTS_NATIVE_BACKGROUND_MS)||9000));
const launch = () => spawn(resolve(process.env.NATIVE_CLIENT_EXECUTABLE || 'apps/desktop/src-tauri/target/debug/tts-client'), [], { env: {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      ...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA,TEMP:process.env.TEMP,TMP:process.env.TMP}:{}),
    TTS_CLIENT_DATA_DIR: join(root, 'client'), TTS_RECORD_API_URL: `http://127.0.0.1:${address.port}`,
    TTS_CLIENT_SYNTHETIC: '1', TTS_NATIVE_BACKGROUND_MS:String(backgroundMs), TTS_CLIENT_PROBE_OUTPUT: output, TTS_CLIENT_PROBE_AUTO_EXIT:'1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const waitProbe = async () => {
    for (let n = 0; n < Math.ceil((backgroundMs+180000)/100); n++) {
      try { return JSON.parse(await readFile(output, 'utf8')); } catch { /* Wait for the isolated renderer. */ }
      if (child.exitCode != null) throw new Error(`Native client exited ${child.exitCode}: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Native probe timed out: ${logs}`);
  };
  child = launch();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-6000); });
  let result = await waitProbe();
  assert.ok(result, `Native probe timed out: ${logs}`); assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.settingsCancelReopen,true);
  assert.equal(result.iframeBlocked, true);
  assert.deepEqual(result.residentCapture,{hiddenWindow:true,continuedNativeCapture:true,continuedDurableQueue:true,recordingNotPaused:true,restoredWindow:true,hiddenMs:backgroundMs,sampleCoverageVerified:true}); assert.deepEqual(result.recordingWidget,{loadedPrivateSession:true,automaticallyMinimized:true,pause:true,resume:true,pausedCapsuleRetained:true,restoredMain:true,finishConfirmation:true,queuedAudioClock:true,coldReadyExclusive:true,nativeRestore:true,compactHeight:true,lateReadyCancelled:true});
assert.ok(result.pcm.length >= 2);
  let offset = 0;
  result.pcm.forEach((packet, sequence) => { assert.equal(packet.sequence, sequence); assert.equal(packet.offset, offset); offset += packet.samples; });
  assert.equal(result.pcm[0].nonzero, true);
  const stored = await api.repo.get(result.recordId);
  assert.equal(stored.chunks.length, result.pcm.length); assert.equal(stored.sources[0].watermark, result.pcm.length - 1);
  assert.equal(stored.capture, 'paused');
  delete result.recordId;
  const initialOrigin = result.origin;
  for(let i=0;i<100&&child.exitCode==null;i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(child.exitCode,0,'Native probe must exit normally before profile restart');
  await rm(output);
  child = launch();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-6000); });
  const restarted = await waitProbe(); assert.equal(restarted.ok, true, JSON.stringify(restarted));
  assert.equal(restarted.origin, initialOrigin); assert.equal(restarted.indexedDbRetained, true); assert.equal(restarted.reloginRequired, true);
  assert.equal(restarted.priorUiQueueReplayed, true);
  const replayed = await api.repo.get(result.uiRecordId);
  assert.equal(replayed.capture, 'paused');
  assert.deepEqual(replayed.sources.map(source => source.kind).sort(), ['display', 'microphone']);
  assert.equal(result.uiLanes.length, 2);
  for (const source of replayed.sources) {
    const expected = result.uiLanes.find(lane => lane.sourceId === source.id);
    assert.ok(expected); assert.equal(expected.kind, source.kind); assert.equal(expected.epoch, source.epoch); assert.equal(expected.sessionId, source.sessionId);
    assert.equal(source.stopped, true); assert.equal(source.watermark, source.lastSequence);
    const chunks = replayed.chunks.filter(chunk => chunk.sourceId === source.id).sort((a, b) => a.sequence - b.sequence);
    assert.equal(chunks.length, expected.packets); assert.equal(source.lastSequence, chunks.length - 1); assert.ok(chunks.length >= 2);
    let offset = 0;
    for (const [sequence, chunk] of chunks.entries()) {
      assert.equal(chunk.sequence, sequence); assert.equal(chunk.sampleOffset, offset); assert.equal(chunk.sessionId, source.sessionId); assert.equal(chunk.epoch, source.epoch); assert.equal(chunk.sampleRate, 16000);
      const bytes = await api.repo.readAudio(chunk.object);
      assert.equal(bytes.length, chunk.sampleCount * 2); assert.equal(createHash('sha256').update(bytes).digest('hex'), chunk.digest);
      assert.ok(Array.from({ length: chunk.sampleCount }, (_, index) => bytes.readInt16LE(index * 2)).some(sample => sample !== 0));
      offset += chunk.sampleCount;
    }
    assert.equal(offset, expected.samples);
  }
  assert.equal(replayed.chunks.length, result.pendingUiPackets);
  const replayedUiReceipts = replayed.chunks.length; delete result.uiRecordId;
  result = { ...result, stableOriginAfterRestart: true, indexedDbRetainedAfterRestart: true, reloginRequiredAfterRestart: true };
  const evidence = { realQueueReplayedAfterRestart: true, replayedUiReceipts, timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    ...result, durableReceipts: stored.chunks.length, stoppedCapture: stored.capture, realAudioDevicesOpened: false, realProvidersInvoked: false };
  if (process.argv[2]) {
    const target = resolve(process.argv[2]); await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(JSON.stringify({ ok: true, recordingWidget: result.recordingWidget, settingsCancelReopen: result.settingsCancelReopen, residentCapture: result.residentCapture, restartQueueReplay: restarted.priorUiQueueReplayed, nativePcmPackets: result.pcm.length, totalSamples: offset, authenticated: result.authenticated, sse: result.sse, iframeBlocked: result.iframeBlocked }));
} catch(error) { failure=error; console.error('[native test failure]',error); console.error('[native client]',logs); throw error; } finally {
  if (child && child.exitCode == null) {
    terminateClient(); await new Promise(resolve => child.once('exit', resolve));
  }
  await api.stop(); try { await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}); } catch(error) { if(!failure)throw error; console.error('[native cleanup]',error.code); }
}
