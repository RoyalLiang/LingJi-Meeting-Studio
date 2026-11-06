import test from 'node:test';
import assert from 'node:assert/strict';
import {minutesSkillDsl} from '../packages/records/src/meeting-minutes-skill.mjs';
const evidence=[{segmentId:'s1',revision:1}];
const fixture=()=>({title:'接口排障',revision:1,transcriptRevision:1,topics:[{id:'t1',title:'接口与配置',summary:'核对配置再测试',evidence}],sections:[{heading:'接口与配置',items:[{text:'字段使用当前版本',kind:'fact',topicId:'t1',evidence},{text:'版本兼容性尚未确认',kind:'risk',status:'unconfirmed',topicId:'t1',evidence},{text:'是否需要更新配置',kind:'question',status:'pending',topicId:'t1',evidence}]}],highlights:[{text:'先核对来源',evidence}],decisions:[{text:'保持当前配置',evidence}],actions:[{text:'核对日志',owner:null,due:null,status:'candidate',evidence}],tables:[],visuals:[]});
test('actual minutes kinds route into distinct native cards rather than plain strings',()=>{
 const minutes=fixture(),before=JSON.stringify(minutes),data=minutesSkillDsl(minutes),types=new Set(data.sections.flatMap(s=>s.items).filter(i=>i&&typeof i==='object').map(i=>i.type));
 for(const type of ['grid','risk-matrix','status-table','quote-decision','action-list'])assert.ok(types.has(type),'Missing routed card: '+type);
 assert.equal(JSON.stringify(minutes),before);
});

test('routed pages retain every item, citation and manual duplicate within a readable scene budget',async()=>{
 const {compileMeetingMinutesPages}=await import('../packages/records/src/meeting-minutes-skill.mjs');
 const m=fixture();m.edited=true;m.sections[0].items=Array.from({length:70},(_,i)=>({text:`原文事实 ${i}：仅核对配置，不代表已经更新。`,kind:'fact',evidence}));
 m.sections[0].items.push({...m.sections[0].items[0]});const before=JSON.stringify(m),pages=compileMeetingMinutesPages(minutesSkillDsl(m,{citations:()=> ' [1]'}));
 assert.ok(pages.length>1);assert.ok(pages.every(p=>p.nodes[0].height<=1000));
 const text=pages.flatMap(p=>p.nodes.flatMap(n=>[n.text?.text,...(n.table?.cells||[]).map(c=>c.text?.text)])).filter(Boolean).join('\n').replace(/\s/g,'');
 for(const item of m.sections[0].items)assert.ok(text.includes(item.text.replace(/\s/g,'')),item.text);
 assert.equal(text.split(m.sections[0].items[0].text.replace(/\s/g,'')).length-1,2);
 assert.match(text,/\[1\]/);assert.equal(JSON.stringify(m),before);
 for(const page of pages){
  assert.ok(!page.nodes.some(n=>n.type==='section'));
  const title=page.nodes.find(n=>n.id==='wb_title');assert.equal(title.text.text.replaceAll('\n',''),page.title);assert.equal(title.type,'text_shape');
 }
});

test('unknown content never creates inferred metrics, dates, owners or dependency graphs',()=>{
 const m=fixture();m.decisions=[];m.actions=[];m.sections[0].items=[{kind:'fact',text:'服务号 301 的更新时间尚未确定。',evidence},{kind:'mystery',text:'10% 只是一个待验证的假设。',evidence}];
 const d=minutesSkillDsl(m),cards=d.sections.flatMap(s=>s.items).filter(i=>i&&typeof i==='object');
 assert.ok(cards.every(c=>!['kpi','funnel-metric','timeline','flow','branch','action-list'].includes(c.type)));
 assert.match(JSON.stringify(d),/更新时间尚未确定/);
});

test('automatic status layouts keep manual duplicate questions and source table cells distinct',async()=>{
 const {compileMeetingMinutesPages}=await import('../packages/records/src/meeting-minutes-skill.mjs');
 const m=fixture(),wording='需要再次核对接口';m.edited=true;m.highlights=[];m.decisions=[];m.actions=[];m.sections[0].items=[0,1].map(()=>({text:wording,kind:'question',status:'pending',topicId:'t1',evidence}));
 let cells=compileMeetingMinutesPages(minutesSkillDsl(m)).flatMap(p=>p.nodes.flatMap(n=>n.table?.cells||[]));
 assert.equal(cells.filter(c=>c.text.text.replaceAll('\n','').includes(wording)).length,2);
 m.sections[0].items=[];m.tables=[{title:'检查记录',topicId:'t1',columns:['对象','状态'],rows:[{cells:['接口甲','待确认'],evidence},{cells:['接口甲','待确认'],evidence}]}];
 cells=compileMeetingMinutesPages(minutesSkillDsl(m)).flatMap(p=>p.nodes.flatMap(n=>n.table?.cells||[]));assert.equal(cells.filter(c=>c.text.text==='接口甲').length,2);
});
