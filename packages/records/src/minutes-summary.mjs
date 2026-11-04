import {minutesOverview,minutesCompactOverview} from './minutes-presentation.mjs';

// DocX descendants accepts GridColumn/TableCell when their children are present.
// Keep this frozen graph as the source for both publication and preview.
export function minutesSummaryBlocks(minutes,{citations=()=>'',overview='full'}={}) {
  const view=overview==='full'?minutesOverview(minutes):minutesCompactOverview(minutes),descendants=[],children_id=[];
  const add=(block_type,key,data,children)=>{
    const block={block_id:`lingji-summary-${descendants.length+1}`,block_type,[key]:data,...(children?{children}: {})};
    descendants.push(block);return block.block_id;
  };
  const text=(content,{bold=false,color,type=2}={})=>add(type,type===4?'heading2':type===12?'bullet':'text',{
    elements:[{text_run:{content:String(content),...(bold||color?{text_element_style:{...(bold?{bold:true}:{}),...(color?{text_color:color}:{})}}:{})}}]
  });
  const cite=item=>`${item.text}${citations(item.evidence||[])}`;
  const callout=(label,items,color,background=color)=>add(19,'callout',{background_color:background,border_color:color},[
    text(label,{bold:true}),...(items.length?items.map(item=>text(cite(item),{type:12})):[text('纪要未列出')])
  ]);
  if(overview!=='board'){
  children_id.push(text('总结',{type:4}));
  children_id.push(callout(view.summaryLabel,overview==='compact'?view.brief:view.summary,7,15));
  const groups=overview==='compact'?view.themes.map((theme,index)=>[theme.title,[...(theme.summary?[{text:theme.summary,evidence:theme.evidence}]:[]),...theme.items],[6,4,3][index]]):[['关键决策',view.decisions,6],['下一步行动',view.actions.map(item=>({...item,text:`${item.text}\n负责人：${item.owner||'待确认'} · 时间：${item.due||'待确认'}`})),4],['风险与待确认',view.pending,3]];
  if(groups.length===1){const [label,items,color]=groups[0];children_id.push(callout(label,items,color));}
  else{
    const columns=groups.map(([label,items,color],index)=>add(25,'grid_column',{width_ratio:index===groups.length-1?100-Math.floor(100/groups.length)*(groups.length-1):Math.floor(100/groups.length)},[callout(label,items,color)]));
    children_id.push(add(24,'grid',{column_size:groups.length},columns));
  }
  }
  if(view.actions.length){
    children_id.push(text('推进安排与前置条件',{type:4}));
    const status={pending:'待确认',candidate:'候选',confirmed:'已确认',blocked:'受阻',completed:'已完成',done:'已完成'};
    // Limit individual native tables to 40 data rows; preserve all actions.
    for(let offset=0;offset<view.actions.length;offset+=40){
      const rows=[['阶段事项','负责人','时间','状态'],...view.actions.slice(offset,offset+40).map(item=>[
        cite(item),item.owner||'待确认',item.due||'待确认',status[item.status]||item.status||'待确认'
      ])];
      const cells=rows.flatMap((row,index)=>row.map(value=>add(32,'table_cell',{},[text(value,{bold:index===0})])));
      children_id.push(add(31,'table',{property:{row_size:rows.length,column_size:4,column_width:[360,120,140,100]}},cells));
    }
  }
  if(overview!=='full')children_id.push(text('完整纪要',{type:4}));
  return {children_id,descendants,index:-1};
}

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function summaryBlocksHtml(graph) {
  const blocks=new Map((graph?.descendants||[]).map(block=>[block.block_id,block])),seen=new Set();
  const render=id=>{
    const block=blocks.get(id);if(!block||seen.has(id))return '';seen.add(id);
    const children=()=> (block.children||[]).map(render).join('');
    if(block.block_type===19)return `<aside class="minutes-summary-callout tone-${[3,4,6].includes(block.callout.background_color)?block.callout.background_color:7}">${children()}</aside>`;
    if(block.block_type===24)return `<div class="minutes-summary-columns">${children()}</div>`;
    if(block.block_type===25)return `<div class="minutes-summary-column">${children()}</div>`;
    if(block.block_type===31){
      const size=block.table.property.column_size,rows=[];
      for(let i=0;i<block.children.length;i+=size)rows.push(`<tr>${block.children.slice(i,i+size).map(cell=>`<${i?'td':'th'}${i?'':' scope="col"'}>${render(cell)}</${i?'td':'th'}>`).join('')}</tr>`);
      return `<div class="minutes-summary-table" role="region" aria-label="推进安排与前置条件" tabindex="0"><table><thead>${rows[0]||''}</thead><tbody>${rows.slice(1).join('')}</tbody></table></div>`;
    }
    if(block.block_type===32)return children();
    const key=block.block_type===4?'heading2':block.block_type===12?'bullet':'text';
    const content=(block[key]?.elements||[]).map(element=>{
      const run=element.text_run;if(!run)return '';const value=escape(run.content).replaceAll('\n','<br>');return run.text_element_style?.bold?`<strong>${value}</strong>`:value;
    }).join('');
    return key==='heading2'?`<h2>${content}</h2>`:`<p${key==='bullet'?' class="minutes-summary-item"':''}>${content}</p>`;
  };
  return `<section class="minutes-summary" aria-label="会议总结">${(graph?.children_id||[]).map(render).join('')}</section>`;
}
