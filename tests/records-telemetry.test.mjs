import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry } from '../services/records/src/telemetry.mjs';
test('bounded stage traces preserve result and errors without recording content', async () => {
  const t = createTelemetry({ enabled:true, limit:3, sink:()=>{throw Error('sink failed');} });
  try {
    assert.equal(await t.measure('ack', {recordId:'r', pcm:'SECRET_AUDIO', text:'SECRET_TRANSCRIPT', key:'SECRET_KEY'},()=>42),42);
    const error = Error('SECRET_ERROR');
    await assert.rejects(t.measure('provider', {},()=>{throw error;}),e=>e===error);
    t.event('queue',{bytes:4}); t.event('queue',{bytes:8});
    const s=t.snapshot(); assert.equal(s.events.length,3); assert.equal(s.timings.ack.count,1);
    assert.equal(s.events[0].outcome,'error'); assert.ok(!JSON.stringify(s).includes('SECRET'));
    assert.ok(s.timings.provider.p95Ms>=0); assert.ok(s.memory.rss>0);assert.equal(s.versions.protocol,'record/v1');assert.equal(s.events[0].errorClass,'operation_failed');
  } finally { t.close(); }
});
test('disabled traces do not invoke sink or change operations',async()=>{
  const t=createTelemetry({sink:()=>assert.fail('disabled')});
  assert.equal(await t.measure('disabled',{},()=>7),7); assert.deepEqual(t.snapshot().events,[]);
});
