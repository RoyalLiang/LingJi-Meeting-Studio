import {requireThat} from './record.mjs';
import {minutesOverview} from './minutes-presentation.mjs';
import {minutesItemText} from './minutes-quality.mjs';

// Native adaptation of the bundled meeting-minutes compiler; no Python runtime or model call.
export const MEETING_MINUTES_SKILL='meeting-minutes/20261106-overview-v4';
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
      if(used+weight>limit&&line){
        const chars=Array.from(line),last=chars.at(-1),carry=/[，。！？、；：）】》」』,.!?;:)]/u.test(char)||/[（【《「『(]/u.test(last)?chars.pop():'';
        const previous=carry?chars.join(''):line;if(previous)lines.push(previous);line=carry;
        const carryCode=carry.codePointAt(0);used=carry?(carryCode<128?.56:carryCode>=0x2e80?1:.75):0;
      }
      line+=char;used+=weight;
    }
    if(line)lines.push(line);
  }
  return lines;
}

export function compileMeetingMinutesBoard(data,{theme='light'}={}){
  requireThat(data&&typeof data==='object'&&!Array.isArray(data),'invalid_meeting_minutes_skill',400);
  requireThat(['light','dark'].includes(theme),'invalid_meeting_minutes_skill',400);
  requireThat(Buffer.byteLength(JSON.stringify(data))<=500000,'feishu_document_too_large',400);
  const dark=theme==='dark',p={canvas:dark?'#1D1E20':'#ffffff',paper:dark?'#2b2f36':'#ffffff',ink:dark?'#ffffff':'#1f2329',muted:dark?'#ffffff':'#1f2329',line:dark?'#646a73':'#dee0e3',soft:dark?'#2b2f36':'#f5f5f5',blue:'#5178c6',blueSoft:dark?'#2b2f36':'#f0f4fc',green:'#509863',greenSoft:dark?'#2b2f36':'#dff5e5',amber:'#d4b45b',amberSoft:dark?'#2b2f36':'#fef1ce',red:'#d25d5a',redSoft:dark?'#2b2f36':'#fee3e2',purple:'#8569cb',purpleSoft:dark?'#2b2f36':'#eae2fe'};
  const nodes=[],links=[],width=1040,inner=976;
  const add=node=>{nodes.push(node);requireThat(nodes.length<=3000,'feishu_document_too_large',400);return node;};
  const measured=(value,w,size=18,padding=24)=>round(Math.max(size*1.5,wrapSkillText(value,w,size).length*size*1.5)+padding);
  const text=(id,value,x,y,w,{size=18,bold=false,color=p.ink,align='left',minimum=0}={})=>{
    const lines=wrapSkillText(value,w,size),height=round(Math.max(minimum,size*1.5,lines.length*size*1.5));
    return add({id,type:'text_shape',x:round(x),y:round(y),width:round(w),height,text:{text:lines.join('\n'),font_size:size,font_weight:bold?'bold':'regular',text_color:color,horizontal_align:align,vertical_align:'top'},style:{fill_opacity:0,border_style:'none'}});
  };
  const shape=(id,x,y,w,h,{fill=p.paper,stroke=p.line,kind='round_rect',value='',size=16,bold=false,color=p.ink}={})=>add({id,type:'composite_shape',x:round(x),y:round(y),width:round(w),height:round(h),composite_shape:{type:kind},text:{text:wrapSkillText(value,w,size).join('\n'),font_size:size,font_weight:bold?'bold':'regular',text_color:color,horizontal_align:'center',vertical_align:'mid'},style:{fill_color:fill,fill_opacity:100,border_color:stroke||fill,border_width:'extra_narrow',border_style:stroke?'solid':'none',border_radius:{top_left:12,top_right:12,bottom_left:12,bottom_right:12}}});
  const group=(id,x,y,w,h)=>add({id,type:'group',x:round(x),y:round(y),width:round(w),height:round(h)});
  const parent=(start,id)=>{for(const node of nodes.slice(start))if(!node.parent_id&&node.id!==id)node.parent_id=id;};
  const tone=value=>{
    const state=String(value||'').toLowerCase().replace(/[\s\ufe0f]/gu,'');
    if(['high','p0','blocked','阻塞','受阻','高风险','🔴','🔴阻塞'].includes(state))return [p.red,p.redSoft];
    if(['done','completed','已完成','正常','low','低风险','🟢','🟢正常'].includes(state))return [p.green,p.greenSoft];
    if(['active','进行中'].includes(state))return [p.blue,p.blueSoft];
    if(['med','medium','p1','关注','中风险','🟡','🟡关注'].includes(state))return [p.amber,p.amberSoft];
    return [p.line,p.soft];
  };
  const chip=(id,value,x,y,{w=116,fill=p.soft}={})=>shape(id,x,y,w,30,{fill,stroke:null,value,size:14,bold:true});
  const connect=(id,a,b,parentId,{vertical=false,arrow=true,color=p.line}={})=>links.push({id,a,b,parentId,vertical,arrow,color});
  const table=(id,headers,rows,x,y,{statusGroups=false}={})=>{
    const count=Math.max(headers.length,...rows.map(r=>r.length),1);requireThat(count<=40,'invalid_meeting_minutes_skill',400);
    const all=[...(headers.length?[headers]:[]),...rows],weights=Array.from({length:count},(_,c)=>Math.max(6,Math.min(32,Math.max(...[headers,...rows].map(r=>Array.from(String(r[c]??'')).length))))),total=weights.reduce((a,b)=>a+b,0);
    const extra=Math.max(0,inner-96*count),sizes=weights.map(w=>round(96+extra*w/total));
    if(!all.length)all.push(['暂无记录']);
    const heights=all.map(row=>round(Math.max(58,...sizes.map((w,c)=>measured(String(row[c]??''),w,16,28))))),cells=[],spans=rows.map(()=>1);
    if(statusGroups)for(let i=0;i<rows.length;){let end=i+1;while(end<rows.length&&rows[i].length&&rows[end].length&&rows[i][0]===rows[end][0]){spans[i]++;spans[end]=0;end++;}i=end;}
    for(const [ri,row] of all.entries())for(let ci=0;ci<count;ci++){
      const dataIndex=ri-(headers.length?1:0);if(statusGroups&&dataIndex>=0&&ci===0&&spans[dataIndex]===0)continue;
      const value=String(row[ci]??''),isHeader=headers.length&&ri===0,cellTone=tone(value),fill=isHeader?p.blueSoft:cellTone[0]!==p.line?cellTone[1]:p.paper;
      const cell={row_index:ri+1,col_index:ci+1,text:{text:wrapSkillText(value,sizes[ci],16).join('\n'),font_size:16,font_weight:isHeader?'bold':'regular',text_color:p.ink,horizontal_align:!isHeader&&/^[\d.,%+\-¥$ ]+$/.test(value.trim())?'right':'left',vertical_align:'mid'},style:{fill_color:fill}};
      if(statusGroups&&dataIndex>=0&&ci===0&&spans[dataIndex]>1)cell.merge_info={row_span:spans[dataIndex],col_span:1};cells.push(cell);
    }
    return add({id,type:'table',x:round(x),y:round(y),width:round(sizes.reduce((a,b)=>a+b,0)),height:round(heights.reduce((a,b)=>a+b,0)),text:{font_size:16,text_color:p.ink,horizontal_align:'left',vertical_align:'mid'},style:{fill_color:p.paper,border_color:p.line,border_width:'extra_narrow',border_style:'solid'},table:{meta:{row_num:all.length,col_num:count,row_sizes:heights,col_sizes:sizes},cells}});
  };
  function renderCard(raw,top,prefix,{skipTitle=false}={}){
    requireThat(raw&&typeof raw==='object'&&!Array.isArray(raw),'invalid_meeting_minutes_skill',400);
    const c={...raw},type=String(c.type||'table').toLowerCase().trim(),kind=aliases[type]||type;requireThat(kinds.has(kind),'invalid_meeting_minutes_skill',400);
    const generic=c.items||c.list||c.data||[],payload={flow:c.steps||c.events||generic,timeline:c.events||c.steps||generic,kpi:c.metrics||generic,'action-list':c.actions||c.todos||c.tasks||generic,'risk-matrix':c.risks||generic,'funnel-metric':c.bars||c.steps||generic};
    const start=nodes.length,container=group(prefix+'_group',48,top,width,80),x=80;
    let y=top+28;
    const label=(key,value,bx,by,bw,opts)=>text(prefix+'_'+key,value,bx,by,bw,opts),box=(key,bx,by,bw,bh,opts)=>shape(prefix+'_'+key,bx,by,bw,bh,opts),line=(key,a,b,opts)=>connect(prefix+'_'+key,a,b,container.id,opts);
    if(c.title&&!skipTitle)y+=label('title',c.title,x,y,inner,{size:24,bold:true}).height+28;
    if(kind==='flow'){
      const entries=payload.flow,columns=Math.min(4,Math.max(1,entries.length)),gap=40,cw=(inner-gap*(columns-1))/columns;let previous;
      for(let offset=0;offset<entries.length;offset+=columns){
        const staged=[];
        for(const [col,e] of entries.slice(offset,offset+columns).entries()){
          const bx=x+col*(cw+gap),state=e.s??e.status??'pending',[accent,fill]=tone(state),title=e.t||e.title||'',desc=e.d||e.desc||'',meta=join([e.time,e.owner,e.meta]);
          const h=80+measured(title,cw-32,20,0)+20+(desc?measured(desc,cw-32,17,0)+18:0)+(meta?measured(meta,cw-32,15,0)+18:0),panel=box('stage'+(offset+col),bx,y,cw,h,{fill,stroke:state==='active'?p.blue:p.line});
          box('number'+(offset+col),bx+18,y+18,32,32,{kind:'ellipse',fill:accent,stroke:null,value:String(offset+col+1),size:20,color:['active','done','completed'].includes(state)?'#ffffff':p.ink,bold:true});
          if(status(state))chip(prefix+'_state'+(offset+col),status(state),bx+58,y+20,{w:Math.max(94,cw-76),fill});
          let cy=y+70;cy+=label('stage_title'+(offset+col),title,bx+16,cy,cw-32,{size:20,bold:true}).height+16;
          if(desc)cy+=label('stage_desc'+(offset+col),desc,bx+16,cy,cw-32,{size:17}).height+16;
          if(meta)cy+=label('stage_meta'+(offset+col),meta,bx+16,cy,cw-32,{size:15}).height+18;
          panel.height=round(Math.max(h,cy-y));staged.push(panel);
          if(previous)line('flow_link'+(offset+col),previous,panel,{vertical:col===0,color:p.blue});previous=panel;
        }
        const h=Math.max(80,...staged.map(n=>n.height));for(const panel of staged)panel.height=h;y+=h+48;
      }
    }else if(kind==='branch'){
      const rootText=c.root||'',rootH=Math.max(74,measured(rootText,420,20,32)),root=box('root',x+(inner-420)/2,y,420,rootH,{kind:'flow_chart_round_rect2',value:rootText,size:20,bold:true,fill:p.blueSoft,stroke:p.blue});y+=rootH+36;
      const hubText=c.hub||'',hubH=Math.max(144,measured(hubText,200,20,64)),hub=box('hub',x+(inner-300)/2,y,300,hubH,{kind:'flow_chart_diamond',value:hubText,size:20,bold:true,fill:p.blueSoft,stroke:p.blue});line('root_hub',root,hub,{vertical:true,color:p.blue});y+=hubH+52;
      const branches=c.branches||[],cols=Math.min(3,Math.max(1,branches.length)),gap=48,cw=(inner-gap*(cols-1))/cols;
      for(let offset=0;offset<branches.length;offset+=cols){let bottom=y;
        for(const [col,entries] of branches.slice(offset,offset+cols).entries()){
          let cy=y,previous=hub;
          for(const [i,e] of entries.entries()){
            const state=e.s??e.status??'pending',content=join([e.t||e.title,e.d||e.desc,status(state)]),[accent,fill]=tone(state),h=Math.max(96,measured(content,cw,19,36));
            const node=box(`branch${offset+col}_${i}`,x+col*(cw+gap),cy,cw,h,{value:content,size:19,fill,stroke:accent});line(`branch_link${offset+col}_${i}`,previous,node,{vertical:true,color:state==='active'?p.blue:p.line});previous=node;cy+=h+40;
          }
          bottom=Math.max(bottom,cy);
        }y=bottom+24;
      }
    }else if(kind==='kpi'){
      for(const [i,m] of payload.kpi.entries()){
        y+=label(`metric${i}_label`,m.label||'',x,y,inner,{size:20,bold:true}).height+24;
        const left=x,right=x+inner/2+24,cw=inner/2-24,baseline=String(m.from??''),current=String(m.to??''),h=Math.max(204,measured(current,cw-40,64,112),measured(baseline,cw-40,48,100));
        box(`metric${i}_baseline_panel`,left,y,cw,h,{fill:p.soft,stroke:null});box(`metric${i}_current_panel`,right,y,cw,h,{fill:p.blueSoft,stroke:null});
        label(`metric${i}_from_label`,m.fromLabel??'基线',left+24,y+18,cw-48,{size:16});label(`metric${i}_from`,baseline,left+24,y+54,cw-48,{size:48,bold:true});
        label(`metric${i}_to_label`,m.toLabel??'当前值',right+24,y+18,cw-48,{size:16});label(`metric${i}_to`,current,right+24,y+50,cw-48,{size:64,bold:true,color:p.blue});
        if(m.delta)chip(prefix+`_metric${i}_delta`,m.delta,right+24,y+h-44,{w:Math.max(150,Math.min(cw-48,String(m.delta).length*14+32)),fill:p.greenSoft});
        y+=h+36;
      }
    }else if(kind==='timeline'){
      const events=payload.timeline;let previous;
      for(const [i,e] of events.entries()){
        const state=e.s??e.status??'pending',[accent,fill]=tone(state),heading=join([e.t||e.title,e.d||e.desc]),meta=[e.owner,e.meta].filter(Boolean).join(' · '),h=Math.max(110,measured(heading,inner-260,19,36)+(meta?measured(meta,inner-260,16,0)+12:0));
        const date=label('date'+i,e.time||'',x,y+8,150,{size:22,bold:true});const dot=box('dot'+i,x+174,y+12,18,18,{kind:'ellipse',fill:accent,stroke:null});
        const panel=box('event'+i,x+220,y,inner-220,h,{fill,stroke:null});let cy=y+18;cy+=label('event_text'+i,heading,x+240,cy,inner-260,{size:19,bold:true}).height+12;
        if(meta)cy+=label('event_meta'+i,meta,x+240,cy,inner-260,{size:16}).height+10;
        if(status(state)){chip(prefix+'_event_status'+i,status(state),x+240,cy,{fill});cy+=40;}
        panel.height=Math.max(panel.height,cy-y+12);if(previous)line('timeline_link'+i,previous,dot,{vertical:true,arrow:false,color:p.line});previous=dot;y+=Math.max(panel.height,date.height+8)+28;
      }
    }else if(kind==='grid'||kind==='pros-cons'){
      const entries=kind==='grid'?c.items||[]:[c.left||{},c.right||{}],cols=kind==='grid'?Math.min(3,Math.max(1,Math.trunc(Number(c.cols)||2))):2,gap=32,cw=(inner-gap*(cols-1))/cols;
      for(let offset=0;offset<entries.length;offset+=cols){let bottom=y;
        for(const [col,e] of entries.slice(offset,offset+cols).entries()){
          const bx=x+col*(cw+gap),startAt=nodes.length,item=group(prefix+'_panel'+(offset+col),bx,y,cw,80),accepted=/^(?:最终)?(?:已)?(?:采纳|确定|选定)[\s✓✔✅]*$/u.test(String(e.tag||'').trim()),fill=accepted?p.greenSoft:p.paper;
          const background=box('panel_bg'+(offset+col),bx,y,cw,80,{fill,stroke:accepted?p.green:p.line});let cy=y+24;
          if(e.tag){chip(prefix+'_panel_tag'+(offset+col),e.tag,bx+20,cy,{w:cw-40,fill:accepted?p.greenSoft:p.amberSoft});cy+=46;}
          if(e.t||e.title)cy+=label('panel_title'+(offset+col),e.t||e.title,bx+20,cy,cw-40,{size:22,bold:true}).height+20;
          if(e.d||e.desc)cy+=label('panel_desc'+(offset+col),e.d||e.desc,bx+20,cy,cw-40,{size:18}).height+20;
          for(const [bi,value] of (e.items||[]).entries()){
            box(`panel_bullet${offset+col}_${bi}`,bx+22,cy+9,6,6,{kind:'ellipse',fill:accepted?p.green:p.blue,stroke:null});cy+=label(`panel_item${offset+col}_${bi}`,String(value),bx+42,cy,cw-62,{size:18}).height+18;
          }
          item.height=background.height=round(cy-y+10);parent(startAt,item.id);bottom=Math.max(bottom,cy+10);
        }y=bottom+28;
      }
      if(c.verdict){const h=measured(c.verdict,inner-40,20,36);box('verdict_panel',x,y,inner,h,{fill:p.greenSoft,stroke:null});label('verdict',c.verdict,x+20,y+18,inner-40,{size:20,bold:true});y+=h+28;}
    }else if(kind==='quote-decision'){
      if(c.speaker)y+=label('speaker',c.speaker,x,y,inner,{size:18,bold:true}).height+18;
      if(c.role){chip(prefix+'_role',c.role,x,y,{w:Math.min(inner,Math.max(180,String(c.role).length*16+32)),fill:p.amberSoft});y+=50;}
      y+=label('quote',c.text||'',x+16,y,inner-32,{size:30,bold:true}).height+28;
      if(c.impact)y+=label('impact',c.impact,x+16,y,inner-32,{size:18}).height+20;
    }else if(kind==='funnel-metric'){
      let previous;
      for(const [i,e] of payload['funnel-metric'].entries()){
        const pct=Number(e.pct??0);requireThat(Number.isFinite(pct)&&pct>=0&&pct<=100,'invalid_meeting_minutes_skill',400);
        const rowH=Math.max(94,measured(e.label||'',212,18,28),measured(join([e.val,e.note]),212,18,28)),plot=480,w=Math.max(.1,plot*pct/100),bx=x+248+(plot-w)/2;
        label('funnel_label'+i,e.label||'',x,y+14,220,{size:18,bold:true});
        const value=join([e.val,e.note]);label('funnel_value'+i,value,x+768,y+12,inner-768,{size:18,bold:true});
        if(pct>0){const node=box('funnel'+i,bx,y,w,rowH,{kind:'flow_chart_trapezoid',fill:i===payload['funnel-metric'].length-1?p.green:p.blue,stroke:null});if(previous)line('funnel_link'+i,previous,node,{vertical:true,color:p.line});previous=node;}
        y+=rowH+24;
      }
    }else if(kind==='action-list'){
      const actions=payload['action-list'],buckets=[...new Set(actions.map(a=>status(a.s??'unconfirmed')||'待确认'))],gap=32;
      const action=(a,i,bx,by,cw)=>{
        const startAt=nodes.length,entry=group(prefix+'_action'+i,bx,by,cw,100),panel=box('action_panel'+i,bx,by,cw,100,{fill:p.paper,stroke:p.line});let cy=by+18;
        if(a.p){chip(prefix+'_priority'+i,a.p,bx+16,cy,{w:64,fill:tone(a.p)[1]});cy+=46;}
        cy+=label('action_text'+i,a.t??a.title??'',bx+16,cy,cw-32,{size:18,bold:true}).height+20;
        const owner=!a.owner||a.owner==='待确认'?'负责人待确认':a.owner,due=!a.due||a.due==='待确认'?'时间待确认':a.due;
        cy+=label('action_meta'+i,`${owner} · ${due}`,bx+16,cy,cw-32,{size:16}).height+18;
        entry.height=panel.height=round(cy-by);parent(startAt,entry.id);return entry;
      };
      if(buckets.length===1){
        const [bucket]=buckets,[accent,fill]=tone(bucket),cw=(inner-gap)/2;
        chip(prefix+'_lane0',`${bucket} · ${actions.length}`,x,y,{w:inner,fill});box('lane_rule0',x,y+34,inner,1,{fill:accent,stroke:null});y+=52;
        for(let offset=0;offset<actions.length;offset+=2){
          const row=actions.slice(offset,offset+2).map((a,col)=>action(a,offset+col,x+col*(cw+gap),y,cw));
          y+=Math.max(...row.map(n=>n.height))+20;
        }
      }else{
        const cols=Math.min(3,Math.max(1,buckets.length)),cw=(inner-gap*(cols-1))/cols;
        for(let offset=0;offset<buckets.length;offset+=cols){let bottom=y;
          for(const [col,bucket] of buckets.slice(offset,offset+cols).entries()){
            const bx=x+col*(cw+gap),items=actions.map((a,i)=>({a,i})).filter(({a})=>(status(a.s??'unconfirmed')||'待确认')===bucket),[accent,fill]=tone(bucket);
            chip(prefix+'_lane'+(offset+col),`${bucket} · ${items.length}`,bx,y,{w:cw,fill});box('lane_rule'+(offset+col),bx,y+34,cw,1,{fill:accent,stroke:null});let cy=y+52;
            for(const {a,i} of items)cy+=action(a,i,bx,cy,cw).height+20;
            bottom=Math.max(bottom,cy);
          }y=bottom+24;
        }
      }
    }else if(kind==='risk-matrix'){
      const risks=payload['risk-matrix'],cols=Math.min(2,Math.max(1,risks.length)),gap=32,cw=(inner-gap*(cols-1))/cols;
      for(let offset=0;offset<risks.length;offset+=cols){let rowBottom=y;
        for(const [col,r] of risks.slice(offset,offset+cols).entries()){
          const bx=x+col*(cw+gap),startAt=nodes.length,index=offset+col,entry=group(prefix+'_risk'+index,bx,y,cw,100),[accent,fill]=tone(r.level||'unconfirmed'),panel=box('risk_panel'+index,bx,y,cw,100,{fill,stroke:accent});let cy=y+20;
          chip(prefix+'_risk_level'+index,String(r.level||'未评级').toUpperCase(),bx+20,cy,{w:100,fill});cy+=48;
          cy+=label('risk_text'+index,r.risk||'',bx+20,cy,cw-40,{size:21,bold:true}).height+24;
          cy+=label('risk_mitigation'+index,join(['缓解措施',r.mitigation||'待确认']),bx+20,cy,cw-40,{size:18}).height+20;
          if(r.owner)cy+=label('risk_owner'+index,r.owner,bx+20,cy,cw-40,{size:16,bold:true}).height+18;
          entry.height=panel.height=round(cy-y+6);parent(startAt,entry.id);rowBottom=Math.max(rowBottom,cy+6);
        }y=rowBottom+28;
      }
    }else{
      const grid=table(prefix+'_table',c.headers||[],c.rows||[],x,y,{statusGroups:kind==='status-table'&&c.mergeFirstColumn!==false});y+=grid.height+28;container.width=Math.max(width,grid.width+64);
    }
    if(y<=top+28){y+=label('empty','暂无记录',x,y,inner,{size:18}).height+24;}
    container.height=round(Math.max(100,y-top));parent(start,container.id);return container;
  }
  let y=32;
  y+=text('wb_title',data.title??data.t??'会议纪要',48,y,1040,{size:30,bold:true,color:dark?'#ffffff':p.ink}).height+16;
  if(data.subtitle??data.sub)y+=text('wb_subtitle',data.subtitle??data.sub,48,y,1040,{size:16,color:dark?'#ffffff':p.ink}).height+24;
  if(data.summary??data.sum){const value=data.summary??data.sum,h=measured(value,1040,22,40);shape('wb_summary_panel',48,y,1040,h,{fill:p.blueSoft,stroke:null});text('wb_summary',value,68,y+20,1000,{size:22,bold:true});y+=h+28;}
  for(const [si,section] of (data.sections??data.sec??[]).entries()){
    const title=section.title??section.t??'议题',sameTitle=title===(data.title??data.t);y+=sameTitle?12:36;const start=nodes.length,outer=group(`sec${si}`,24,y,1088,100);y+=sameTitle?0:24;
    if(title!==(data.title??data.t))y+=text(`sec${si}_heading`,title,64,y,1008,{size:26,bold:true}).height+24;
    for(const [ii,item] of (section.items??section.b??[]).entries()){
      if(typeof item==='string'||item&&typeof item==='object'&&!item.type)y+=text(`sec${si}_note${ii}`,typeof item==='string'?item:item.text??item.t??'',64,y,1008,{size:18}).height+20;
      else{const card=renderCard(item,y,`s${si}_c${ii}`,{skipTitle:item.title===title});y+=card.height+16;}
    }
    outer.height=round(Math.max(120,y-outer.y+16));outer.width=round(Math.max(1088,...nodes.slice(start+1).map(n=>n.x+(n.width||0)-outer.x+24)));parent(start,outer.id);y=outer.y+outer.height;
  }
  const canvasWidth=Math.max(1136,...nodes.map(n=>n.x+(n.width||0)+32)),canvas=shape('wb_canvas',0,0,canvasWidth,y+32,{fill:p.canvas,stroke:null});canvas.locked=true;nodes.pop();nodes.unshift(canvas);
  for(const {id,a,b,parentId,vertical,arrow,color} of links){
    const end=(n,start)=>({attached_object:{id:n.id,snap_to:vertical?(start?'bottom':'top'):(start?'right':'left'),position:vertical?{x:.5,y:start?1:0}:{x:start?1:0,y:.5}},arrow_style:start||!arrow?'none':'triangle_arrow'});
    add({id,type:'connector',parent_id:parentId,style:{border_color:color,border_width:'narrow',border_style:'solid'},connector:{shape:'right_angled_polyline',start:end(a,true),end:end(b,false)}});
  }
  const original=new Map(nodes.map(n=>[n.id,{...n}]));
  // Feishu groups collect nodes without translating their coordinates. Sections
  // provide the coordinate frame, even through one or more nested groups.
  for(const node of nodes)if(node.parent_id&&Number.isFinite(node.x)&&Number.isFinite(node.y)){
    let frame=original.get(node.parent_id);
    while(frame?.type==='group')frame=original.get(frame.parent_id);
    node.x=round(node.x-(frame?.x||0));node.y=round(node.y-(frame?.y||0));
  }
  requireThat(nodes.length<=3000&&Buffer.byteLength(JSON.stringify(nodes))<=500000,'feishu_document_too_large',400);return nodes;
}

