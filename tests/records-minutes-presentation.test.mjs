import test from 'node:test';
import assert from 'node:assert/strict';
import {minutesOverview,minutesBoard,boardSvg} from '../packages/records/src/minutes-presentation.mjs';
import {feishuBoard} from '../services/records/src/integrations/feishu-board.mjs';
import {exportMinutesMarkdown} from '../services/records/src/markdown-export.mjs';

const evidence=[{segmentId:'s1',revision:2}];
const fixture=()=>({title:'接口评审',revision:3,transcriptRevision:2,highlights:[{text:'先验证再扩围',evidence}],decisions:[{text:'字段保持一致',evidence}],topics:[{id:'a',title:'接口',summary:'先核对字段',evidence}],sections:[{heading:'接口',items:[{text:'试运行时间待确认',kind:'question',topicId:'a',evidence}]}],actions:[{text:'补充重连用例',owner:null,due:null,evidence}],tables:[{title:'方案对比',topicId:'a',columns:['方案','结果'],rows:[{cells:['首轮','待验证'],evidence}]}],visuals:[{kind:'timeline',title:'推进节点',topicId:'a',entries:[{label:'周五',text:'评审',evidence},{label:'时间待确认',text:'试运行',evidence}]}]});

test('overview preserves unresolved owners, source versions and manual duplicates without inventing conclusions',()=>{
  const minutes=fixture(),before=JSON.stringify(minutes),view=minutesOverview(minutes);
  assert.equal(view.summary[0].text,'先验证再扩围');
  assert.ok(view.pending.some(item=>item.text.includes('负责人待确认')&&item.text.includes('时间待确认')));
  assert.deepEqual(view.decisions[0].evidence,evidence);
  assert.equal(JSON.stringify(minutes),before);
  minutes.edited=true;minutes.decisions.push({...minutes.decisions[0]});assert.equal(minutesOverview(minutes).decisions.length,2);
  delete minutes.highlights;assert.equal(minutesOverview(minutes).summaryLabel,'主题概览');
  assert.equal(minutesOverview(minutes).summary[0].text,'先核对字段');
});

test('native export contains top summary blocks, editable tables, timeline and version citations',()=>{
  const minutes=fixture(),references=new Map();
  const markdown=exportMinutesMarkdown({minutes,capture:'completed',title:minutes.title},{referenceMap:references});
  const nodes=minutesBoard(minutes,{citations:refs=>refs.length?` [${references.get('s1@2').number}]`:''});
  const text=nodes.filter(node=>node.type==='text_shape').map(node=>node.text.text).join('\n');
  assert.match(text,/会议总览[\s\S]*核心结论[\s\S]*关键决策[\s\S]*下一步行动[\s\S]*风险与待确认[\s\S]*推进安排[\s\S]*主题脉络图/);
  assert.match(text,/方案对比[\s\S]*待验证/);assert.match(text,/推进节点[\s\S]*周五：评审/);
  assert.match(text,/转录 v2 · 纪要 v3/);assert.match(text,/\[1\]/);assert.match(markdown,/\[\^1\]/);
  assert.ok(nodes.some(node=>node.type==='connector'));
  assert.ok(nodes.every(node=>['composite_shape','text_shape','connector'].includes(node.type)));
});

test('long CJK content and citations stay within the board bounds and text boxes',()=>{
  const minutes=fixture();minutes.sections[0].items[0].text='很长的待确认内容'.repeat(160);minutes.actions[0].text='保留人工输入'.repeat(200);
  const nodes=minutesBoard(minutes,{citations:()=>` [${Array.from({length:60},(_,i)=>i+1).join(', ')}]`}),bounds=nodes[0];
  for(const node of nodes){assert.ok(node.x>=0&&node.y>=0);assert.ok(node.x+node.width<=bounds.width+1);assert.ok(node.y+node.height<=bounds.height+1);}
  const textNodes=nodes.filter(node=>node.type==='text_shape');
  for(const node of textNodes)assert.ok(node.height>=node.text.text.split('\n').length*node.text.font_size*1.59);
});

test('SVG uses safe escaped text, responsive themes and no external assets; legacy boards retain fallback',()=>{
  const minutes=fixture();minutes.title='<script>alert("x")</script>';const nodes=minutesBoard(minutes),svg=boardSvg(nodes,{responsiveTheme:true});
  assert.match(svg,/&lt;script&gt;/);assert.doesNotMatch(svg,/<script|<image|href=|<foreignObject|onload=/i);
  assert.match(svg,/prefers-color-scheme:dark/);assert.match(svg,/<rect/);assert.match(svg,/<path/);
  assert.equal(boardSvg([{id:'old',type:'mind_map',x:0,y:0,text:{text:'旧画板'}}]),'');
});

test('numeric comparison draws quantities while ambiguous values remain text',()=>{
  const minutes=fixture();minutes.visuals=[{kind:'bar',title:'数量对比',unit:'台',entries:[{label:'A',valueText:'10',evidence},{label:'B',valueText:'20',evidence}]}];
  const nodes=minutesBoard(minutes),text=nodes.filter(node=>node.text).map(node=>node.text.text).join('\n');
  assert.match(text,/数量对比[\s\S]*单位：台[\s\S]*10[\s\S]*20/);
  assert.ok(nodes.filter(node=>node.type==='composite_shape'&&node.height===15).length>=2);
  minutes.visuals[0].entries[0].valueText='10～20';const ambiguous=minutesBoard(minutes);assert.ok(!ambiguous.some(node=>node.type==='composite_shape'&&node.height===15));
});

test('Feishu overview uses editable native elements beside the complete document',()=>{
  const nodes=feishuBoard(fixture()),text=nodes.flatMap(node=>[node.section?.title,node.text?.text,...(node.table?.cells||[]).map(c=>c.text?.text)]).filter(Boolean).join('\n');
  assert.match(text,/接口评审/);assert.match(text,/核心结论/);assert.match(text,/推进节点/);
  assert.ok(nodes.length<3000);assert.ok(nodes[0].height>0);
  assert.ok(nodes.every(node=>['composite_shape','text_shape','section','group','table','connector'].includes(node.type)));
});
