import test from 'node:test';import assert from 'node:assert/strict';
import{createRecord,addSource,acknowledge,receipt}from'../packages/records/src/record.mjs';
test('indexed audio receipts preserve out-of-order holes, merged watermarks and duplicate fences',()=>{
 const record=createRecord('fixture'),source=addSource(record,{kind:'microphone'}),present=new Set();
 const chunk=sequence=>({sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*160,sampleCount:160,sampleRate:16000,digest:'digest-'+sequence,object:'fixture'});
 for(let i=0;i<1000;i++){const sequence=(i*137)%1000;present.add(sequence);const ack=acknowledge(record,chunk(sequence));let watermark=-1;while(present.has(watermark+1))watermark++;const highest=Math.max(...present);assert.equal(ack.watermark,watermark);assert.deepEqual(ack.missing,Array.from({length:highest-watermark},(_,n)=>n+watermark+1).filter(n=>!present.has(n)));}
 assert.equal(source.watermark,999);const cursor=record.cursor;assert.equal(acknowledge(record,chunk(500)).cursor,cursor);assert.equal(record.chunks.length,1000);
 assert.throws(()=>acknowledge(record,{...chunk(500),digest:'different'}),{code:'audio_identity_conflict'});
 assert.throws(()=>acknowledge(record,{...chunk(1000),sampleOffset:0}),{code:'audio_timeline_conflict'});
 source.lastSequence=1002;assert.deepEqual(receipt(record,source).missing,[1000,1001,1002]);
});