export function minutesSkillDsl(minutes,{citations}={}){
  const view=minutesOverview(minutes),cite=refs=>citations?citations(refs||[]):'',text=item=>minutesItemText(item)+cite(item.evidence),cited=item=>item.text+cite(item.evidence),sections=[];
  const actions=items=>({type:'action-list',actions:items.map(a=>({t:cited(a),owner:a.owner||'待确认',due:a.due||'待确认',s:a.status||'unconfirmed'}))});
  const decisions=items=>items.map(item=>({type:'quote-decision',text:cited(item)}));
  if(view.summary.length)sections.push({title:view.summaryLabel,color:'blue',items:[{type:'grid',cols:2,items:view.summary.map(item=>({d:cited(item)}))}]});
  if(view.decisions.length)sections.push({title:'关键决策',color:'indigo',items:decisions(view.decisions)});
  if(view.actions.length)sections.push({title:'推进安排与前置条件',color:'green',items:[actions(view.actions)]});
  const branches=[...view.layout.branches];
  if(view.layout.unassigned.visuals.length||view.layout.unassigned.tables.length)branches.push({title:'补充图表',...view.layout.unassigned});
  for(const branch of branches){
    const items=[],source=branch.items||[],facts=source.filter(i=>!['risk','question','decision','action'].includes(i.kind));
    if(branch.summary)items.push(branch.summary+cite(branch.evidence));
    if(facts.length)items.push({type:'grid',title:'事实与现状',cols:2,items:facts.map(item=>({d:text(item)}))});
    const risks=source.filter(i=>i.kind==='risk');
    if(risks.length)items.push({type:'risk-matrix',title:'风险与影响',risks:risks.map(item=>({risk:text(item),mitigation:item.mitigation||'待确认',...(item.level?{level:item.level}:{}),...(item.owner?{owner:item.owner}:{})}))});
    const questions=source.filter(i=>i.kind==='question');
    if(questions.length)items.push({type:'status-table',mergeFirstColumn:false,title:'待确认事项',headers:['待确认事项','当前状态'],rows:questions.map(item=>[text(item),['pending','unconfirmed'].includes(item.status)?'待确认':status(item.status)||'待确认'])});
    items.push(...decisions(source.filter(i=>i.kind==='decision').map(item=>({...item,text:minutesItemText(item)}))));
    const proposed=source.filter(i=>i.kind==='action');if(proposed.length)items.push({...actions(proposed.map(item=>({...item,text:minutesItemText(item)}))),title:'讨论中的行动候选'});
    for(const chart of branch.visuals||[])items.push(chart.kind==='timeline'?{type:'timeline',title:chart.title,events:chart.entries.map(e=>({time:e.label,t:e.text+cite(e.evidence),s:'',meta:'按会议提及顺序 · 时间保留原话'}))}:{type:'table',title:chart.title,headers:['对象',`数值（${chart.unit||'原单位'}）`],rows:chart.entries.map(e=>[e.label,e.valueText+cite(e.evidence)])});
    for(const grid of branch.tables||[])items.push({type:grid.columns.some(c=>/状态|健康|进展/.test(c))?'status-table':'table',mergeFirstColumn:false,title:grid.title,headers:grid.columns,rows:grid.rows.map(row=>row.cells.map((cell,i)=>cell+(i===grid.columns.length-1?cite(row.evidence):'')))});
    sections.push({title:branch.title,items});
  }
  return {title:minutes.title||'会议纪要',subtitle:`转录 v${minutes.transcriptRevision??'?'} · 纪要 v${minutes.revision??'?'}${minutes.edited?' · 人工修订':''}`,sections};
}

