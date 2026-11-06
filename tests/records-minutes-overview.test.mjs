import test from 'node:test';
import assert from 'node:assert/strict';
import {meetingOverviewPlan,compileMeetingOverview} from '../packages/records/src/meeting-minutes-overview.mjs';
import {feishuBoardPages} from '../services/records/src/integrations/feishu-board.mjs';

const evidence=[{segmentId:'s1',revision:1}];
const fixture=()=>({title:'现场测试',revision:2,transcriptRevision:8,topics:[{id:'t1',title:'道路验证',summary:'先核对点位，再开始实测',evidence}],sections:[{heading:'道路验证',items:[{text:'道路存在障碍物',kind:'risk',topicId:'t1',evidence},{text:'测试时间未明确',kind:'question',topicId:'t1',evidence}]}],highlights:[{text:'地图结果仍需车辆实测',evidence}],decisions:[{text:'维持当前配置',evidence}],actions:[{text:'验证车辆能否下行；若无法下行，则修改配置或道路。',evidence},{text:'核对另一条道路',evidence}],visuals:[],tables:[]});
const contents=nodes=>nodes.map(n=>n.text?.text||'').join('\n').replace(/\n/g,'');

test('one colored overview routes explicit conditions and keeps source immutable',()=>{
  const m=fixture(),before=JSON.stringify(m),pages=feishuBoardPages(m,{citations:()=> ' [1]'}),nodes=pages[0].nodes;
  assert.equal(pages.length,1);assert.equal(pages[0].title,'会议总览');assert.equal(meetingOverviewPlan(m).diagram.kind,'branch');
  assert.match(contents(nodes),/无法下行/);assert.match(contents(nodes),/未评级/);assert.match(contents(nodes),/\[1\]/);
  assert.ok(nodes.some(n=>n.composite_shape?.type==='flow_chart_diamond'));
  assert.ok(new Set(nodes.map(n=>n.style?.fill_color).filter(Boolean)).size>=6);
  const ids=new Set(nodes.map(n=>n.id));
  for(const n of nodes){if(n.parent_id)assert.ok(ids.has(n.parent_id));if(n.type==='connector')for(const end of ['start','end'])assert.ok(ids.has(n.connector[end].attached_object.id));}
  assert.equal(JSON.stringify(m),before);
});

test('timeline needs source time nodes; unrelated actions never become an invented sequence',()=>{
  const m=fixture();m.topics[0].summary='多条道路需要分别验证';m.actions=[{text:'核对道路甲',evidence},{text:'核对道路乙',evidence}];
  assert.equal(meetingOverviewPlan(m).diagram.kind,'topics');
  m.actions[0].due='不在下周一，具体时间另行商议';m.actions[1].due='不是下周三，视情况安排';
  assert.equal(meetingOverviewPlan(m).diagram.kind,'topics');
  m.actions[0].due='下周一';m.actions[1].due='下周三';
  const timeline=meetingOverviewPlan(m).diagram;assert.equal(timeline.kind,'timeline');assert.deepEqual(timeline.entries.map(e=>e.label),['下周一','下周三']);
  assert.match(contents(compileMeetingOverview(m)),/时间保留原话/);
});

test('large minutes stay in one overview with visible excerpt counts and safe native bounds',()=>{
  const m=fixture();m.edited=true;m.actions=Array.from({length:20},(_,i)=>({text:`核对行动 ${i} ${'长内容'.repeat(80)}`,evidence}));
  m.highlights=Array.from({length:8},(_,i)=>({text:`结论 ${i} ${'长结论'.repeat(60)}`,evidence}));
  m.sections[0].items.push(...Array.from({length:100},(_,i)=>({kind:'fact',text:`正文事实 ${i}`,evidence})));
  const pages=feishuBoardPages(m),nodes=pages[0].nodes,canvas=nodes[0];assert.equal(pages.length,1);
  assert.match(contents(nodes),/4\/8/);assert.match(contents(nodes),/4\/20/);assert.match(contents(nodes),/完整纪要/);
  for(const n of nodes.filter(n=>n.type!=='connector')){assert.ok(n.x>=0&&n.y>=0);assert.ok(n.x+n.width<=canvas.width+.1,`${n.id} width`);assert.ok(n.y+n.height<=canvas.height+.1,`${n.id} height`);}
});

test('known risk ratings occupy their explicit matrix column',()=>{
  const m=fixture();m.sections[0].items[0].level='high';m.sections[0].items[0].status='confirmed';
  const plan=meetingOverviewPlan(m);assert.equal(plan.risks[0].level,'高');assert.equal(plan.risks[0].state,'已确认');
  const nodes=compileMeetingOverview(m),label=nodes.find(n=>n.text?.text==='1');assert.ok(label);assert.ok(label.x>1300);
});

test('vague deadlines never supply time nodes',()=>{
  const m=fixture();m.topics[0].summary='两项独立核对';m.actions=[{text:'核对资料',due:'尽快',evidence},{text:'核对道路',due:'按需',evidence}];
  assert.equal(meetingOverviewPlan(m).diagram.kind,'topics');
});

test('negated statements and lexical prefixes cannot become an affirmative process',()=>{
  for(const source of ['先前方案已经否决，再也不执行旧方案。','先核对资料；不能再上传数据。','先核对资料，不得再上传数据。','先核对再次上传数据的权限。']){
    const m=fixture();m.topics[0].summary='独立核对';m.actions=[{text:source,evidence}];
    assert.equal(meetingOverviewPlan(m).diagram.kind,'topics',source);assert.match(contents(compileMeetingOverview(m)),/否决|不能|不得|再次/);
  }
  const m=fixture();m.actions=[{text:'先核对资料，再上传数据。',evidence}];assert.equal(meetingOverviewPlan(m).diagram.kind,'flow');
});

test('risk grades normalize bundled med and case without guessing unknown values',()=>{
  for(const [level,expected] of [['med','中'],[' MEDIUM ','中'],['HIGH','高'],['Low','低'],['unmapped','未评级']]){
    const m=fixture();m.sections[0].items[0].level=level;assert.equal(meetingOverviewPlan(m).risks[0].level,expected);
  }
});

test('long valid metadata, source headings and time labels stay inside their layout',()=>{
  const m=fixture();m.title='纪要标题'.repeat(20);m.topics[0].title='需要核对的长主题'.repeat(4);
  m.actions=[{text:'核对配置',owner:'项目负责人及各参与方共同确认的负责团队'.repeat(5),due:'下周一具体执行日期由参与方共同确认',evidence}];
  m.visuals=[{topicId:'t1',kind:'timeline',title:'需要保留原文的时间线标题'.repeat(12),entries:[{label:'下周一由相关各方确定最终实施时段'.repeat(5),text:'核对配置',evidence},{label:'下周三',text:'验证结果',evidence}]}];
  const nodes=compileMeetingOverview(m),canvas=nodes[0],textNodes=nodes.filter(n=>n.type==='text_shape');
  for(const n of nodes.filter(n=>n.type!=='connector')){assert.ok(n.x+n.width<=canvas.width+.1,n.id);assert.ok(n.y+n.height<=canvas.height+.1,n.id);}
  for(let i=0;i<textNodes.length;i++)for(let j=i+1;j<textNodes.length;j++){
    const a=textNodes[i],b=textNodes[j],overlapX=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x),overlapY=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);
    assert.ok(overlapX<=.1||overlapY<=.1,`${a.id} overlaps ${b.id}`);
  }
});
