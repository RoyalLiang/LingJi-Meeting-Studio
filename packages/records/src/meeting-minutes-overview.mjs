import {requireThat} from './record.mjs';
import {minutesOverview} from './minutes-presentation.mjs';
import {minutesItemText} from './minutes-quality.mjs';
import {wrapSkillText} from './meeting-minutes-skill.mjs';

const excerpt=(value,limit=96)=>{const chars=Array.from(String(value??'').replace(/\s+/gu,' ').trim());return chars.length>limit?chars.slice(0,limit-1).join('')+'…':chars.join('');};
const brief=(item,limit)=>({...item,text:excerpt(item.text??minutesItemText(item),limit)});
const rated=value=>({high:'高',med:'中',medium:'中',low:'低','高':'高','中':'中','低':'低'})[String(value??'').trim().toLowerCase()]||'未评级';
function timePoint(value){
  const v=String(value??'').trim();
  if(!v||/不|没|未|待|另行|视情况|商议|取消|改期|再定|tbd|unknown|pending|\bnot\b/iu.test(v))return false;
  return /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}年\d{1,2}月(?:\d{1,2}[日号])?|\d{1,2}月\d{1,2}[日号]|(?:(?:本|这|下|下下)周[一二三四五六日天1-7]?|周[一二三四五六日天1-7])|今天|今日|明天|明日|后天|今晚|明早)(?:\s*(?:上午|下午|晚上|中午|早上)?(?:\d{1,2}[:：]\d{2}|\d{1,2}点(?:\d{1,2}分)?))?(?:之前|之后|前|后|左右)?$/u.test(v)||/^(?:[01]?\d|2[0-3])[:：][0-5]\d$/u.test(v)||/^(?:(?:this|next)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/iu.test(v);
}
function explicitSequence(source){
  if(/先前|再也|不能|不得|禁止|不再|无需|不要|不可|不应|否决|取消/u.test(source))return null;
  const match=source.match(/^先(?!前|后|天|生|驱|例)([^。；;，,]{2,80})[，,]\s*再(?!也|次)([^。；;]{2,100})/u)||source.match(/^在([^。；;，,]{2,80}?)后[，,]\s*([^。；;]{2,100})/u);
  return match?match.slice(1).map(s=>s.trim()):null;
}

// Connections require an explicit source relation. A topic map is the fallback.
export function meetingOverviewPlan(minutes){
  const view=minutesOverview(minutes),items=view.layout.branches.flatMap(branch=>branch.items||[]);
  const timelines=[...view.layout.branches.flatMap(branch=>branch.visuals||[]),...(view.layout.unassigned.visuals||[])].filter(v=>v.kind==='timeline'&&v.entries?.length>=2);
  let diagram;
  if(timelines.length){
    const timeline=timelines[0];
    diagram={kind:'timeline',title:timeline.title||'时间线',entries:timeline.entries.slice(0,4).map(e=>({label:e.label,text:excerpt(e.text,64),evidence:e.evidence})),total:timeline.entries.length};
  }else{
    const dated=view.actions.filter(a=>timePoint(a.due));
    if(dated.length>=2)diagram={kind:'timeline',title:'行动时间线',entries:dated.slice(0,4).map(a=>({label:a.due,text:excerpt(a.text,64),evidence:a.evidence})),total:dated.length};
  }
  const candidates=[...view.actions,...items,...view.layout.branches.filter(b=>b.summary).map(b=>({text:b.summary,evidence:b.evidence}))];
  if(!diagram)for(const item of candidates){
    const source=minutesItemText(item),conditional=source.match(/^(.{2,120}?)[；;]\s*(?:若|如果)([^，,；;。]{2,60})[，,]\s*(?:则)?(.{2,120})/u);
    if(conditional){diagram={kind:'branch',title:'条件流程',steps:[conditional[1],conditional[2],conditional[3]],evidence:item.evidence,source:excerpt(source,120)};break;}
    const sequence=explicitSequence(source);
    if(sequence){diagram={kind:'flow',title:'推进流程',steps:sequence,evidence:item.evidence,source:excerpt(source,120)};break;}
  }
  diagram??={kind:'topics',title:'讨论主题关系',entries:view.layout.branches.slice(0,4).map(b=>({label:excerpt(b.title,22),text:excerpt(b.summary,58),evidence:b.evidence})),total:view.layout.branches.length};
  let prerequisite;
  if(diagram.kind==='branch')for(const item of candidates){
    const source=minutesItemText(item),sequence=source.startsWith('在')&&explicitSequence(source);
    if(sequence){prerequisite={steps:sequence,source:excerpt(source,120),evidence:item.evidence};break;}
  }
  const risks=items.filter(i=>i.kind==='risk'),questions=items.filter(i=>i.kind==='question');
  return {title:minutes.title||'会议纪要',revision:minutes.revision,transcriptRevision:minutes.transcriptRevision,
    summary:view.summary.slice(0,4).map(i=>brief(i,112)),decisions:view.decisions.slice(0,2).map(i=>brief(i,90)),
    actions:view.actions.slice(0,4).map(i=>brief(i,78)),risks:risks.slice(0,3).map(i=>({...brief(i,66),level:rated(i.level),state:({confirmed:'已确认',done:'已缓解',completed:'已缓解',mitigated:'已缓解',resolved:'已缓解'})[i.status]||'待确认'})),
    questions:questions.slice(0,2).map(i=>brief(i,56)),diagram,prerequisite,
    totals:{summary:view.summary.length,decisions:view.decisions.length,actions:view.actions.length,risks:risks.length,questions:questions.length}};
}

