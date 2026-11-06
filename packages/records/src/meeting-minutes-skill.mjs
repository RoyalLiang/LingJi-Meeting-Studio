import {requireThat} from './record.mjs';
import {minutesOverview} from './minutes-presentation.mjs';
import {minutesItemText} from './minutes-quality.mjs';

// Native adaptation of the bundled meeting-minutes compiler; no Python runtime or model call.
export const MEETING_MINUTES_SKILL='meeting-minutes/20261106';
const palettes={light:{canvas:'#F2F4F5',surface:'#FCFDFD',soft:'#E8EDEE',ink:'#1F2329',accent:'#5178C6'},dark:{canvas:'#1D1E20',surface:'#282A2E',soft:'#3C3F46',ink:'#E5E6E9',accent:'#B7BBF2'}};
const sectionTones={blue:['#D6E5FF','#5178C6'],green:['#D8EEDC','#2E8B57'],amber:['#F8E7BA','#B88627'],indigo:['#E4E0F7','#7864B5'],slate:['#E0E7EE','#6D8097']};
const status=value=>({done:'已完成',completed:'已完成',active:'进行中',todo:'待办',pending:'待推进',candidate:'候选',confirmed:'已确认',blocked:'受阻',unconfirmed:'待确认'})[value]||value||'';
const join=values=>values.filter(value=>value!==undefined&&value!==null&&value!=='').join('\n');
const round=value=>Math.round(value*10)/10;
const kinds=new Set(['flow','branch','kpi','grid','table','status-table','timeline','pros-cons','action-list','quote-decision','risk-matrix','funnel-metric']);
const aliases={process:'flow',pipeline:'flow',steps:'flow',tree:'branch',topology:'branch',architecture:'branch',metric:'kpi',metrics:'kpi',delta:'kpi',columns:'grid',pillars:'grid',rag:'status-table',status:'status-table',status_table:'status-table',roadmap:'timeline',schedule:'timeline',gantt:'timeline',compare:'pros-cons',pros_cons:'pros-cons',decision:'pros-cons',todo:'action-list',actions:'action-list',action_list:'action-list',quote:'quote-decision',quote_decision:'quote-decision',risk:'risk-matrix',risks:'risk-matrix',risk_matrix:'risk-matrix',funnel:'funnel-metric',funnel_metric:'funnel-metric'};

export function wrapSkillText(value,width,size=16){
  const lines=[],limit=Math.max(36,width-32)/Math.max(8,size);
  for(const raw of String(value??'').split('\n')){
    let line='',used=0;
    for(const char of raw.trim()){
      const code=char.codePointAt(0),weight=code<128?.56:code>=0x2e80?1:.75;
      if(used+weight>limit&&line){lines.push(line);line='';used=0;}
      line+=char;used+=weight;
    }
    if(line)lines.push(line);
  }
  return lines;
}