// Split independent entries, never infer a graph or truncate a source paragraph.
export function compileMeetingMinutesPages(data,options={}){
  const maxHeight=1000,pages=[];
  const listFields={grid:'items','risk-matrix':'risks','action-list':'actions',timeline:'events',table:'rows','status-table':'rows'};
  for(const section of data.sections||[]){
    if(!section.items?.length)continue;
    let pending=[],part=0;
    const title=()=>part?`${section.title}（续${part+1}）`:section.title;
    const render=items=>compileMeetingMinutesBoard({title:title(),subtitle:[data.title,data.subtitle].filter(Boolean).join(' · '),sections:[{...section,title:title(),items}]},options);
    const fits=items=>{
      try{return render(items)[0].height<=maxHeight;}
      catch(error){if(error.code==='feishu_document_too_large')return false;throw error;}
    };
    const flush=()=>{if(pending.length){pages.push({title:title(),nodes:render(pending)});pending=[];part++;}};
    const append=item=>{if(pending.length&&!fits([...pending,item]))flush();pending.push(item);};
    for(const item of section.items){
      const field=item&&typeof item==='object'?listFields[aliases[item.type]||item.type]:undefined,entries=field&&item[field];
      if(!Array.isArray(entries)||!entries.length){append(item);continue;}
      let chunk=[];
      for(const entry of entries){
        const candidate={...item,[field]:[...chunk,entry]};
        if(chunk.length&&!fits([candidate])){append({...item,[field]:chunk});chunk=[];}
        chunk.push(entry);
      }
      if(chunk.length)append({...item,[field]:chunk});
    }
    flush();
  }
  if(!pages.length)pages.push({title:data.title||'会议纪要',nodes:compileMeetingMinutesBoard(data,options)});
  requireThat(pages.reduce((sum,p)=>sum+p.nodes.length,0)<=3000&&Buffer.byteLength(JSON.stringify(pages))<=500000,'feishu_document_too_large',400);
  return pages;
}
