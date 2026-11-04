import test from 'node:test';
import assert from 'node:assert/strict';
import {minutesSummaryBlocks,summaryBlocksHtml} from '../packages/records/src/minutes-summary.mjs';
import {feishuBlocks} from '../services/records/src/integrations/feishu.mjs';

const evidence=[{segmentId:'s1',revision:2}];
const fixture=()=>({edited:true,highlights:[{text:'按已确认范围推进',evidence}],decisions:[{text:'先核对字段',evidence}],actions:[{text:'补充用例',owner:null,due:null,evidence}],sections:[]});
const content=graph=>graph.descendants.flatMap(block=>(block.text||block.bullet||block.heading2)?.elements||[]).map(element=>element.text_run.content).join('\n');

test('summary is a complete editable DocX graph of callouts, columns and a native table',()=>{
  const graph=minutesSummaryBlocks(fixture(),{citations:refs=>refs.length?' [1]':''});
  assert.deepEqual(feishuBlocks({first_level_block_ids:graph.children_id,blocks:graph.descendants}),graph);
  assert.ok(graph.descendants.every(block=>[2,4,12,19,24,25,31,32].includes(block.block_type)));
  assert.equal(graph.descendants.filter(block=>block.block_type===19).length,4);
  assert.equal(graph.descendants.filter(block=>block.block_type===25).length,3);
  for(const block of graph.descendants.filter(block=>[19,25,32].includes(block.block_type)))assert.ok(block.children.length>0);
  const table=graph.descendants.find(block=>block.block_type===31);assert.equal(table.children.length,table.table.property.row_size*4);
  const text=content(graph);assert.match(text,/按已确认范围推进 \[1\]/);assert.match(text,/负责人待确认/);assert.match(text,/时间待确认/);
  assert.doesNotMatch(JSON.stringify(graph),/"image"|"board"|"svg"|"merge_info"/);
});

test('summary preserves manual duplicate actions and renders all rows across bounded native tables',()=>{
  const minutes=fixture();minutes.actions=Array.from({length:81},()=>({...minutes.actions[0],owner:'负责人原话',due:'下周'}));
  const graph=minutesSummaryBlocks(minutes),tables=graph.descendants.filter(block=>block.block_type===31);
  assert.equal(tables.length,3);assert.equal(tables.reduce((total,block)=>total+block.table.property.row_size-1,0),81);
  assert.ok(tables.every(block=>block.children.length<=164));
  assert.equal(graph.descendants.filter(block=>block.block_type===12&&block.bullet.elements[0].text_run.content.startsWith('补充用例')).length,81);
});

test('native preview renders the frozen blocks as selectable semantic content and escapes untrusted text',()=>{
  const minutes=fixture();minutes.highlights[0].text='<img src=x onerror=alert(1)> & "原话"';
  const graph=minutesSummaryBlocks(minutes),html=summaryBlocksHtml(graph);
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<svg|<canvas|<script/i);
  assert.match(html,/<aside/);assert.match(html,/minutes-summary-columns/);assert.match(html,/<table><thead><tr><th scope="col">/);
  assert.match(html,/负责人待确认/);assert.match(html,/&amp;/);
  const first=graph.descendants.find(block=>block.text);first.text.elements[0].text_run.content='冻结后的原生内容';assert.match(summaryBlocksHtml(graph),/冻结后的原生内容/);
});

test('empty or theme-only summaries keep containers valid without inventing decisions or assignments',()=>{
  const graph=minutesSummaryBlocks({topics:[{id:'topic',title:'接口',summary:'保留主题概述',evidence}],actions:[],sections:[]});
  assert.match(content(graph),/主题概览/);assert.match(content(graph),/保留主题概述/);assert.match(content(graph),/纪要未列出/);
  assert.ok(!graph.descendants.some(block=>block.block_type===31));
  assert.doesNotThrow(()=>feishuBlocks({first_level_block_ids:graph.children_id,blocks:graph.descendants}));
});
