import {minutesActionText, minutesItemText} from './minutes-quality.mjs';
import {minutesReadingLayout, uniqueMinutesItems} from './minutes-reading.mjs';

const themes={light:{bg:'#FFFFFF',ink:'#252A32',muted:'#626A76',line:'#E1E5EB',figure:'#F6F7F9',purple:['#555C9F','#F1F2FC','#CDD1F0'],green:['#426E4B','#F0F6F0','#C8DDCB'],amber:['#896127','#FBF5E9','#E9D6B3'],rose:['#925477','#FAF0F5','#E6CAD9']},dark:{bg:'#1D1E20',ink:'#E5E6E9',muted:'#ABB0B9',line:'#3C3F46',figure:'#282A2E',purple:['#B7BBF2','#28283E','#4D507B'],green:['#ADD2AF','#25342A','#3C5E43'],amber:['#DDBF88','#373024','#6E5939'],rose:['#DFB5CD','#352832','#67495D']}};
const colors=['purple','green','amber','rose'];
const unique=values=>uniqueMinutesItems(values||[]);
const pending=item=>['risk','question'].includes(item.kind)||['pending','blocked','unconfirmed'].includes(item.status);
export function minutesOverview(minutes){
  const layout=minutesReadingLayout(minutes),items=layout.branches.flatMap(branch=>branch.items);
  const select=values=>minutes.edited?values||[]:unique(values),actions=select(minutes.actions).map(item=>({...item,text:minutesActionText(item,minutes.topics)}));
  const highlights=select(minutes.highlights),summary=highlights.length?highlights:layout.branches.filter(branch=>branch.summary).map(branch=>({text:branch.summary,evidence:branch.evidence}));
  const unresolved=actions.filter(item=>!item.owner||!item.due).map(item=>({...item,text:`${item.text}（${!item.owner?'负责人待确认':''}${!item.owner&&!item.due?'；':''}${!item.due?'时间待确认':''}）`}));
  return {layout,summaryLabel:highlights.length?'核心结论':'主题概览',summary:summary.map(item=>({...item,text:minutesItemText(item)})),decisions:select(minutes.decisions).map(item=>({...item,text:minutesItemText(item)})),actions,pending:select([...items.filter(pending),...unresolved]).map(item=>({...item,text:minutesItemText(item)}))};
}
// Explicit line breaks keep the native board and exported SVG on the same layout.
const wrap=(value,width,size)=>{
  const lines=[];let line='',used=0;
  for(const char of String(value??'')){
    const advance=/[\u0000-\u00ff]/.test(char)?size*.57:size;
    if(char==='\n'||used+advance>width){lines.push(line);line='';used=0;}
    if(char!=='\n'){line+=char;used+=advance;}
  }
  lines.push(line);return lines;
};
function canvas(theme,citations){
  const p=themes[theme]||themes.light,nodes=[];
  const add=node=>{const value={id:`n1:${nodes.length+1}`,...node};nodes.push(value);return value;};
  const rect=(x,y,width,height,fill=p.figure,stroke=p.line)=>add({type:'composite_shape',x,y,width,height,composite_shape:{type:'round_rect'},style:{fill_color:fill,fill_opacity:100,border_style:stroke?'solid':'none',border_color:stroke||fill,border_width:'extra_narrow',border_radius:{top_left:5,top_right:5,bottom_left:5,bottom_right:5}}});
  const measure=(value,width,size,refs=[])=>wrap(String(value??'')+(refs.length&&typeof citations==='function'?citations(refs):''),width,size).length*size*1.6;
  const text=(value,x,y,width,{size=16,bold=false,color=p.ink,refs=[]}={})=>{
    const suffix=refs.length&&typeof citations==='function'?citations(refs):'';
    const lines=wrap(String(value??'')+suffix,width,size),height=Math.max(size*1.6,lines.length*size*1.6);
    add({type:'text_shape',x,y,width,height,text:{text:lines.join('\n'),font_size:size,font_weight:bold?'bold':'regular',text_color:color,horizontal_align:'left',vertical_align:'top'},style:{fill_opacity:0,border_style:'none'}});
    return height;
  };
  const line=(x1,y1,x2,y2,color=p.line,arrow=false)=>add({type:'connector',x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1),style:{border_color:color,border_width:'extra_narrow',border_style:'solid'},connector:{start:{position:{x:x1,y:y1},arrow_style:'none'},end:{position:{x:x2,y:y2},arrow_style:arrow?'triangle_arrow':'none'},shape:'straight'}});
  const table=(title,columns,rows,x,y,width)=>{
    const start=y;rect(x,y,width,34,p.figure);text(title,x+12,y+5,width-24,{size:14,bold:true});y+=34;
    const cellWidth=width/columns.length;
    for(const [index,row] of [columns,...rows].entries()){
      const height=Math.max(38,...row.map(cell=>wrap(cell,cellWidth-20,14).length*23+16));
      for(let col=0;col<columns.length;col++){const cell=rect(x+col*cellWidth,y,cellWidth,height,index===0?p.figure:p.bg);cell.style.border_radius={top_left:0,top_right:0,bottom_left:0,bottom_right:0};text(row[col]||'',x+col*cellWidth+10,y+8,cellWidth-20,{size:14,bold:index===0});}
      y+=height;
    }
    return y-start;
  };
  const visual=(value,x,y,width)=>{
    const start=y,panel=rect(x,y,width,1,p.figure);text(value.title,x+12,y+6,width-24,{size:14,bold:true});y+=48;
    if(value.kind==='bar'){
      text(`单位：${value.unit}`,x+12,y,width-24,{size:12,color:p.muted});y+=28;
      const numbers=value.entries.map(entry=>{const matches=String(entry.valueText).replaceAll(',','').match(/-?\d+(?:\.\d+)?/g);return matches?.length===1?Number(matches[0]):NaN;});
      const valid=numbers.every(Number.isFinite),min=Math.min(0,...numbers),max=Math.max(0,...numbers),span=max-min||1,left=x+width*.4,plotWidth=width*.38,zero=left+(0-min)/span*plotWidth;
      for(const [i,entry] of value.entries.entries()){
        const h=Math.max(40,measure(entry.label,width*.35,14,entry.evidence)+10);text(entry.label,x+12,y,width*.35,{size:14,refs:entry.evidence});
        if(valid){const end=left+(numbers[i]-min)/span*plotWidth;rect(Math.min(zero,end),y+5,Math.max(1,Math.abs(end-zero)),15,p.purple[0],null);line(zero,y,zero,y+h,p.line);}
        text(entry.valueText,x+width*.81,y,width*.18,{size:14});y+=h;
      }
    }else{
      text('按会议提及顺序 · 时间保留原话',x+12,y,width-24,{size:12,color:p.muted});y+=30;
      const axis=x+20;
      for(const entry of value.entries||[]){
        const h=Math.max(55,measure(`${entry.label}：${entry.text}`,width-58,15,entry.evidence)+18);
        line(axis,y,axis,y+h,p.amber[2]);rect(axis-3,y+9,6,6,p.amber[0],null);text(`${entry.label}：${entry.text}`,x+42,y,width-58,{size:15,refs:entry.evidence});y+=h;
      }
    }
    panel.height=y-start+8;return panel.height;
  };
  return {p,nodes,rect,text,line,table,visual,measure};
}
// These are explicit excerpts; full source wording remains in the native minutes.
const excerpt=(value,limit)=>{const chars=Array.from(String(value??'').replace(/\s+/g,' ').trim());return chars.length>limit?chars.slice(0,limit-1).join('')+'…':chars.join('');};
export function minutesCompactOverview(minutes){
  const view=minutesOverview(minutes),brief=(items,count,limit)=>items.slice(0,count).map(item=>({...item,text:excerpt(item.text,limit),evidence:(item.evidence||[]).slice(0,3)}));
  const themes=view.layout.branches.slice(0,3).map(branch=>({title:excerpt(branch.title,24),summary:excerpt(branch.summary,90),evidence:(branch.evidence||[]).slice(0,3),items:brief((branch.items||[]).map(item=>({...item,text:minutesItemText(item)})),3,64)}));
  if(!themes.length)themes.push({title:'会议要点',summary:'',evidence:[],items:brief(view.summary,3,64)});
  const table=[...view.layout.branches.flatMap(branch=>branch.tables),...view.layout.unassigned.tables].find(value=>value.columns?.length>1&&value.columns.length<=4&&value.rows?.length);
  return {...view,themes,brief:brief(view.summary,2,96),next:brief(view.actions,2,90),constraints:brief(view.pending,2,90),comparison:table?{...table,title:excerpt(table.title,44),columns:table.columns.map(value=>excerpt(value,24)),rows:table.rows.slice(0,4).map(row=>({...row,evidence:(row.evidence||[]).slice(0,3),cells:row.cells.map(value=>excerpt(value,44))}))}:null};
}
export function minutesOverviewBoard(minutes,{theme='light',citations}={}){
  const view=minutesCompactOverview(minutes),c=canvas(theme,citations),{p,rect,text,table}=c,width=1120,pad=32,gap=18,inner=width-pad*2;
  const background=rect(0,0,width,1,p.bg,null);let y=28;
  y+=text(excerpt(minutes.title||'会议纪要',44),pad,y,inner,{size:25,bold:true})+12;
  y+=text(`图文总览 · ${view.layout.branches.length||1} 个主题 · 转录 v${minutes.transcriptRevision??'?'}${minutes.edited?' · 人工修订':''}`,pad,y,inner,{size:12,color:p.muted})+20;
  const conclusion=rect(pad,y,inner,1,p.figure,null);let cursor=y+16;
  text(view.summaryLabel,pad+18,cursor,112,{size:14,bold:true,color:p.muted});
  for(const item of view.brief.length?view.brief:[{text:'纪要未列出核心结论'}])cursor+=text(item.text,pad+142,cursor,inner-162,{size:17,bold:true,refs:item.evidence})+8;
  conclusion.height=Math.max(66,cursor-y+8);y+=conclusion.height+22;
  const cardWidth=(inner-gap*(view.themes.length-1))/view.themes.length,heights=[];
  view.themes.forEach((value,index)=>{
    const x=pad+index*(cardWidth+gap),color=p[['purple','green','amber'][index]],outer=rect(x,y,cardWidth,1,color[1],color[2]);
    const titleHeight=Math.max(48,c.measure(value.title,cardWidth-32,17)+24);rect(x,y,cardWidth,titleHeight,color[1],null);text(value.title,x+16,y+12,cardWidth-32,{size:17,bold:true,color:color[0]});
    const panel=rect(x+6,y+titleHeight,cardWidth-12,1,p.bg,null);let top=y+titleHeight+16;
    if(value.summary)top+=text(value.summary,x+20,top,cardWidth-40,{size:15,bold:true,refs:value.evidence})+14;
    for(const item of value.items)top+=text(`• ${item.text}`,x+20,top,cardWidth-40,{size:14,refs:item.evidence})+10;
    if(!value.summary&&!value.items.length)top+=text('纪要未列出',x+20,top,cardWidth-40,{size:14,color:p.muted});
    const height=Math.max(170,top-y+12);panel.height=height-titleHeight-6;outer.height=height;heights.push({height,panel,outer,titleHeight});
  });
  const height=Math.max(...heights.map(item=>item.height));for(const item of heights){item.outer.height=height;item.panel.height=height-item.titleHeight-6;}y+=height+22;
  if(view.comparison){const grid=view.comparison;y+=table(`${grid.title||'对照与前置条件'} · 摘录`,grid.columns,grid.rows.map(row=>row.cells.map((cell,index)=>cell+(index===grid.columns.length-1&&citations?citations(row.evidence||[]):''))),pad,y,inner)+14;}
  else{
    const bottomWidth=(inner-gap)/2,panels=[];
    for(const [index,label,items] of [[0,'下一步',view.next],[1,'约束与待确认',view.constraints]]){const x=pad+index*(bottomWidth+gap),panel=rect(x,y,bottomWidth,1,p.figure,null);let top=y+14;top+=text(label,x+16,top,bottomWidth-32,{size:15,bold:true})+10;for(const item of items.length?items:[{text:'纪要未列出'}])top+=text(item.text,x+16,top,bottomWidth-32,{size:14,refs:item.evidence})+10;panels.push({panel,height:top-y+4});}const bottomHeight=Math.max(...panels.map(item=>item.height));for(const item of panels)item.panel.height=bottomHeight;y+=bottomHeight+14;
  }
  y+=text('总览为原文摘录；完整讨论、行动安排与引用见下文。',pad,y,inner,{size:12,color:p.muted});background.height=y+24;return c.nodes;
}
export function minutesBoard(minutes,{theme='light',citations,includeSummary=true}={}){
  const view=minutesOverview(minutes),c=canvas(theme,citations),{p,rect,text,line,table,visual}=c;
  const width=1120,background=rect(0,0,width,1,p.bg),heading=(value,y)=>text(value,28,y,1064,{size:21,bold:true});
  let y=24;
  y+=heading(minutes.title||'会议纪要',y)+16;
  text(`转录 v${minutes.transcriptRevision??'?'} · 纪要 v${minutes.revision??'?'}${minutes.edited?' · 人工修订':''}`,28,y,1064,{size:12,color:p.muted});y+=34;
  if(includeSummary){
    y+=heading('会议总览',y)+14;
    if(view.summary.length){
      const box=rect(28,y,1064,1,p.figure);let cursor=y+14;
      text(view.summaryLabel,44,cursor,110,{size:13,color:p.muted});
      for(const [i,item] of view.summary.entries())cursor+=text(item.text,170,cursor,900,{size:i===0?18:15,bold:i===0,refs:item.evidence})+12;
      box.height=cursor-y+2;y=cursor+22;
    }
    const groups=[['关键决策',view.decisions,'purple'],['下一步行动',view.actions,'green'],['风险与待确认',view.pending,'amber']];
    const tops=y,heights=[];
    for(const [i,[label,items,color]] of groups.entries()){
      const x=28+i*360,outer=rect(x,tops,344,1,p[color][1],null);text(label,x+14,tops+10,316,{size:15,bold:true,color:p[color][0]});
      const inner=rect(x+4,tops+42,336,1,p.bg,null);let cursor=tops+55;
      if(!items.length)cursor+=text('纪要未列出',x+16,cursor,310,{size:14,color:p.muted})+14;
      for(const item of items){const detail=color==='green'?[item.text,`负责人：${item.owner||'待确认'} · 时间：${item.due||'待确认'}`].join('\n'):item.text;cursor+=text(detail,x+16,cursor,310,{size:14,refs:item.evidence})+14;}
      heights.push(cursor-tops+6);outer.height=heights[i];inner.height=outer.height-46;
    }
    const groupHeight=Math.max(...heights);
    // Equal outer heights do not constrain any of the text nodes.
    for(const node of c.nodes)if(node.type==='composite_shape'&&node.y===tops&&node.width===344)node.height=groupHeight;
    for(const node of c.nodes)if(node.type==='composite_shape'&&node.y===tops+42&&node.width===336)node.height=groupHeight-46;
    y=tops+groupHeight+24;
    if(view.actions.length)y+=table('推进安排与前置条件',['阶段事项','负责人','时间','状态'],view.actions.map(item=>[item.text,item.owner||'待确认',item.due||'待确认',({pending:'待确认',candidate:'候选',confirmed:'已确认',blocked:'受阻',completed:'已完成',done:'已完成'})[item.status]||item.status||'待确认']),28,y,1064)+28;
  }
  y+=heading('主题脉络图',y)+18;
  const trunk=y;let last=trunk;
  const branch=(value,index)=>{
    const color=p[colors[index%colors.length]],start=y;
    const titleHeight=Math.max(36,wrap(value.title,960,18).length*29+12);rect(62,y,1000,titleHeight,color[1],null);text(value.title,76,y+6,972,{size:18,bold:true,color:color[0]});line(42,y+titleHeight/2,62,y+titleHeight/2,color[2]);last=y+titleHeight/2;y+=titleHeight+14;
    const child=(item)=>{const height=Math.max(42,c.measure(item.text,930,15,item.evidence)+22);rect(102,y,960,height,color[1],null);text(item.text,116,y+9,930,{size:15,refs:item.evidence});line(82,y+height/2,102,y+height/2,color[2]);y+=height+12;};
    if(value.summary)child({text:value.summary,evidence:value.evidence});
    for(const item of value.items||[])child({...item,text:minutesItemText(item)});
    for(const chart of value.visuals||[]){const height=visual(chart,102,y,960);line(82,y+18,102,y+18,color[2]);y+=height+12;}
    for(const grid of value.tables||[]){const height=table(grid.title,grid.columns,grid.rows.map(row=>row.cells.map((cell,index)=>cell+(index===grid.columns.length-1&&citations?citations(row.evidence||[]):''))),102,y,960);line(82,y+18,102,y+18,color[2]);y+=height+12;}
    if(y>start+titleHeight+14)line(82,start+titleHeight,82,y-30,color[2]);y+=22;
  };
  view.layout.branches.forEach(branch);
  if(view.layout.unassigned.visuals.length||view.layout.unassigned.tables.length)branch({title:'其他图表',items:[],...view.layout.unassigned},view.layout.branches.length);
  if(last>trunk)line(42,trunk,42,last,p.line);
  background.height=y+8;return c.nodes;
}
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const numeric=value=>Number.isFinite(value)?value:0;
export function boardSvg(nodes,{responsiveTheme=false}={}){
  const original=new Map(nodes.map(node=>[node.id,node])),resolved=new Map();
  const frameOf=node=>{
    const seen=new Set();let parent=original.get(node?.parent_id);
    while(parent?.type==='group'){
      if(seen.has(parent.id))return undefined;
      seen.add(parent.id);parent=original.get(parent.parent_id);
    }
    return parent;
  };
  const locate=(node,seen=new Set())=>{
    if(resolved.has(node.id))return resolved.get(node.id);
    if(seen.has(node.id))return {...node,x:numeric(node.x),y:numeric(node.y)};
    seen.add(node.id);const parent=frameOf(node),origin=parent?locate(parent,seen):{x:0,y:0};
    const result={...node,x:numeric(node.x)+origin.x,y:numeric(node.y)+origin.y};resolved.set(node.id,result);return result;
  };
  const world=nodes.map(node=>locate(node)),byId=new Map(world.map(node=>[node.id,node]));
  const position=(end,node)=>{const ref=end?.attached_object,target=byId.get(ref?.id),parent=byId.get(frameOf(node)?.id);return target?{x:target.x+target.width*(ref.position?.x??.5),y:target.y+target.height*(ref.position?.y??.5)}:end?.position?{x:numeric(end.position.x)+(parent?.x||0),y:numeric(end.position.y)+(parent?.y||0)}:undefined;};
  const shapes=world.filter(node=>['text_shape','composite_shape','connector','section','table'].includes(node.type)&&(node.type==='connector'?position(node.connector?.start,node)&&position(node.connector?.end,node):Number.isFinite(node.x)&&Number.isFinite(node.y)));
  if(!shapes.length)return '';
  const width=Math.max(...world.map(node=>node.x+numeric(node.width))),height=Math.max(...world.map(node=>node.y+numeric(node.height)));
  const map=new Map();for(const [key,value] of Object.entries(themes.light))if(Array.isArray(value))value.forEach((color,i)=>map.set(color,themes.dark[key][i]));else map.set(value,themes.dark[key]);
  const color=value=>/^#[\da-f]{6}$/i.test(value||'')?(responsiveTheme&&map.has(value)?`var(--b${value.slice(1)},${value})`:value):'none';
  const css=responsiveTheme?`<style>@media(prefers-color-scheme:dark){.minutes-canvas{${[...map].map(([a,b])=>`--b${a.slice(1)}:${b}`).join(';')}}}</style>`:'';
  const words=(value,x,y,{size=16,bold=false,ink='#1f2329',align='left',ratio=1.5}={})=>`<text x="${numeric(x)}" y="${numeric(y)}" text-anchor="${align==='right'?'end':align==='center'?'middle':'start'}" fill="${color(ink)}" font-size="${numeric(size)}" font-weight="${bold?600:400}">${String(value||'').split('\n').map((line,i)=>`<tspan x="${numeric(x)}" dy="${i?size*ratio:0}">${escape(line)}</tspan>`).join('')}</text>`;
  const content=shapes.map(node=>{
    const {x,y}=node,w=numeric(node.width),h=numeric(node.height);
    if(node.type==='connector'){
      const a=position(node.connector?.start,node),b=position(node.connector?.end,node);if(!a||!b)return '';
      const vertical=['top','bottom'].includes(node.connector?.end?.attached_object?.snap_to),middle=vertical?numeric(a.y)+(numeric(b.y)-numeric(a.y))/2:numeric(a.x)+(numeric(b.x)-numeric(a.x))/2;
      const path=node.connector?.shape==='right_angled_polyline'?(vertical?`M${a.x} ${a.y}V${middle}H${b.x}V${b.y}`:`M${a.x} ${a.y}H${middle}V${b.y}H${b.x}`):`M${a.x} ${a.y}L${b.x} ${b.y}`;
      const stroke=color(node.style?.border_color),direction=vertical?Math.sign(b.y-a.y)||1:Math.sign(b.x-a.x)||1;
      const arrow=node.connector?.end?.arrow_style&&node.connector.end.arrow_style!=='none'?`<path d="${vertical?`M${b.x} ${b.y}L${b.x-4} ${b.y-9*direction}L${b.x+4} ${b.y-9*direction}Z`:`M${b.x} ${b.y}L${b.x-9*direction} ${b.y-4}L${b.x-9*direction} ${b.y+4}Z`}" fill="${stroke}"/>`:'';
      return `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.4"/>${arrow}`;
    }
    if(node.type==='section')return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${node.style?.fill_opacity===0?'none':color(node.style?.fill_color)}" stroke="${color(node.style?.fill_color)}"/>${words(node.section?.title,x+8,Math.max(16,y-10),{size:14,bold:true,ink:node.style?.fill_opacity===0?'#ffffff':'#1f2329'})}`;
    if(node.type==='table'){
      const rows=node.table?.meta?.row_sizes||[],cols=node.table?.meta?.col_sizes||[],sum=(values,end)=>values.slice(0,end).reduce((a,b)=>a+numeric(b),0);
      return (node.table?.cells||[]).map(cell=>{
        const row=Math.max(0,cell.row_index-1),col=Math.max(0,cell.col_index-1),cx=x+sum(cols,col),cy=y+sum(rows,row),cw=sum(cols,col+(cell.merge_info?.col_span||1))-sum(cols,col),ch=sum(rows,row+(cell.merge_info?.row_span||1))-sum(rows,row),t=cell.text||{},size=numeric(t.font_size)||16,lines=String(t.text||'').split('\n'),align=t.horizontal_align||'left',tx=align==='right'?cx+cw-14:align==='center'?cx+cw/2:cx+14,ty=cy+(ch-lines.length*size*1.5)/2+size*1.15;
        return `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" fill="${color(cell.style?.fill_color||node.style?.fill_color)}" stroke="${color(node.style?.border_color)}" stroke-width="1"/>${words(t.text,tx,ty,{size,bold:t.font_weight==='bold',ink:t.text_color||node.text?.text_color,align})}`;
      }).join('');
    }
    if(node.type==='text_shape'){
      const size=numeric(node.text?.font_size)||16,lines=String(node.text?.text||'').split('\n'),ratio=Math.max(1.2,Math.min(1.8,h/(Math.max(1,lines.length)*size))),align=node.text?.horizontal_align||'left',tx=align==='right'?x+w:align==='center'?x+w/2:x;
      return words(node.text?.text,tx,y+size*1.15,{size,bold:node.text?.font_weight==='bold',ink:node.text?.text_color,align,ratio});
    }
    if(node.type==='composite_shape'){
      const fill=color(node.style?.fill_color),stroke=node.style?.border_style==='none'?'none':color(node.style?.border_color),style=`fill="${fill}" stroke="${stroke}"`,kind=node.composite_shape?.type;
      const figure=kind==='ellipse'?`<ellipse cx="${x+w/2}" cy="${y+h/2}" rx="${w/2}" ry="${h/2}" ${style}/>`:kind==='flow_chart_diamond'?`<path d="M${x+w/2} ${y}L${x+w} ${y+h/2}L${x+w/2} ${y+h}L${x} ${y+h/2}Z" ${style}/>`:kind==='flow_chart_trapezoid'?`<path d="M${x} ${y}H${x+w}L${x+w*.85} ${y+h}H${x+w*.15}Z" ${style}/>`:`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${kind==='flow_chart_round_rect2'?Math.min(w,h)/2:numeric(node.style?.border_radius?.top_left??5)}" ${style}/>`;
      const t=node.text||{},size=numeric(t.font_size)||16,lines=String(t.text||'').split('\n'),align=t.horizontal_align||'center',tx=align==='right'?x+w-16:align==='center'?x+w/2:x+16,ty=y+(h-lines.length*size*1.42)/2+size*1.1;
      return figure+(t.text?words(t.text,tx,ty,{size,bold:t.font_weight==='bold',ink:t.text_color,align,ratio:1.42}):'');
    }
    return '';
  }).join('');
  return `<svg class="minutes-canvas" viewBox="0 0 ${width} ${height}" role="img" aria-label="会议总览与主题图表" style="display:block;width:100%;height:auto;font-family:system-ui,sans-serif"><title>会议总览与主题图表</title>${css}${content}</svg>`;
}
