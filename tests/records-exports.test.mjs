import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportMinutesMarkdown, attachmentHeader } from '../services/records/src/markdown-export.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';
import { createRecord, digest } from '../packages/records/src/record.mjs';
const ref={segmentId:'saved',revision:1};
function fixture() {
  const r=createRecord('owner');r.capture='completed';r.transcriptRevision=9;r.minutesRevision=2;
  const item={text:'周五完成验收',evidence:[ref]};
  r.minutes={title:'发布与验收计划',revision:2,transcriptRevision:3,edited:true,
    evidenceSnapshot:[{id:'saved',revision:1,text:'周五完成验收',startMs:61000,speaker:'发言人1'}],
    topics:[{id:'release',title:'发布',summary:'确认验收安排',evidence:[ref]}],
    sections:[{heading:'安排',items:[item]}],decisions:[item],
    tables:[{title:'验收表',columns:['任务','状态'],rows:[{cells:['A|B\n测试','待完成'],evidence:[ref]}]}],
    speakerSummaries:[{speaker:'发言人1',summary:'说明验收安排',evidence:[ref]}],actions:[{...item,owner:null,due:null}]};
  r.segments=[{id:'saved',revision:2,text:'后来修改后的文本'},{id:'private',revision:1,text:'无关的私密原文'}];
  r.notes='人工核对';return r;
}
test('Markdown exports complete saved minutes with frozen evidence, Unicode and proper tables',()=>{
  const text=exportMinutesMarkdown(fixture());
  for(const section of ['# 发布与验收计划','转录版本 3 · 纪要版本 2 · 人工修订','讨论主题','关键决策','验收表','发言人总结','行动候选','负责人：待确认','人工核对','[^1]: saved@1 01:01 发言人1 — 周五完成验收'])assert.ok(text.includes(section),section);
  assert.ok(text.includes('A\\|B 测试'));
  assert.doesNotMatch(text,/后来修改后的文本|无关的私密原文/);
  assert.equal((text.match(/\[\^1\]:/g)||[]).length,1);
});
test('Markdown uses validated live draft, protects manual final, and refuses missing minutes',()=>{
  const r=fixture();r.capture='recording';r.minutes.edited=false;r.liveMinutes={...r.minutes,title:'当前草稿',transcriptRevision:8};
  assert.match(exportMinutesMarkdown(r),/^# 当前草稿[\s\S]*转录版本 8 · 会中草稿/);
  r.minutes.edited=true;assert.match(exportMinutesMarkdown(r),/^# 发布与验收计划/);
  r.minutes=null;r.liveMinutes=null;assert.throws(()=>exportMinutesMarkdown(r),{code:'minutes_unavailable'});
  assert.match(attachmentHeader('会议\r\n/名称','md'),/^attachment; filename="meeting.md"; filename\*=UTF-8''/);
  assert.doesNotThrow(()=>attachmentHeader('🙂'.repeat(80)+'\ud800','md'));
});
test('HTTP minutes export keeps access checks and rejects absent minutes before response headers',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-exports-')),app=await createRecordServer({root,databaseUrl:'',port:0});
  try {
    const address=await app.start(),base=`http://127.0.0.1:${address.port}/api`;
    const registered=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'exports@example.test',password:'fixture-password'})});
    const user=await registered.json(),headers={Cookie:registered.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':user.csrf,'Content-Type':'application/json'};
    const response=await fetch(base+'/records',{method:'POST',headers,body:'{}'}),created=await response.json();
    const url=base+`/records/${created.id}/export?format=markdown`;
    assert.equal((await fetch(url,{headers})).status,409);
    await app.repo.change(created.id,r=>{const saved=fixture();Object.assign(r,{...saved,id:r.id,owner:r.owner});});
    const exported=await fetch(url,{headers});assert.equal(exported.status,200);assert.match(exported.headers.get('content-type'),/text\/markdown/);
    assert.match(exported.headers.get('content-disposition'),/filename\*=UTF-8''/);assert.match(await exported.text(),/发布与验收计划/);
    assert.equal((await fetch(url)).status,401);
    const ownerId=`user:${digest('exports@example.test')}`;assert.equal((await app.repo.get(created.id)).owner,ownerId);
  } finally {await app.stop();await rm(root,{recursive:true,force:true});}
});