export function compileMeetingMinutesBoard(data,{theme='light'}={}){
  requireThat(data&&typeof data==='object'&&!Array.isArray(data),'invalid_meeting_minutes_skill',400);
  const p=palettes[theme];requireThat(p,'invalid_meeting_minutes_skill',400);
  requireThat(Buffer.byteLength(JSON.stringify(data))<=500000,'feishu_document_too_large',400);
  const nodes=[],links=[];
  const box=(id,text,x,y,width,{size=16,bold=false,fill=p.surface,ink=p.ink,minimum=48,align='left'}={})=>{
    const lines=wrapSkillText(text,width,size),height=round(Math.max(minimum,lines.length*size*1.42+24));
    const node={id,type:'composite_shape',x:round(x),y:round(y),width:round(width),height,composite_shape:{type:'round_rect'},text:{text:lines.join('\n'),font_size:size,font_weight:bold?'bold':'regular',text_color:ink,horizontal_align:align,vertical_align:'mid'},style:{fill_color:fill,fill_opacity:100,border_color:fill,border_width:'extra_narrow',border_style:'none'}};
    nodes.push(node);requireThat(nodes.length<=3000,'feishu_document_too_large',400);return node;
  };
  const link=(id,a,b,vertical=false)=>links.push({id,a,b,vertical});
  function card(raw,top,prefix){
    requireThat(raw&&typeof raw==='object'&&!Array.isArray(raw),'invalid_meeting_minutes_skill',400);
    const c={...raw},type=String(c.type||'table').toLowerCase().trim(),kind=aliases[type]||type;
    requireThat(kinds.has(kind),'invalid_meeting_minutes_skill',400);
    const generic=c.items||c.list||c.data||[];
    const payload={flow:c.steps||c.events||generic,timeline:c.events||c.steps||generic,kpi:c.metrics||generic,'action-list':c.actions||c.todos||c.tasks||generic,'risk-matrix':c.risks||generic,'funnel-metric':c.bars||c.steps||generic};
    const background=box(prefix+'_background','',48,top,1040),x=72,width=992;
    let y=top+24;
    const add=(key,text,bx,by,bw,options)=>box(prefix+'_'+key,text,bx,by,bw,options);
    if(c.title){const n=add('title',c.title,x,y,width,{size:22,bold:true});y+=n.height+24;}
    if(kind==='flow'||kind==='timeline'){
      const entries=payload[kind],cw=(width-48)/2;let previous;
      for(let offset=0;offset<entries.length;offset+=2){
        const row=[];
        for(const [col,entry] of entries.slice(offset,offset+2).entries()){
          const state=entry.s??entry.status??'pending',meta=[entry.time,entry.owner,entry.meta].filter(Boolean),label=status(state);
          if(!meta.join(' ').includes(label))meta.push(label);
          const n=add('stage'+(offset+col),join([meta.join(' · '),entry.t||entry.title,entry.d||entry.desc]),x+col*(cw+48),y,cw,{fill:state==='active'?p.soft:p.surface});
          row.push(n);if(previous)link(prefix+'_stage_link'+(offset+col),previous,n,col===0);previous=n;
        }
        const height=Math.max(48,...row.map(n=>n.height));for(const n of row)n.height=height;y+=height+48;
      }
    }else if(kind==='branch'){
      const root=add('root',c.root||'',x,y,width,{bold:true,fill:p.soft});y+=root.height+32;
      const hub=add('hub',c.hub||'',x,y,width,{bold:true});link(prefix+'_root_hub',root,hub,true);y+=hub.height+40;
      for(const [bi,branch] of (c.branches||[]).entries()){
        let previous=hub;
        for(const [i,e] of branch.entries()){
          const n=add(`branch${bi}_${i}`,join([e.t||e.title,e.d||e.desc,status(e.s??e.status??'pending')]),x+56,y,width-56);
          link(prefix+`_branch_link${bi}_${i}`,previous,n,true);previous=n;y+=n.height+24;
        }
        y+=16;
      }
    }else if(kind==='kpi'){
      for(const [i,m] of payload[kind].entries()){
        y+=add(`metric${i}_label`,m.label||'',x,y,width).height+8;const cw=(width-48)/2;
        const a=add(`metric${i}_baseline`,join([m.fromLabel??'基线',m.from??'']),x,y,cw,{size:22});
        const b=add(`metric${i}_current`,m.to??'',x+cw+48,y,cw,{size:32,ink:p.accent,bold:true});y+=Math.max(a.height,b.height)+8;
        y+=add(`metric${i}_delta`,[m.toLabel??'当前值',m.delta].filter(Boolean).join(' · '),x+cw+48,y,cw).height+32;
      }
    }else if(kind==='grid'||kind==='pros-cons'){
      const entries=kind==='grid'?c.items||[]:[c.left||{},c.right||{}],columns=kind==='grid'?Math.min(3,Math.max(1,Math.trunc(Number(c.cols)||2))):2,cw=(width-24*(columns-1))/columns;
      for(let offset=0;offset<entries.length;offset+=columns){
        const row=entries.slice(offset,offset+columns).map((e,col)=>add('panel'+(offset+col),join([e.t||e.title,e.tag,e.d||e.desc,(e.items||[]).map(v=>'• '+v).join('\n')]),x+col*(cw+24),y,cw,{fill:p.soft}));
        y+=Math.max(48,...row.map(n=>n.height))+24;
      }
      if(c.verdict)y+=add('verdict',c.verdict,x,y,width,{bold:true}).height+24;
    }else if(kind==='quote-decision'){
      y+=add('quote',join([c.speaker,c.role,c.text,c.impact]),x,y,width,{size:22,fill:p.soft}).height+24;
    }else if(kind==='funnel-metric'){
      for(const [i,e] of payload[kind].entries()){
        y+=add(`funnel${i}_label`,[e.label,e.val,e.note].filter(v=>v!==undefined&&v!=='').join(' · '),x,y,width).height+8;
        const pct=Number(e.pct??0);requireThat(Number.isFinite(pct)&&pct>=0&&pct<=100,'invalid_meeting_minutes_skill',400);
        add(`funnel${i}_track`,'',x,y,width,{fill:p.soft,minimum:16}).height=16;
        if(pct>0)add(`funnel${i}_bar`,'',x,y,Math.max(.1,width*pct/100),{fill:p.accent,minimum:16}).height=16;y+=40;
      }
    }else{
      let headers=c.headers||[],rows=c.rows||[];
      if(kind==='action-list'){headers=['状态','优先级','待办事项','责任人','截止时间'];rows=payload[kind].map(a=>[status(a.s??'todo'),a.p||'',a.t??a.title??'',a.owner||'',a.due||'']);}
      if(kind==='risk-matrix'){headers=['等级','风险事项','缓解措施','责任人'];rows=payload[kind].map(r=>[String(r.level||'med').toUpperCase(),r.risk||'',r.mitigation||'',r.owner||'']);}
      const count=Math.max(headers.length,...rows.map(r=>r.length),1);requireThat(count<=40,'invalid_meeting_minutes_skill',400);
      const weights=Array.from({length:count},(_,col)=>Math.max(6,Math.min(32,Math.max(...[headers,...rows].map(r=>Array.from(String(r[col]??'')).length)))));
      const total=weights.reduce((a,b)=>a+b,0),extra=Math.max(0,width-8*(count-1)-96*count),widths=weights.map(w=>96+extra*w/total);
      background.width=round(Math.max(background.width,widths.reduce((a,b)=>a+b,0)+8*(count-1)+48));
      const height=row=>Math.max(48,...widths.map((w,col)=>wrapSkillText(row[col]??'',w).length*16*1.42+24));
      const heights=[headers.length?height(headers):0,...rows.map(height)],spans=rows.map(()=>1);
      if(kind==='status-table')for(let i=0;i<rows.length;){let end=i+1;while(end<rows.length&&rows[i].length&&rows[end].length&&rows[i][0]===rows[end][0]){spans[i]++;spans[end]=0;end++;}i=end;}
      for(const [ri,row] of [headers,...rows].entries()){
        if(ri===0&&!headers.length)continue;let cx=x;
        for(let ci=0;ci<count;ci++){
          const raw=String(row[ci]??'');
          if(!(ri>0&&ci===0&&kind==='status-table'&&spans[ri-1]===0)){
            let h=heights[ri];if(ri>0&&ci===0&&kind==='status-table')h=heights.slice(ri,ri+spans[ri-1]).reduce((a,b)=>a+b,0)+8*(spans[ri-1]-1);
            const n=add(`cell${ri}_${ci}`,raw,cx,y,widths[ci],{fill:ri===0?p.soft:p.surface,bold:ri===0,align:ri&&/^[\d.,%+\-¥$ ]+$/.test(raw.trim())?'right':'left'});n.height=round(h);
          }
          cx+=widths[ci]+8;
        }
        y+=heights[ri]+8;
      }
      y+=16;
    }
    background.height=round(Math.max(96,y-top));return background.height;
  }
  let y=40;
  const heading=(id,text,size,fill=p.surface)=>{const n=box(id,text,48,y,1040,{size,bold:size>=22,fill});y+=n.height+16;return n;};
  heading('wb_title',data.title??data.t??'会议纪要',32,p.canvas);
  if(data.subtitle??data.sub)heading('wb_subtitle',data.subtitle??data.sub,16,p.canvas);
  if(data.summary??data.sum)heading('wb_summary',data.summary??data.sum,20,p.soft);
  for(const [si,section] of (data.sections??data.sec??[]).entries()){
    y+=32;
    const start=nodes.length,top=y,tone=sectionTones[section.color]||sectionTones.slate;
    const frame=box(`sec${si}_frame`,'',32,top,1072,{fill:p.surface});frame.style.border_style='solid';frame.style.border_color=theme==='dark'?p.soft:'#CBD5E1';
    const stripe=box(`sec${si}_accent`,'',32,top,8,{fill:tone[1]});
    y+=16;
    const header=heading(`sec${si}_title`,`${String(si+1).padStart(2,'0')}  ${section.title??section.t??'议题'}`,24,theme==='dark'?p.soft:tone[0]);
    for(const [ii,item] of (section.items??section.b??[]).entries()){
      if(typeof item==='string'||item&&typeof item==='object'&&!item.type)heading(`sec${si}_note${ii}`,typeof item==='string'?item:item.text??item.t??'',16);
      else y+=card(item,y,`s${si}_c${ii}`)+24;
    }
    frame.height=round(y-top+8);frame.width=round(Math.max(1072,...nodes.slice(start+2).map(n=>n.x+n.width+16-32)));
    stripe.height=frame.height;header.width=frame.width-32;y=top+frame.height;
  }
  const canvasWidth=Math.max(1136,...nodes.map(n=>n.x+n.width+48));
  const background=box('wb_canvas','',0,0,canvasWidth,{minimum:y+40,fill:p.canvas});nodes.pop();nodes.unshift(background);
  for(const {id,a,b,vertical} of links){
    const endpoint=(n,start)=>({attached_object:{id:n.id,snap_to:vertical?(start?'bottom':'top'):(start?'right':'left'),position:vertical?{x:.5,y:start?1:0}:{x:start?1:0,y:.5}},arrow_style:start?'none':'triangle_arrow'});
    nodes.push({id,type:'connector',style:{border_color:p.ink,border_width:'narrow',border_style:'solid'},connector:{shape:'right_angled_polyline',start:endpoint(a,true),end:endpoint(b,false)}});
  }
  requireThat(nodes.length<=3000&&Buffer.byteLength(JSON.stringify(nodes))<=500000,'feishu_document_too_large',400);return nodes;
}

