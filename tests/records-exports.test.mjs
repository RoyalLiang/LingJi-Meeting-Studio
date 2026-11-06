import { sharedMinutes } from '../packages/records/src/shared-content.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportMinutesMarkdown, attachmentHeader } from '../services/records/src/markdown-export.mjs';
import { feishuBoard } from '../services/records/src/integrations/feishu-board.mjs';
import { minutesReadingBranches, uniqueMinutesItems } from '../packages/records/src/minutes-reading.mjs';
import { createRecordServer, exportRecord } from '../services/records/src/server.mjs';
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
  for(const section of ['# 发布与验收计划','转录版本 3 · 纪要版本 2 · 人工修订','讨论主题','关键决策','验收表','发言人总结','行动候选','| 事项 | 负责人 | 时间 |','人工核对','[^1]: saved@1 01:01 说话人1 — 周五完成验收'])assert.ok(text.includes(section),section);
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

test('action exports retain project and uncertainty context',()=>{
 const record=createRecord('owner');record.capture='completed';record.minutesRevision=1;
 const evidence=[{segmentId:'s1',revision:1}];
 record.minutes={title:'项目',sections:[],topics:[{id:'a',title:'项目A'}],actions:[{text:'提交报告',topicId:'a',label:'范围',kind:'question',status:'pending',owner:null,due:null,evidence}]};
 assert.equal(sharedMinutes(record.minutes).actions[0].status,'pending');
 const candidate=JSON.parse(exportRecord(record,'issues')).candidates[0];
 assert.match(candidate.title,/待确认.*项目A.*范围.*提交报告/);
 assert.match(exportRecord(record,'ics'),/SUMMARY:.*待确认.*项目A.*范围.*提交报告/);
});

test('generated exports group each topic once and keep its table and timeline beside its prose',()=>{
 const evidence=[ref],record=fixture();record.minutes.edited=false;
 record.minutes.topics=[{id:'a',title:'机场信号',summary:'确认信号用途',evidence},{id:'b',title:'迁移',summary:'核对资源',evidence}];
 record.minutes.sections=[{heading:'机场信号',items:[{text:'确认信号用途',topicId:'a',evidence}]},{heading:'讨论过程 · 旧方案',items:[{text:'已过期窗口草稿',label:'过程记录',evidence}]}];
 record.minutes.tables=[{title:'信号规则',topicId:'a',columns:['信号','响应'],rows:[{cells:['红灯','停车'],evidence}]}];
 record.minutes.visuals=[{title:'联调节点',topicId:'a',kind:'timeline',entries:[{label:'周五',text:'联调',evidence},{label:'下周一',text:'验收',evidence}]}];
 record.minutes.actions=[];const before=JSON.stringify(record),markdown=exportMinutesMarkdown(record),board=feishuBoard(record.minutes);
 assert.doesNotMatch(markdown,/已过期窗口草稿|讨论过程/);
 assert.equal((markdown.match(/^#{2,3} 机场信号$/gm)||[]).length,1);
 assert.equal((markdown.match(/确认信号用途/g)||[]).length,1);
 assert.match(markdown,/^#### 信号规则$/m);assert.match(markdown,/^#### 联调节点$/m);
 assert.ok(markdown.indexOf('信号规则')<markdown.indexOf('### 迁移'));
 assert.ok(markdown.indexOf('联调节点')<markdown.indexOf('### 迁移'));
 assert.equal(board.filter(node=>node.id.endsWith('_heading')&&node.text?.text==='机场信号').length,1);
 assert.ok(!board.some(node=>node.text?.text?.includes('已过期窗口草稿')));
 record.minutes.edited=true;assert.match(exportMinutesMarkdown(record),/已过期窗口草稿/);
 record.minutes.edited=false;assert.equal(JSON.stringify(record),before);
});

test('exact action deduplication unions revisions but preserves project, responsibility and uncertainty',()=>{
 const base={id:'task-a',text:'核对配置',topicId:'a',owner:'李工',due:'周五',evidence:[ref]},before=JSON.stringify(base);
 const actions=[base,{...base,evidence:[{...ref,revision:2}]},...[
  {topicId:'b'},{owner:'王工'},{due:'下周一'},{status:'pending'},{label:'不同范围'},{kind:'question'}
 ].map(change=>({...base,...change}))];
 const result=uniqueMinutesItems(actions);
 assert.equal(result.length,7);assert.deepEqual(result[0].evidence,[ref,{...ref,revision:2}]);
 assert.equal(result[1],actions[2]);assert.equal(JSON.stringify(base),before);
});

test('duplicate evidence processing stays linear and retains unique item identity',()=>{
 let reads=0;const items=Array.from({length:3000},(_,i)=>({id:'task-a',text:'同一行动',evidence:[{get segmentId(){reads++;return `s${i}`;},revision:1}]}));
 const result=uniqueMinutesItems(items);assert.equal(result.length,1);assert.equal(result[0].evidence.length,3000);
 assert.ok(reads<=6000,`evidence reads: ${reads}`);
 const unique={text:'独立事项',evidence:[ref]};assert.equal(uniqueMinutesItems([unique])[0],unique);
 const minutes={sections:[{heading:'讨论过程',items:[{text:'历史保留',label:'过程记录',evidence:[ref]}]}],actions:[]};
 assert.equal(minutesReadingBranches(minutes).length,0);
 assert.equal(minutesReadingBranches({...minutes,edited:true})[0].items[0].text,'历史保留');
});

test('unknown tasks and distinct correction targets survive the sharing round trip',()=>{
 const actions=[{text:'提交报告',owner:null,due:null,evidence:[{segmentId:'project-a',revision:1}]},{text:'提交报告',owner:null,due:null,evidence:[{segmentId:'project-b',revision:1}]}];
 assert.equal(uniqueMinutesItems(actions).length,2);
 const changes=['a','b'].map(id=>({id:`change-${id}`,correctionOf:`target-${id}`,text:'延期，日期待定',status:'pending',evidence:[ref]}));
 const minutes={title:'两个项目',sections:[{heading:'跟进',items:changes}],actions:changes.map(item=>({...item,owner:null,due:null}))};
 assert.equal(minutesReadingBranches(minutes)[0].items.length,2);
 const shared=sharedMinutes(minutes,{includeEvidence:true});
 assert.equal(minutesReadingBranches(shared)[0].items.length,2);
 assert.equal(uniqueMinutesItems(shared.actions).length,2);
 assert.equal(uniqueMinutesItems([{id:'a',text:'参数 A  B',evidence:[ref]},{id:'a',text:'参数 A B',evidence:[ref]}]).length,2);
});

test('Markdown preview renders export structure as headings, rules and action tables',async()=>{
 const {build}=await import('esbuild'),{createRequire}=await import('node:module'),{resolve}=await import('node:path'),vm=await import('node:vm'),React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const compiled=await build({entryPoints:['apps/web/src/components/MarkdownPreview.tsx'],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom']});const module={exports:{}};vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,require:createRequire(resolve('package.json'))});
 const html=renderToStaticMarkup(React.createElement(module.exports.MarkdownPreview,{text:'# 会议结论\n\n---\n\n| 事项 | 负责人 |\n| --- | --- |\n| 验证候选 | 待确认 |\n\n<script>alert(1)</script>'}));
 assert.match(html,/<h2[^>]*>会议结论/);assert.match(html,/<hr/);assert.match(html,/<table/);assert.match(html,/待确认/);assert.doesNotMatch(html,/<script|>---</);
});
