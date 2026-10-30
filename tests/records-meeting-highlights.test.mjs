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

test('failed regeneration preserves available highlights and renders the incident once without a footer',()=>{
 const html=render({job:{status:'failed'},notice:React.createElement('p',null,'模型整理超过处理时限')});
 assert.match(html,/已有重点不因重试失败而丢失/);assert.match(html,/上次整理的重点/);
 assert.equal(html.match(/模型整理超过处理时限/g)?.length,1);
 assert.doesNotMatch(html,/<footer|基于本场|本场没有明确安排|最终重点尚未整理完成/);
});
test('a meeting with no final minutes shows the real waiting or empty state',()=>{
 assert.match(render({minutes:null,job:{status:'running'}}),/正在整理最终重点/);
 assert.doesNotMatch(render({minutes:null,job:undefined}),/正在整理/);
 assert.match(render({minutes:null,job:undefined}),/尚未生成最终纪要/);
 assert.match(render({minutes:null,job:{status:'failed'},notice:React.createElement('p',null,'失败原因')}),/尚无最终重点/);
});
test('topic summaries are used when highlights are absent and explicit actions retain owner and due time',()=>{
 const html=render({minutes:{...minutes,highlights:[],topics:[{summary:'完整主题结论。',evidence:[]}],actions:[{text:'核对测试配置。',owner:'负责人甲',due:'下次会议'}]}});
 for(const text of ['完整主题结论','核对测试配置','负责人甲','下次会议'])assert.ok(html.includes(text));
 assert.match(html,/收起为一行/);assert.match(html,/aria-expanded="true"/);
});

test('controlled compact state keeps the incident visible without duplicating the full error',()=>{
 const html=render({collapsed:true,job:{status:'failed'},notice:React.createElement('p',null,'完整错误详情')});
 assert.match(html,/整理未完成，转录已保留/);assert.match(html,/aria-expanded="false"/);assert.doesNotMatch(html,/完整错误详情|meeting-highlights-content/);
});