export function compileMeetingOverview(minutes,{theme='light',citations}={}){
  requireThat(['light','dark'].includes(theme),'invalid_meeting_minutes_skill',400);
  const plan=meetingOverviewPlan(minutes),dark=theme==='dark',p={bg:dark?'#151D2E':'#EEF3F9',paper:dark?'#202D43':'#FFFFFF',ink:dark?'#F1F5FC':'#192840',muted:dark?'#B8C8DF':'#53647C',navy:'#182C4E',blue:dark?'#96BEFF':'#285FC5',blueSoft:dark?'#253D60':'#E7F0FF',teal:dark?'#85D6CB':'#087E77',tealSoft:dark?'#1D4144':'#E1F4EF',amber:dark?'#F4D18B':'#A35D09',amberSoft:dark?'#463B2B':'#FFF0D9',rose:dark?'#FFABB0':'#B64253',roseSoft:dark?'#483040':'#FFE9EE',line:dark?'#42516A':'#D4DDEB'},nodes=[],width=1600,pad=40,gap=24,inner=1520;
  let serial=0;
  const add=node=>{const n={id:`overview_${serial++}`,...node};nodes.push(n);return n;};
  const rect=(x,y,w,h,fill=p.paper,{stroke,kind='round_rect'}={})=>add({type:'composite_shape',x,y,width:w,height:h,composite_shape:{type:kind},style:{fill_color:fill,fill_opacity:100,border_color:stroke||fill,border_style:stroke?'solid':'none',border_width:'extra_narrow',border_radius:{top_left:14,top_right:14,bottom_left:14,bottom_right:14}}});
  const lines=(value,w,size)=>wrapSkillText(value,w,size);
  const height=(value,w,size=22)=>Math.max(size*1.45,lines(value,w,size).length*size*1.45);
  const text=(value,x,y,w,{size=22,bold=false,color=p.ink}={})=>add({type:'text_shape',x,y,width:w,height:height(value,w,size),text:{text:lines(value,w,size).join('\n'),font_size:size,font_weight:bold?'bold':'regular',text_color:color,horizontal_align:'left',vertical_align:'top'},style:{fill_opacity:0,border_style:'none'}});
  const cite=item=>citations?citations((item.evidence||[]).slice(0,2)):'';
  const content=item=>item.text+cite(item);
  const group=(start,x,y,w,h)=>{const g=add({type:'group',x,y,width:w,height:h});for(const n of nodes.slice(start,-1))if(!n.parent_id)n.parent_id=g.id;return g;};
  const heading=(title,shown,total,x,y,w,color)=>{const label=text(title,x,y,w-128,{size:25,bold:true,color}),count=text(`${shown}${total>shown?`/${total}`:''} 项`,x+w-128,y+4,128,{size:18,color:p.muted});return y+Math.max(label.height,count.height+4)+18;};
  const connect=(a,b,{vertical=false,label,arrow=true}={})=>{
    const edge=add({type:'connector',style:{border_color:p.blue,border_width:'narrow',border_style:'solid'},connector:{shape:'right_angled_polyline',start:{attached_object:{id:a.id,snap_to:vertical?'bottom':'right',position:vertical?{x:.5,y:1}:{x:1,y:.5}},arrow_style:'none'},end:{attached_object:{id:b.id,snap_to:vertical?'top':'left',position:vertical?{x:.5,y:0}:{x:0,y:.5}},arrow_style:arrow?'triangle_arrow':'none'}}});
    if(label)text(label,(a.x+a.width+b.x-110)/2,a.y-28,110,{size:16,color:p.blue});return edge;
  };
  const background=rect(0,0,width,1,p.bg);background.locked=true;
  const masthead=rect(0,0,width,120,p.navy);
  text('会议总览',pad,28,220,{size:34,bold:true,color:'#FFFFFF'});
  const documentTitle=text(excerpt(plan.title,49),290,32,1270,{size:27,bold:true,color:'#FFFFFF'}),subtitleY=Math.max(82,32+documentTitle.height+12);
  const subtitle=text(`转录 v${plan.transcriptRevision??'?'} · 纪要 v${plan.revision??'?'}    摘要与关键关系 · 完整内容及引用见下方正文`,pad,subtitleY,inner,{size:18,color:'#C6D6ED'});masthead.height=subtitleY+subtitle.height+16;
  let y=masthead.height+24,start=nodes.length;
  const core=rect(pad,y,inner,1,p.paper);let cursor=heading('01  核心结论',plan.summary.length,plan.totals.summary,pad+24,y+18,inner-48,p.blue);
  const cols=Math.min(4,Math.max(1,plan.summary.length)),cw=(inner-48-gap*(cols-1))/cols;
  let coreHeight=80;
  for(const [i,item] of plan.summary.entries()){
    const x=pad+24+i*(cw+gap),value=content(item),h=height(value,cw-32,22)+32;
    rect(x,cursor,cw,h,p.blueSoft);rect(x,cursor,5,h,p.blue);
    text(value,x+16,cursor+16,cw-32,{size:22});coreHeight=Math.max(coreHeight,h);
  }
  if(!plan.summary.length)text('本次纪要未列出结论',pad+24,cursor,inner-48,{color:p.muted});
  core.height=cursor-y+coreHeight+22;group(start,pad,y,inner,core.height);y+=core.height+gap;
  const left=952,right=inner-left-gap,rx=pad+left+gap,rowY=y;
  start=nodes.length;const visualPanel=rect(pad,y,left,1,p.paper);cursor=heading(`02  ${plan.diagram.title}`,plan.diagram.kind==='flow'||plan.diagram.kind==='branch'?plan.diagram.steps.length:plan.diagram.entries.length,plan.diagram.total||0,pad+24,y+18,left-48,p.teal);
  const d=plan.diagram;
  if(d.kind==='branch'||d.kind==='flow'){
    const count=d.steps.length,space=d.kind==='branch'?74:70,nodeW=(left-48-space*(count-1))/count,nodeY=cursor+24,boxes=[];
    const nodeH=Math.max(118,...d.steps.map((s,i)=>height(s,nodeW-40,d.kind==='branch'&&i===1?19:22)+48));
    d.steps.forEach((step,i)=>{
      const x=pad+24+i*(nodeW+space),condition=d.kind==='branch'&&i===1,b=rect(x,nodeY,nodeW,nodeH,condition?p.amberSoft:p.tealSoft,{stroke:condition?p.amber:p.teal,kind:condition?'flow_chart_diamond':'round_rect'});
      text(step,x+20,nodeY+(nodeH-height(step,nodeW-40,condition?19:22))/2,nodeW-40,{size:condition?19:22,bold:true,color:condition?p.amber:p.teal});boxes.push(b);
      if(i)connect(boxes[i-1],b,{label:condition?'判断':d.kind==='branch'?'成立时':'随后'});
    });
    cursor=nodeY+nodeH+24;cursor+=text(d.source+(citations?citations((d.evidence||[]).slice(0,2)):''),pad+24,cursor,left-48,{size:18,color:p.muted}).height+16;
  }else if(d.kind==='timeline'){
    const count=d.entries.length,cw=(left-48-20*(count-1))/Math.max(1,count),labelHeight=Math.max(...d.entries.map(e=>height(e.label,cw,20))),nodeY=cursor+labelHeight+24,boxes=[];
    let bottom=nodeY;
    d.entries.forEach((entry,i)=>{
      const x=pad+24+i*(cw+20),dot=rect(x,nodeY,16,16,p.teal,{kind:'ellipse'});if(i)connect(boxes[i-1],dot,{arrow:false});boxes.push(dot);
      text(entry.label,x,cursor,cw,{size:20,bold:true,color:p.teal});bottom=Math.max(bottom,nodeY+36+text(entry.text+cite(entry),x,nodeY+36,cw,{size:21}).height);
    });cursor=bottom+20;cursor+=text('时间保留原话，按纪要列示顺序',pad+24,cursor,left-48,{size:18,color:p.muted}).height+16;
  }else{
    const entries=d.entries.length?d.entries:[{label:'会议要点',text:'纪要尚未形成明确流程或时间节点'}],cw=(left-48-gap)/2,root=rect(pad+24,cursor,180,64,p.tealSoft,{stroke:p.teal});text('讨论主题',pad+42,cursor+17,148,{bold:true,color:p.teal});
    let bottom=cursor+64,top=cursor;
    for(let offset=0;offset<entries.length;offset+=2){const row=entries.slice(offset,offset+2),rowH=Math.max(...row.map(e=>height(e.label,cw-142,20)+height(excerpt(e.text,34)+cite(e),cw-142,18)+46));
      row.forEach((entry,i)=>{const x=pad+236+i*(cw-88),b=rect(x,top,cw-110,rowH,p.tealSoft),label=text(entry.label,x+16,top+16,cw-142,{size:20,bold:true,color:p.teal});text(excerpt(entry.text,34)+cite(entry),x+16,top+label.height+30,cw-142,{size:18});connect(root,b);});top+=rowH+16;bottom=Math.max(bottom,top);
    }cursor=bottom+24;
  }
  if(plan.prerequisite){
    const q=plan.prerequisite,nodeW=(left-118)/2;
    text('原文前置关系',pad+24,cursor,left-48,{size:21,bold:true,color:p.teal});cursor+=40;
    const nodeH=Math.max(72,...q.steps.map(s=>height(s,nodeW-32,20)+30)),boxes=[];
    q.steps.forEach((s,i)=>{const x=pad+24+i*(nodeW+70),b=rect(x,cursor,nodeW,nodeH,p.blueSoft,{stroke:p.blue});text(s,x+16,cursor+15,nodeW-32,{size:20,bold:true,color:p.blue});if(i)connect(boxes[i-1],b,{label:'之后'});boxes.push(b);});
    cursor+=nodeH+16;cursor+=text(q.source+(citations?citations((q.evidence||[]).slice(0,2)):''),pad+24,cursor,left-48,{size:18,color:p.muted}).height+18;
  }
  visualPanel.height=cursor-rowY;const visualGroup=group(start,pad,rowY,left,visualPanel.height);
  start=nodes.length;const riskPanel=rect(rx,rowY,right,1,p.amberSoft);cursor=heading('03  风险矩阵',plan.risks.length,plan.totals.risks,rx+22,rowY+18,right-44,p.amber);
  text('影响等级 × 确认状态；缺失等级保留未评级',rx+22,cursor,right-44,{size:17,color:p.muted});cursor+=36;
  const matrixX=rx+112,matrixW=right-134,cellW=matrixW/4;
  ['低','中','高','未评级'].forEach((level,i)=>text(level,matrixX+i*cellW,cursor,cellW,{size:18,bold:true,color:p.amber}));cursor+=30;
  const states=['待确认','已确认',...(plan.risks.some(r=>r.state==='已缓解')?['已缓解']:[])];
  for(const [ri,state] of states.entries()){
    text(state,rx+18,cursor+ri*48+13,94,{size:17,color:p.muted});
    ['低','中','高','未评级'].forEach((level,ci)=>{
      const selected=plan.risks.map((risk,i)=>risk.state===state&&risk.level===level?String(i+1):'').filter(Boolean).join(','),x=matrixX+ci*cellW,cy=cursor+ri*48;
      rect(x,cy,cellW-3,44,selected?p.paper:dark?'#342E2A':'#F8E5C8',{stroke:dark?'#6C5940':'#E9CFA7'});if(selected)text(selected,x+8,cy+10,cellW-16,{size:17,bold:true,color:p.amber});
    });
  }
  cursor+=states.length*48+14;
  for(const [i,risk] of plan.risks.entries()){cursor+=text(`R${i+1}  ${content(risk)}`,rx+22,cursor,right-44,{size:19}).height+12;}
  if(!plan.risks.length)cursor+=text('纪要未列出明确风险',rx+22,cursor,right-44,{size:20,color:p.muted}).height;
  riskPanel.height=cursor-rowY+12;const riskGroup=group(start,rx,rowY,right,riskPanel.height);const rowH=Math.max(visualPanel.height,riskPanel.height);visualPanel.height=rowH;riskPanel.height=rowH;visualGroup.height=rowH;riskGroup.height=rowH;y=rowY+rowH+gap;
  start=nodes.length;const actionPanel=rect(pad,y,left,1,p.tealSoft);cursor=heading('04  行动安排',plan.actions.length,plan.totals.actions,pad+24,y+18,left-48,p.teal);
  const actionW=(left-48-gap)/2;let bottom=cursor;
  for(let offset=0;offset<plan.actions.length;offset+=2){
    const row=plan.actions.slice(offset,offset+2),meta=a=>`${a.owner||'负责人待确认'} · ${a.due||'时间待确认'}`,h=Math.max(...row.map(a=>height(content(a),actionW-28,20)+height(meta(a),actionW-28,17)+44));
    row.forEach((a,i)=>{const x=pad+24+i*(actionW+gap);rect(x,cursor,actionW,h,p.paper);text(content(a),x+14,cursor+12,actionW-28,{size:20,bold:true});text(meta(a),x+14,cursor+h-height(meta(a),actionW-28,17)-14,actionW-28,{size:17,color:p.teal});});cursor+=h+14;bottom=cursor;
  }
  if(!plan.actions.length)bottom=cursor+text('未列出行动安排',pad+24,cursor,left-48,{size:20,color:p.muted}).height;
  actionPanel.height=bottom-y+10;group(start,pad,y,left,actionPanel.height);
  start=nodes.length;const decisionPanel=rect(rx,y,right,1,p.paper);cursor=heading('05  决策与待确认',plan.decisions.length+plan.questions.length,plan.totals.decisions+plan.totals.questions,rx+22,y+18,right-44,p.rose);
  for(const item of plan.decisions){rect(rx+22,cursor,5,height(content(item),right-62,20)+8,p.rose);cursor+=text(content(item),rx+38,cursor,right-62,{size:20,bold:true,color:p.rose}).height+18;}
  for(const item of plan.questions)cursor+=text(`?  ${content(item)}`,rx+22,cursor,right-44,{size:19,color:p.muted}).height+12;
  if(!plan.decisions.length&&!plan.questions.length)cursor+=text('未列出决策或待确认事项',rx+22,cursor,right-44,{size:20,color:p.muted}).height;
  decisionPanel.height=cursor-y+10;group(start,rx,y,right,decisionPanel.height);const bottomH=Math.max(actionPanel.height,decisionPanel.height);actionPanel.height=bottomH;decisionPanel.height=bottomH;y+=bottomH+20;
  text('画板为摘要摘录；各区“显示数 / 总数”表示仍有内容保留在下方完整纪要。流程连线仅来自原文明确关系。',pad,y,inner,{size:17,color:p.muted});background.height=y+58;
  requireThat(nodes.length<=3000&&Buffer.byteLength(JSON.stringify(nodes))<=500000,'feishu_document_too_large',400);
  return nodes;
}
