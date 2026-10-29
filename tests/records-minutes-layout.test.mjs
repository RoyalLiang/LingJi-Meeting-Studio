import { minutesActionText } from '../packages/records/src/minutes-quality.mjs';
import { speakerLabels as sharedSpeakerLabels } from '../packages/records/src/minutes-speakers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({
  entryPoints: ['apps/web/src/components/Minutes.tsx'], bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'empty' },
  external: ['react', 'react/jsx-runtime', 'react-dom'],
});
const module = { exports: {} };
vm.runInNewContext(compiled.outputFiles[0].text, {
  module, exports: module.exports, require: createRequire(resolve('package.json')),
  matchMedia: () => ({ matches: false }), console, structuredClone,
});
const { MinutesPanel } = module.exports;
const discussionCompiled = await build({ entryPoints: ['apps/web/src/components/CurrentDiscussion.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'empty' }, external: ['react', 'react/jsx-runtime', 'react-dom'] });
const discussionModule = { exports: {} };
vm.runInNewContext(discussionCompiled.outputFiles[0].text, { module: discussionModule, exports: discussionModule.exports, require: createRequire(resolve('package.json')), console });
const { CurrentDiscussion } = discussionModule.exports;

test('paused discussion stays inactive while a queued or running minutes job remains visible', () => {
  const record = { id:'fixture',sources:[],transcription:'processing',capture:'paused',usage:{samples:16000},transcriptRevision:1,autoMinutes:{enabled:true} };
  for (const status of ['queued','running']) {
    const job={id:'unfinished-job',status,progress:{completed:1,total:4}};
    const html=renderToStaticMarkup(React.createElement(CurrentDiscussion,{record,minutes:null,job,modelReady:true}));
    assert.match(html,/正在处理AI纪要/);
    assert.equal((html.match(/正在处理AI纪要/g)||[]).length,1,'processing is shown once even while capture is paused');
    assert.match(html,/class="discussion-activity"/);
    assert.doesNotMatch(html,/discussion-activity is-active/);
    const resumed=renderToStaticMarkup(React.createElement(CurrentDiscussion,{record:{...record,capture:'recording'},minutes:null,job,modelReady:true}));
    assert.match(resumed,/discussion-activity is-active/);
  }
});
const helpers = {};
const helperSource = (await readFile(new URL('../apps/web/src/minutes-views.ts', import.meta.url), 'utf8'))
  .replace(/^import .*$/gm, '').replace(/export /g, '');
vm.runInNewContext(stripTypeScriptTypes(helperSource) + '\nObject.assign(exports,{topicTableLayout,summaryTables,topicDurations});', { exports: helpers, minutesActionText,speakerLabels:sharedSpeakerLabels });
const ref = (segmentId, revision = 1) => ({ segmentId, revision });
const minutes = () => ({
  title: '交付讨论', revision: 1, transcriptRevision: 3, edited: false,
  sections: [{ heading: '讨论重点', items: [
    { text: '发布时间明确。', evidence: [ref('release')] },
    { text: '测试范围明确。', evidence: [ref('quality')] },
  ] }],
  topics: [
    { title: '发布计划', summary: '按计划发布。', evidence: [ref('release')] },
    { title: '质量保障', summary: '先完成测试。', evidence: [ref('quality')] },
  ],
  tables: [{ title: '交付安排', columns: ['工作', '时间'], rows: [
    { cells: ['发布候选版', '周五'], evidence: [ref('release')] },
    { cells: ['回归测试', '周四'], evidence: [ref('quality')] },
    { cells: ['跨主题协调', '待确认'], evidence: [ref('release'), ref('quality')] },
    { cells: ['旧修订数据', '保留核对'], evidence: [ref('release', 9)] },
  ] }], actions: [], evidenceSnapshot: [],
});
function render(overrides = {}) {
  const record = { id: 'fixture', capture: 'recording', jobs: [], minutes: null,
    liveMinutes: minutes(), minutesRevision: 1, transcriptRevision: 3,
    usage: {samples:16000*4,llmTokens:0},
    autoMinutes: { enabled: true, intervalSeconds: 30 }, ...overrides };
  return renderToStaticMarkup(React.createElement(MinutesPanel, {
    record, busy: false, inline: true, onClose() {}, generate() {}, edit() {}, cite() {}, automate() {},
  }));
}
test('an old record without usage keeps the full minutes page readable with unknown counters',()=>{
 const html=render({usage:undefined});assert.match(html,/按主题整理的纪要/);assert.match(html,/本场用量/);assert.match(html,/<strong>—<\/strong>/);assert.match(html,/<strong>未提供<\/strong>/);assert.doesNotMatch(html,/0 token/);
});

test('AI tree places each table row inside its uniquely cited topic and preserves ambiguous rows', () => {
  const html = render();
  const branches = html.split('class="minutes-branch"').slice(1);
  assert.equal(branches.length, 4);
  assert.match(branches[0], /发布候选版/);
  assert.doesNotMatch(branches[0], /回归测试|跨主题协调|旧修订数据/);
  assert.match(branches[1], /回归测试/);
  assert.doesNotMatch(branches[1], /发布候选版|跨主题协调|旧修订数据/);
  assert.match(branches[2], /讨论重点/);
  assert.match(branches[2], /发布时间明确/);
  assert.match(branches[2], /测试范围明确/);
  assert.match(branches[3], /补充表格/);
  assert.match(branches[3], /跨主题协调/);
  assert.match(branches[3], /旧修订数据/);
  for (const text of ['发布候选版', '回归测试', '跨主题协调', '旧修订数据']) {
    assert.equal(html.split(text).length - 1, 1, `${text} is retained exactly once`);
  }
  assert.equal(html.split('scope="col">来源').length - 1, 3);
});

test('running minutes keep the topic tree visible without the default streaming block', () => {
  const html = render({ jobs: [{ status: 'running', scope: 'live', preview: [{ kind: 'heading', text: '正在写入的临时标题' }] }] });
  assert.match(html, /按主题整理的纪要/);
  assert.doesNotMatch(html, /正在归纳会中主题|正在写入的临时标题|class="streaming-minutes/);
});

test('legacy sections and action fallback tables retain row ownership without mutating minutes', () => {
  const value = minutes();
  value.topics = [];
  value.tables = [];
  value.actions = [{ text: '确认发布窗口', label:'项目A',kind:'question',owner: '说话人 1', due: '', evidence: [ref('release')] }];
  const before = JSON.stringify(value);
  const { branches, unassigned } = helpers.topicTableLayout(value);
  assert.equal(branches.length, 1);
  assert.equal(branches[0].tables[0].title, '行动候选汇总');
  assert.deepEqual(Array.from(branches[0].tables[0].rows[0].cells), ['待确认 · 项目A：确认发布窗口', '说话人 1']);
  assert.equal(unassigned.length, 0);
  assert.equal(JSON.stringify(value), before);
});

test('mixed valid and unmatched citations never imply table row ownership', () => {
  const value = minutes();
  value.tables[0].rows.push(
    { cells: ['部分片段缺失', '保留核对'], evidence: [ref('release'), ref('missing')] },
    { cells: ['混合新旧修订', '保留核对'], evidence: [ref('release'), ref('release', 9)] },
  );
  const layout = helpers.topicTableLayout(value);
  const assigned = layout.branches.flatMap(branch => branch.tables.flatMap(table => table.rows));
  assert.ok(assigned.every(row => !['部分片段缺失', '混合新旧修订'].includes(row.cells[0])));
  const remaining = layout.unassigned.flatMap(table => table.rows).map(row => row.cells[0]);
  assert.ok(remaining.includes('部分片段缺失'));
  assert.ok(remaining.includes('混合新旧修订'));
});

test('shared topic citations never guess an owner and table-only minutes remain visible', () => {
  const value = minutes();
  value.topics[1].evidence = [ref('release')];
  value.sections = [];
  const result = helpers.topicTableLayout(value);
  assert.ok(result.branches.every(branch => branch.tables.length === 0));
  assert.equal(result.unassigned[0].rows.length, value.tables[0].rows.length);
  const html = render({ liveMinutes: { ...value, topics: [] } });
  assert.match(html, /补充表格/);
  assert.match(html, /发布候选版/);
  assert.match(html, /跨主题协调/);
});

test('explicit topic tables stay whole inside the declared topic despite shared citations', () => {
  const value = minutes();
  value.topics[0].id = 'release'; value.topics[1].id = 'quality';
  value.tables = [{ title: '质量核对', topicId: 'quality', columns: ['事项', '结果'], rows: [
    { cells: ['发布回归覆盖', '已核对'], evidence: [ref('release'), ref('quality')] },
  ] }];
  const before = JSON.stringify(value);
  const layout = helpers.topicTableLayout(value);
  assert.equal(layout.branches[0].tables.length, 0);
  assert.equal(layout.branches[1].tables[0]?.rows.length, 1);
  assert.equal(layout.unassigned.length, 0);
  const html = render({ liveMinutes: value });
  const branches = html.split('class="minutes-branch"').slice(1);
  assert.doesNotMatch(branches[0], /发布回归覆盖/);
  assert.match(branches[1], /发布回归覆盖/);
  assert.doesNotMatch(html, /补充表格/);
  assert.equal(JSON.stringify(value), before);
});

test('large topic layouts index source identities instead of repeatedly scanning references', () => {
  let reads = 0;
  const topics = Array.from({ length: 30 }, (_, i) => ({ title: `主题${i}`, summary: '', evidence: Array.from({ length: 100 }, (_, j) => ({
    get segmentId() { reads++; return `s${i * 100 + j}`; }, revision: 1,
  })) }));
  const value = { title: '合成大纪要', topics, sections: [{ heading: '讨论', items: Array.from({ length: 2000 }, (_, i) => ({ text: `要点${i}`, evidence: [ref(`s${i}`)] })) }], actions: [], tables: [] };
  const layout = helpers.topicTableLayout(value);
  assert.equal(layout.branches.flatMap(branch => branch.items).length, 2000);
  assert.ok(reads <= 9000, `source identities read ${reads} times for 3000 references`);
});

test('topic coverage preserves exact revisions and merges overlapping cited intervals', () => {
  const value = minutes();
  value.evidenceSnapshot = [
    { id: 'release', revision: 1, startMs: 1000, endMs: 4000 },
    { id: 'quality', revision: 1, startMs: 3000, endMs: 5000 },
    { id: 'release', revision: 2, startMs: 9000, endMs: 12000 },
  ];
  value.topics[0].evidence = [ref('release'), ref('quality'), ref('release'), ref('missing')];
  value.topics[1].evidence = [ref('release', 2)];
  assert.deepEqual(Array.from(helpers.topicDurations(value)), [4000, 3000]);
});

test('large citation groups keep a compact initial view with an explicit disclosure', () => {
  const value = minutes();
  value.topics[0].evidence = Array.from({ length: 20 }, (_, i) => ref(`extra${i}`));
  const html = render({ liveMinutes: value });
  const first = html.split('class="minutes-branch"')[1];
  assert.equal((first.match(/class="citation-entry"/g) || []).length, 1);
  assert.match(first, /aria-label="查看 20 处引用原文"/);
  assert.doesNotMatch(first, />原文 · 20/);
});


test('all topic details stay visible and each paragraph shows only its frozen speakers', () => {
 const value=minutes();value.topics=[];value.tables=[];
 value.sections=[{heading:'完整讨论',items:Array.from({length:5},(_,i)=>({text:`讨论详情${i+1}`,evidence:[ref(i===4?'unmarked':'release')]}))}];
 value.evidenceSnapshot=[{id:'release',revision:1,speaker:'张工'},{id:'release',revision:2,speaker:'错误的新修订姓名'},{id:'unmarked',revision:1,speaker:''}];
 const html=render({liveMinutes:value});
 assert.doesNotMatch(html,/展开 .*条讨论细节|class="branch-detail"/);
 for(let i=1;i<=5;i++)assert.match(html,new RegExp(`讨论详情${i}`));
 assert.equal((html.match(/class="minute-speakers"/g)||[]).length,5);
  assert.match(html,/说话人1/);assert.match(html,/未区分说话人/);assert.doesNotMatch(html,/张工|错误的新修订姓名/);
});


test('minutes default to no generation preview and omit redundant in-progress captions',()=>{
 const job={status:'running',scope:'live',preview:[{kind:'text',text:'默认隐藏的生成过程'}],progress:{completed:1,total:2},partialMinutes:minutes()};
 const empty=render({liveMinutes:null,jobs:[{...job,partialMinutes:null}]});
 assert.doesNotMatch(empty,/默认隐藏的生成过程|class="streaming-minutes/);
 const partial=render({jobs:[job]});
 assert.doesNotMatch(partial,/正在更新 ·|AI 会中速记随讨论更新|minutes-stage-note/);
 assert.match(partial,/按主题整理的纪要/);
});

test('opening a meeting floats failed minutes recovery without reserving panel space', () => {
  const html=render({segments:[],jobs:[{id:'failed-job',status:'failed',transcriptRevision:3,error:'minutes_request_failed'}]});
  assert.match(html,/整理未完成/);
  assert.match(html,/toast feedback-toast glass/);assert.doesNotMatch(html,/feedback-toast[^"]*is-inline/);
  assert.match(html,/重新整理/);
});

test('AI processing is announced once in the dock capture label',()=>{
 const record={capture:'recording',transcription:'completed',sources:[],pendingChunks:0,transcriptRevision:1,usage:{samples:16000},autoMinutes:{enabled:true}};
 const html=renderToStaticMarkup(React.createElement(CurrentDiscussion,{record,minutes:null,job:{status:'running',progress:{completed:1,total:3}},modelReady:true}));
 assert.match(html,/class="discussion-capture-state"[^>]*>正在处理AI纪要/);
 assert.equal((html.match(/正在处理AI纪要/g)||[]).length,1);
 assert.doesNotMatch(html,/class="discussion-status"/);
 const issue=renderToStaticMarkup(React.createElement(CurrentDiscussion,{record:{...record,transcription:'failed'},minutes:null,job:{status:'running'},modelReady:true}));
 assert.match(issue,/class="discussion-status"/,'ASR failures must remain visible while minutes run');
});

test('an empty chapter shows an explicit empty state rather than a bare tree trunk',()=>{
 const value=minutes();value.topics=[];value.sections=[{heading:'空章节',items:[]}];value.actions=[];value.tables=[];value.highlights=[];value.visuals=[];
 const html=render({liveMinutes:value});assert.doesNotMatch(html,/class="minutes-branch"/);assert.match(html,/尚无可展示的主题/);
});
