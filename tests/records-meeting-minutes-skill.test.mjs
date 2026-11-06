import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileMeetingMinutesBoard,minutesSkillDsl} from '../packages/records/src/meeting-minutes-skill.mjs';
import {boardSvg} from '../packages/records/src/minutes-presentation.mjs';

const base=new URL('../services/records/src/data/skills/meeting-minutes/',import.meta.url);
const sample=JSON.parse(await readFile(new URL('examples/sample-feishu-screenshot.json',base)));
const cards=sample.sections.flatMap(section=>section.items).filter(item=>item.type);

const allText=nodes=>nodes.flatMap(n=>[n.section?.title,n.text?.text,...(n.table?.cells||[]).map(c=>c.text?.text)]).filter(Boolean).join('\n');
// Match the coordinate behavior observed in the actual Feishu renderer.
const worldNodes=nodes=>{
  const index=new Map(nodes.map(n=>[n.id,n]));
  const resolve=n=>{
    let frame=index.get(n.parent_id);
    while(frame?.type==='group')frame=index.get(frame.parent_id);
    const origin=frame?resolve(frame):{x:0,y:0};
    return {...n,x:(n.x||0)+origin.x,y:(n.y||0)+origin.y};
  };
  return nodes.map(resolve);
};

test('bundled skill preserves every original file and its archive provenance',async()=>{
  const manifest=JSON.parse(await readFile(new URL('manifest.json',base)));
  assert.equal(manifest.id,'meeting-minutes/20261106');assert.match(manifest.archiveSha256,/^[a-f0-9]{64}$/);
  assert.equal(Object.keys(manifest.files).length,12);
  for(const [path,hash] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(await readFile(new URL(path,base))).digest('hex'),hash,path);
});
test('all twelve cards use editable native geometry with valid parents, attachments and bounds',()=>{
  assert.equal(new Set(cards.map(c=>c.type)).size,12);
  for(const card of cards){
    const nodes=compileMeetingMinutesBoard({title:'卡片验证',sections:[{title:card.type,items:[card]}]}),ids=new Set(nodes.map(n=>n.id)),world=worldNodes(nodes);
    assert.equal(ids.size,nodes.length);assert.ok(nodes.length<3000);
    assert.ok(nodes.some(n=>n.type==='section'));assert.ok(nodes.some(n=>n.type==='group'));
    for(const node of world){
      if(node.parent_id)assert.ok(ids.has(node.parent_id));
      if(node.type==='connector')for(const end of ['start','end'])assert.ok(ids.has(node.connector[end].attached_object.id));
      else {
        assert.ok(node.width>0&&node.height>0);assert.ok(node.x>=0&&node.y>=0);
        assert.ok(node.x+node.width<=nodes[0].width+.2,card.type+': '+node.id);
        assert.ok(node.y+node.height<=nodes[0].height+.2,card.type+': '+node.id);
      }
    }
    const svg=boardSvg(nodes);assert.match(svg,/卡片验证/);assert.doesNotMatch(svg,/undefined|NaN|<foreignObject/);
    const text=world.filter(n=>n.text?.text);
    for(const [i,a] of text.entries())for(const b of text.slice(i+1)){
      const ox=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x),oy=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);
      assert.ok(ox<.2||oy<.2,`${card.type}: ${a.id}/${b.id}`);
    }
    if(card.type==='branch')assert.ok(nodes.some(n=>n.composite_shape?.type==='flow_chart_diamond'));
    if(card.type==='funnel-metric')assert.ok(nodes.some(n=>n.composite_shape?.type==='flow_chart_trapezoid'));
    if(['table','status-table'].includes(card.type))assert.ok(nodes.some(n=>n.type==='table'));
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
test('wide native tables keep one-based cells, readable columns and expanded canvas bounds',()=>{
  for(const count of [8,40]){
    const nodes=compileMeetingMinutesBoard({sections:[{items:[{type:'table',headers:['组',...Array(count-1).fill('较长的中文列标题'.repeat(4))],rows:[['中国',...Array(count-1).fill('需要完整保留的长中文内容'.repeat(4))]]}]}]});
    const grid=worldNodes(nodes).find(n=>n.type==='table');
    assert.equal(grid.table.cells.length,count*2);assert.ok(grid.table.meta.col_sizes.every(w=>w>=96));
    assert.ok(grid.x+grid.width<=nodes[0].width);
    assert.ok(grid.table.cells.every(c=>c.row_index>=1&&c.col_index>=1));assert.match(allText(nodes),/中国/);
  }
  const grouped=compileMeetingMinutesBoard({sections:[{items:[{type:'status-table',headers:['组','状态'],rows:[['iOS','正常'],['iOS','关注'],['Android','阻塞']]}]}]}).find(n=>n.type==='table');
  assert.deepEqual(grouped.table.cells.find(c=>c.row_index===2&&c.col_index===1).merge_info,{row_span:2,col_span:1});
  assert.ok(!grouped.table.cells.some(c=>c.row_index===3&&c.col_index===1));
});

test('zero and tiny funnel percentages keep their source labels without zero-width shapes',()=>{
  const nodes=compileMeetingMinutesBoard({sections:[{items:[{type:'funnel-metric',bars:[{pct:0,val:'0%'},{pct:.001,val:'0.001%'},{pct:100,val:'100%'}]}]}]});
  assert.ok(nodes.filter(n=>n.type!=='connector').every(n=>n.width>0));
  assert.equal(nodes.filter(n=>n.composite_shape?.type==='flow_chart_trapezoid').length,2);assert.match(allText(nodes),/0.001%/);
});

test('native sections provide semantic titles and coordinate frames through nested logical groups',()=>{
  const data={sections:[{title:'结论',color:'blue',items:['保留原文']},{title:'行动',color:'green',items:[{type:'action-list',actions:[{t:'补齐用例',owner:'林',s:'todo'},{t:'核对字段',s:'active'}]}]},{title:'风险',color:'amber',items:['尚未上线']}]},nodes=compileMeetingMinutesBoard(data),world=worldNodes(nodes);
  const sections=world.filter(n=>n.type==='section');
  assert.deepEqual(sections.map(n=>n.section.title),['结论','行动','风险']);assert.equal(new Set(sections.map(n=>n.style.fill_color)).size,3);
  for(const node of world.filter(n=>n.parent_id&&n.type!=='connector')){
    const parent=world.find(n=>n.id===node.parent_id);
    assert.ok(node.x>=parent.x-.2&&node.y>=parent.y-.2,node.id);
    assert.ok(node.x+node.width<=parent.x+parent.width+.2,node.id);
    assert.ok(node.y+node.height<=parent.y+parent.height+.2,node.id);
  }
  const svg=boardSvg([{id:'s',type:'section',x:100,y:200,width:400,height:400,section:{title:'分区'}},{id:'g',type:'group',parent_id:'s',x:20,y:40,width:300,height:300},{id:'g2',type:'group',parent_id:'g',x:30,y:50,width:200,height:200},{id:'t',type:'text_shape',parent_id:'g2',x:40,y:60,width:80,height:30,text:{text:'定位',font_size:16}}]);
  assert.match(svg,/<text x="140"/);assert.doesNotMatch(svg,/<text x="190"/);
});

test('all example cards preserve their source facts including native table cells',()=>{
  const factual=new Set(['title','t','d','desc','label','root','hub','from','to','delta','fromLabel','toLabel','time','owner','meta','tag','verdict','speaker','role','text','impact','val','note','risk','mitigation','p','due','headers','rows','items']);
  const collect=(value,key='',result=[])=>{
    if(Array.isArray(value))for(const child of value)collect(child,key,result);
    else if(value&&typeof value==='object')for(const [name,child] of Object.entries(value))collect(child,name,result);
    else if(typeof value==='string'&&factual.has(key)&&value)result.push(value);
    return result;
  };
  for(const card of cards){
    const text=allText(compileMeetingMinutesBoard({sections:[{title:card.title,items:[card]}]})).replace(/\s/g,'');
    for(const fact of collect(card))assert.ok(text.includes(fact.replace(/\s/g,'')),`${card.type}: ${fact}`);
  }
  const unknown=allText(compileMeetingMinutesBoard({sections:[{items:[{type:'risk-matrix',risks:[{risk:'核对降级'}]}]}]}));
  assert.match(unknown,/待确认/);assert.doesNotMatch(unknown,/MED|HIGH/);
});

test('negated and tentative status labels never imply acceptance or completion through color',()=>{
  for(const tag of ['不采纳','暂不采纳','尚未确定','待确定','暂未确定','待确认是否采纳','最终采纳 ✓','已确定','选定']){
    const panel=compileMeetingMinutesBoard({sections:[{items:[{type:'pros-cons',left:{t:'方案',tag},right:{t:'备选'}}]}]}).find(n=>n.id==='s0_c0_panel_bg0');
    assert.equal(panel.style.fill_color,['最终采纳 ✓','已确定','选定'].includes(tag)?'#dff5e5':'#ffffff',tag);
  }
  const grid=compileMeetingMinutesBoard({sections:[{items:[{type:'status-table',headers:['状态'],rows:[['不正常'],['not completed'],['🟢 正常'],['🔴 阻塞']]}]}]}).find(n=>n.type==='table');
  assert.deepEqual(grid.table.cells.slice(1).map(c=>c.style.fill_color),['#ffffff','#ffffff','#dff5e5','#fee3e2']);
});

test('long tentative dates stay within their timeline row and section',()=>{
  const time='日期待上级批准，当前只是假设时间。'.repeat(10),nodes=worldNodes(compileMeetingMinutesBoard({sections:[{title:'时间待确认',items:[{type:'timeline',events:[{time,t:'首轮核对'},{time:'时间待确认',t:'下一轮核对'}]}]}]}));
  const date=nodes.find(n=>n.id==='s0_c0_date0'),next=nodes.find(n=>n.id==='s0_c0_date1'),section=nodes.find(n=>n.type==='section');
  assert.ok(next.y>=date.y+date.height);assert.ok(next.y+next.height<=section.y+section.height);
  assert.equal(date.text.text.replaceAll('\n',''),time);
});