export function minutesSkillDsl(minutes,{citations}={}){
  const view=minutesOverview(minutes),cite=refs=>citations?citations(refs||[]):'',text=item=>minutesItemText(item)+cite(item.evidence),cited=item=>item.text+cite(item.evidence),sections=[];
  if(view.summary.length)sections.push({title:view.summaryLabel,color:'blue',items:view.summary.map(cited)});
  if(view.decisions.length)sections.push({title:'关键决策',color:'indigo',items:view.decisions.map(cited)});
  if(view.actions.length)sections.push({title:'推进安排与前置条件',color:'green',items:[{type:'action-list',actions:view.actions.map(a=>({t:a.text+cite(a.evidence),owner:a.owner||'待确认',due:a.due||'待确认',s:a.status||'unconfirmed'}))}]});
  if(view.pending.length)sections.push({title:'风险与待确认',color:'amber',items:view.pending.map(cited)});
  const branches=[...view.layout.branches];
  if(view.layout.unassigned.visuals.length||view.layout.unassigned.tables.length)branches.push({title:'补充图表',...view.layout.unassigned});
  for(const branch of branches){
    const items=[];if(branch.summary)items.push(branch.summary+cite(branch.evidence));items.push(...(branch.items||[]).map(text));
    for(const chart of branch.visuals||[])items.push(chart.kind==='timeline'?{type:'timeline',title:chart.title,events:chart.entries.map(e=>({t:e.label,d:e.text+cite(e.evidence),s:'',meta:'按会议提及顺序 · 时间保留原话'}))}:{type:'table',title:chart.title,headers:['对象',`数值（${chart.unit||'原单位'}）`],rows:chart.entries.map(e=>[e.label,e.valueText+cite(e.evidence)])});
    for(const grid of branch.tables||[])items.push({type:'table',title:grid.title,headers:grid.columns,rows:grid.rows.map(row=>row.cells.map((cell,i)=>cell+(i===grid.columns.length-1?cite(row.evidence):'')))});
    sections.push({title:branch.title,items});
  }
  return {title:minutes.title||'会议纪要',subtitle:`转录 v${minutes.transcriptRevision??'?'} · 纪要 v${minutes.revision??'?'}${minutes.edited?' · 人工修订':''}`,sections};
}
