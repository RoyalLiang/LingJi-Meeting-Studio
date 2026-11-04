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
  const shapes=nodes.filter(node=>['text_shape','composite_shape','connector'].includes(node.type)&&Number.isFinite(node.x)&&Number.isFinite(node.y));
  if(!shapes.length)return '';
  const width=Math.max(...shapes.map(node=>node.x+(node.width||0))),height=Math.max(...shapes.map(node=>node.y+(node.height||0)));
  const map=new Map();for(const [key,value] of Object.entries(themes.light))if(Array.isArray(value))value.forEach((color,i)=>map.set(color,themes.dark[key][i]));else map.set(value,themes.dark[key]);
  const color=value=>/^#[\da-f]{6}$/i.test(value||'')?(responsiveTheme&&map.has(value)?`var(--b${value.slice(1)},${value})`:value):'none';
  const css=responsiveTheme?`<style>@media(prefers-color-scheme:dark){.minutes-canvas{${[...map].map(([a,b])=>`--b${a.slice(1)}:${b}`).join(';')}}}</style>`:'';
  const content=shapes.map(node=>{
    const {x,y,width:w,height:h}=node;
    if(node.type==='connector'){const a=node.connector?.start?.position,b=node.connector?.end?.position;if(!a||!b)return '';return `<path d="M${numeric(a.x)} ${numeric(a.y)}L${numeric(b.x)} ${numeric(b.y)}" fill="none" stroke="${color(node.style?.border_color)}" stroke-width="1.2"/>`;}
    if(node.type==='text_shape'){
      const size=numeric(node.text?.font_size)||16;
      return `<text x="${x}" y="${y+size*1.15}" fill="${color(node.text?.text_color)}" font-size="${size}" font-weight="${node.text?.font_weight==='bold'?600:400}">${String(node.text?.text||'').split('\n').map((value,i)=>`<tspan x="${x}" dy="${i?size*1.6:0}">${escape(value)}</tspan>`).join('')}</text>`;
    }
    if(node.type==='composite_shape')return `<rect x="${x}" y="${y}" width="${numeric(w)}" height="${numeric(h)}" rx="${numeric(node.style?.border_radius?.top_left??5)}" fill="${color(node.style?.fill_color)}" stroke="${node.style?.border_style==='none'?'none':color(node.style?.border_color)}"/>`;
    return '';
  }).join('');
  return `<svg class="minutes-canvas" viewBox="0 0 ${width} ${height}" role="img" aria-label="会议总览与主题图表" style="display:block;width:100%;height:auto;font-family:system-ui,sans-serif"><title>会议总览与主题图表</title>${css}${content}</svg>`;
}
