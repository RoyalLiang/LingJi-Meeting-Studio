import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileMeetingMinutesBoard,minutesSkillDsl} from '../packages/records/src/meeting-minutes-skill.mjs';
import {boardSvg} from '../packages/records/src/minutes-presentation.mjs';

const base=new URL('../services/records/src/data/skills/meeting-minutes/',import.meta.url);
const sample=JSON.parse(await readFile(new URL('examples/sample-feishu-screenshot.json',base)));
const cards=sample.sections.flatMap(section=>section.items).filter(item=>item.type);
test('bundled skill preserves every original file and its archive provenance',async()=>{
  const manifest=JSON.parse(await readFile(new URL('manifest.json',base)));
  assert.equal(manifest.id,'meeting-minutes/20261106');assert.match(manifest.archiveSha256,/^[a-f0-9]{64}$/);
  assert.equal(Object.keys(manifest.files).length,12);
  for(const [path,hash] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(await readFile(new URL(path,base))).digest('hex'),hash,path);
});
test('all twelve cards compile to native shapes and request-local attached connectors',()=>{
  assert.equal(new Set(cards.map(c=>c.type)).size,12);
  for(const card of cards){
    const nodes=compileMeetingMinutesBoard({title:'卡片验证',sections:[{title:card.type,items:[card]}]}),ids=new Set(nodes.map(n=>n.id));
    assert.equal(ids.size,nodes.length);assert.ok(nodes.length<3000);
    for(const node of nodes){
      if(node.type==='connector')for(const end of ['start','end'])assert.ok(ids.has(node.connector[end].attached_object.id));
      else {assert.ok(node.width>0&&node.height>0);assert.ok(node.x+node.width<=nodes[0].width+.2);assert.ok(node.y+node.height<=nodes[0].height+.2);assert.equal(node.text.vertical_align,'mid');assert.equal(typeof node.style.border_width,'string');}
    }
    const svg=boardSvg(nodes);assert.match(svg,/卡片验证/);assert.doesNotMatch(svg,/undefined|NaN|<foreignObject/);
    const text=nodes.filter(n=>n.text?.text);for(const [i,a] of text.entries())for(const b of text.slice(i+1)){const ox=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x),oy=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);assert.ok(ox<.2||oy<.2,`${card.type}: ${a.id}/${b.id}`);}
  }
});
test('long CJK, source citations, missing owners, manual duplicates and escaping survive export',()=>{
  const wording='人工修订保留 47.5% → 79.6%；11-12 待确认，不得视为已发布。'.repeat(40),ref=[{segmentId:'s1',revision:2}];
  const minutes={title:'<script>不可执行</script>',edited:true,revision:3,transcriptRevision:2,highlights:[],sections:[{heading:'完整讨论',items:[{text:wording,evidence:ref},{text:wording,evidence:ref}]}],actions:[{text:'补齐证据',evidence:ref}],visuals:[],tables:[]};
  const data=minutesSkillDsl(minutes,{citations:refs=>refs.length?' [1]':''}),nodes=compileMeetingMinutesBoard(data),text=nodes.map(n=>n.text?.text||'').join('\n').replaceAll('\n','');
  assert.ok(text.includes(wording+' [1]'+wording+' [1]'));assert.match(text,/负责人待确认|待确认/);assert.match(text,/人工修订/);
  const svg=boardSvg(nodes);assert.doesNotMatch(svg,/<script>/);assert.match(svg,/&lt;script&gt;/);
});
test('oversized boards and invalid funnel values fail before a remote write is possible',()=>{
  assert.throws(()=>compileMeetingMinutesBoard({sections:[{items:[{type:'funnel-metric',bars:[{pct:101}]}]}]}),{code:'invalid_meeting_minutes_skill'});
  assert.throws(()=>compileMeetingMinutesBoard({sections:[{items:[{type:'table',rows:Array.from({length:1600},()=>['a','b'])}]}]}),{code:'feishu_document_too_large'});
});
test('uneven and wide tables retain minimum readable columns inside the expanded canvas',()=>{
  for(const count of [8,40]){
    const nodes=compileMeetingMinutesBoard({sections:[{items:[{type:'table',headers:['组',...Array(count-1).fill('较长的中文列标题'.repeat(4))],rows:[['中国',...Array(count-1).fill('需要完整保留的长中文内容'.repeat(4))]]}]}]});
    const cells=nodes.filter(n=>n.id.includes('_cell'));
    assert.equal(cells.length,count*2);assert.ok(cells.every(n=>n.width>=96));
    for(const n of cells)assert.ok(n.x+n.width<=nodes[0].width);
    assert.ok(nodes.some(n=>n.text?.text==='中国'));
  }
});
test('zero, tiny positive and full funnel percentages never generate zero-width nodes',()=>{
  const nodes=compileMeetingMinutesBoard({sections:[{items:[{type:'funnel-metric',bars:[{pct:0,val:'0%'},{pct:.001,val:'0.001%'},{pct:100,val:'100%'}]}]}]});
  assert.ok(nodes.every(n=>n.width>0));assert.equal(nodes.filter(n=>n.id.endsWith('_bar')).length,2);
  assert.ok(nodes.some(n=>n.text?.text==='0.001%'));
});
test('sections have distinct native frames, numbered headers and semantic accents',()=>{
  const data={sections:[{title:'结论',color:'blue',items:['保留原文']},{title:'行动',color:'green',items:['负责人待确认']},{title:'风险',color:'amber',items:['尚未上线']}]},nodes=compileMeetingMinutesBoard(data);
  for(let i=0;i<3;i++){
    const frame=nodes.find(n=>n.id===`sec${i}_frame`),accent=nodes.find(n=>n.id===`sec${i}_accent`),header=nodes.find(n=>n.id===`sec${i}_title`);
    assert.equal(frame.style.border_style,'solid');assert.equal(accent.height,frame.height);assert.match(header.text.text,new RegExp('^0'+(i+1)));
    assert.ok(frame.y+frame.height>header.y+header.height);
  }
  assert.equal(new Set(nodes.filter(n=>n.id.endsWith('_accent')).map(n=>n.style.fill_color)).size,3);
});
