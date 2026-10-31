import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {transform} from 'esbuild';

const source=await readFile(new URL('../apps/web/src/components/MeetingHighlights.tsx',import.meta.url),'utf8');
const code=(await transform(source.replace(/^import .*$/gm,'').replace('export function','function')+'\nexports.render=MeetingHighlights;',{loader:'tsx'})).code;
const icon=()=>React.createElement('svg',{'aria-hidden':true}),sandbox={exports:{},React,useState:React.useState,CaretDown:icon,CaretUp:icon,Sparkle:icon,X:icon,Button:({children,variant,...props})=>React.createElement('button',props,children),CloseButton:({label,onClick})=>React.createElement('button',{'aria-label':label,onClick})};
vm.runInNewContext(code,sandbox);
const minutes={highlights:[{text:'已有重点不因重试失败而丢失。',evidence:[]}],topics:[],sections:[{items:[{kind:'question',text:'仍需核对的规格数据。'}]}],actions:[]};
const render=props=>renderToStaticMarkup(React.createElement(sandbox.exports.render,{minutes,ended:true,id:'focus-record',busy:false,collapsed:false,toggleCollapsed(){},close(){},retry(){},...props}));

test('failed regeneration preserves available highlights without embedding the failure toast',()=>{
 const html=render({job:{status:'failed'}});
 assert.match(html,/已有重点不因重试失败而丢失/);assert.match(html,/上次整理的重点/);
 assert.doesNotMatch(html,/模型整理超过处理时限|feedback-toast/);
 assert.doesNotMatch(html,/<footer|基于本场|本场没有明确安排|最终重点尚未整理完成/);
});
test('a meeting with no final minutes shows the real waiting or empty state',()=>{
 assert.match(render({minutes:null,job:{status:'running'}}),/正在整理最终重点/);
 assert.doesNotMatch(render({minutes:null,job:undefined}),/正在整理/);
 assert.match(render({minutes:null,job:undefined}),/尚未生成最终纪要/);
 assert.match(render({minutes:null,job:{status:'failed'}}),/尚无最终重点/);
});
test('focus keeps topic summaries and omits next steps while preserving action data',()=>{
 const value={...minutes,highlights:[],topics:[{summary:'完整主题结论。',evidence:[]}],actions:[{text:'核对测试配置。',owner:'负责人甲',due:'下次会议'}]};
 const html=render({minutes:value});
 assert.ok(html.includes('完整主题结论'));
 for(const text of ['下一步','核对测试配置','负责人甲','下次会议'])assert.ok(!html.includes(text));
 assert.equal(value.actions.length,1);
 assert.match(html,/收起为一行/);assert.match(html,/aria-expanded="true"/);
});

test('controlled compact state keeps concise failure status without duplicating the toast',()=>{
 const html=render({collapsed:true,job:{status:'failed'}});
 assert.match(html,/整理未完成，转录已保留/);assert.match(html,/aria-expanded="false"/);assert.doesNotMatch(html,/完整错误详情|meeting-highlights-content/);
});

test('the focus headline follows the synthesized topic title rather than the first rolling fact',()=>{
 const first='合成场景：本轮称响应时间已控制在3秒以内，但P90降幅存在53%与45%两种口径。';
 for(const title of ['推理评测口径与训练资源复核','模型发布进展与评测口径复核']){
  const value={...minutes,title,highlights:[{text:first,evidence:[]},{text:'模型已发布，评测口径仍待核实。',evidence:[]}],topics:[{title:'推理评测',summary:first,evidence:[]},{title:'模型发布',summary:'确认发布进展',evidence:[]}]};
  const html=render({minutes:value,ended:false});
  assert.match(html,new RegExp('class="meeting-highlights-lead">'+title+'<'));
  assert.ok(html.includes('<li>'+first+'</li>'),'the former first point must remain in the list');
  assert.match(render({minutes:value,collapsed:true}),new RegExp('meeting-highlights-inline-lead">'+title+'<'));
 }
});
