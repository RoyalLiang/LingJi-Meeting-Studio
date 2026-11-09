import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRepository } from '../services/records/src/repository.mjs';

const root = await mkdtemp(join(tmpdir(), 'lingji-native-evolution-'));
const output = join(root, 'probe.json'), clientRoot = join(root, 'client');
let child, log = '', repo, failure;
try {
  child = spawn(resolve(process.env.NATIVE_CLIENT_EXECUTABLE || 'apps/desktop/src-tauri/target/debug/tts-client'), [], {
    env: { PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,
      ...(process.platform==='linux'?{DISPLAY:process.env.DISPLAY,XAUTHORITY:process.env.XAUTHORITY,LIBGL_ALWAYS_SOFTWARE:'1',WEBKIT_DISABLE_DMABUF_RENDERER:'1'}:{}),
   ...(process.platform === 'win32' ? {SystemRoot:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA,TEMP:process.env.TEMP,TMP:process.env.TMP} : {}),
      TTS_CLIENT_DATA_DIR:clientRoot,TTS_CLIENT_SYNTHETIC:'1',TTS_NATIVE_EVOLUTION_PROBE:'1',TTS_CLIENT_PROBE_OUTPUT:output },
    stdio:['ignore','pipe','pipe'],
  });
  child.on('error', error => { log += error.message; });
  for (const stream of [child.stdout,child.stderr]) stream.on('data', data => { log = (log + data).slice(-6000); });
  let result;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try { result = JSON.parse(await readFile(output,'utf8')); break; } catch { /* Native app is still testing. */ }
    assert.equal(child.exitCode,null,`Native smoke exited before its receipt: ${log}`); assert.equal(child.signalCode,null,`Native smoke aborted: ${log}`);
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert.ok(result,`Native evolution timed out: ${log}`); assert.equal(result.ok,true,`${JSON.stringify(result)}\n${log}`);
  for (let n=0;n<100 && child.exitCode===null;n++) await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(child.exitCode,0,log);
  repo=await createRepository({root:join(clientRoot,'backend'),databaseUrl:'',s3:{bucket:''}});
  const record=await repo.get(result.recordId); assert.equal(record.sources.length,4);
  assert.ok(['sealed','completed'].includes(record.capture));
  let totalSamples=0;const durations=[];
  for (const source of record.sources) {
    assert.equal(source.captureTransport,'native-file-v1');assert.equal(source.watermark,source.lastSequence);
    const chunks=record.chunks.filter(chunk=>chunk.sourceId===source.id).sort((a,b)=>a.sequence-b.sequence);
    assert.ok(chunks.length>0);let offset=0;
    for (const [sequence,chunk] of chunks.entries()) {
      assert.equal(chunk.sequence,sequence);assert.equal(chunk.sampleOffset,offset);assert.equal(chunk.sessionId,source.sessionId);assert.equal(chunk.epoch,source.epoch);
      const bytes=await repo.readAudio(chunk.object);assert.equal(bytes.length,chunk.sampleCount*2);assert.equal(createHash('sha256').update(bytes).digest('hex'),chunk.digest);
      assert.ok(bytes.some(byte=>byte!==0));offset+=chunk.sampleCount;
    }
    totalSamples+=offset;durations.push(offset/16);assert.equal(source.lastSequence,chunks.length-1);
  }
  const firstEnd=Math.max(...durations.slice(0,2));
  assert.ok(record.sources.slice(2).every(source=>source.timelineOffsetMs>=Math.floor(firstEnd)),'resumed sources must follow the produced native tail');
  const receipt={...result,scope:'isolated compiled Tauri + bundled Node + real file/SQLite transport; synthetic OS source; no physical device',platform:process.platform,totalSamples,exactStoredChunkDigests:true,contiguousFences:true,resumeTimelinePreserved:true};
  if (process.argv[2]) { const target=resolve(process.argv[2]);await mkdir(dirname(target),{recursive:true});await writeFile(target,JSON.stringify(receipt,null,2)+'\n'); }
  console.log(JSON.stringify(receipt));
} catch (error) {
  failure = error;
  console.error('[native evolution failure]',error);
  console.error('[native evolution client]',log);
  throw error;
} finally {
  if (child?.exitCode===null) child.kill('SIGTERM');
  try { await repo?.close(); await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}); }
  catch(error) { if(!failure) throw error; console.error('[native evolution cleanup]',error.code || error.message); }
}
