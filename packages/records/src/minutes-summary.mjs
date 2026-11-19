import {minutesOverview,minutesCompactOverview,minutesSummaryCards} from './minutes-presentation.mjs';

const personStyle={bold:true,background_color:4};

// DocX descendants accepts GridColumn/TableCell when their children are present.
// Keep this frozen graph as the source for both publication and preview.
export function minutesSummaryBlocks(minutes,{citations=()=>'',overview='full',personNames=()=>[],personRefs=[]}={}) {
  const view=overview==='full'?minutesOverview(minutes):minutesCompactOverview(minutes),descendants=[],children_id=[];
  const add=(block_type,key,data,children)=>{
    const block={block_id:`lingji-summary-${descendants.length+1}`,block_type,[key]:data,...(children?{children}: {})};
    descendants.push(block);return block.block_id;
  };
  const run=(content,style)=>({text_run:{content,...(style?{text_element_style:style}:{})}});
  const text=(content,{bold=false,type=2,refs=[]}={})=>add(type,type===4?'heading2':type===5?'heading3':type===12?'bullet':'text',{
    elements:[run(String(content),bold?{bold:true}:undefined),...personNames(refs).flatMap(name=>[run(' '),run(`\u00a0${name}\u00a0`,personStyle)])]
  });
  const cite=item=>`${item.text}${citations(item.evidence||[])}`;
  const group=(label,items,kind)=>{
    if(!items.length)return;
    children_id.push(text(label,{type:5}));
    for(const item of items){
      const prefix=item.label?.trim();
      let content=item.text.trim();
      if(prefix){
        while(content.startsWith(prefix)){
          const suffix=content.slice(prefix.length).trimStart();
          if(suffix&&!/^[：:·，,—]/u.test(suffix))break;
          content=suffix.slice(1).trimStart();
        }
      }
      const line=!prefix?content:!content?prefix:kind==='action'?`${content}（${prefix}）`:`${prefix}：${content}`;
      children_id.push(text(cite({...item,text:line}),{type:12,refs:item.evidence}));
    }
  };

  const callout=(label,items,color,background=color)=>add(19,'callout',{background_color:background,border_color:color},[
    text(label,{bold:true}),...(items.length?items.map(item=>text(cite(item),{type:12,refs:item.evidence})):[text('纪要未列出')])
  ]);
  if(personNames(personRefs).length)children_id.push(text('引用中的人物',{bold:true,refs:personRefs}));
  if(overview==='full'){
    children_id.push(text('总结',{type:4}),callout(view.summaryLabel,view.summary,7,15));
    const groups=[['关键决策',view.decisions,6],['下一步行动',view.actions.map(item=>({...item,text:`${item.text}\n负责人：${item.owner||'待确认'} · 时间：${item.due||'待确认'}`})),4],['风险与待确认',view.pending,3]];
    const columns=groups.map(([label,items,color],index)=>add(25,'grid_column',{width_ratio:index===2?34:33},[callout(label,items,color)]));
    children_id.push(add(24,'grid',{column_size:3},columns));
  }else{
    const selected=minutesSummaryCards(minutes,view);
    if(overview!=='board'&&view.brief.length){
      children_id.push(text('总结',{type:4}));
      for(const item of view.brief)children_id.push(text(cite(item),{refs:item.evidence}));
    }
    if(selected.length||(overview==='compact'&&view.themes.length)){
      children_id.push(text('会议要点',{type:4}));
      if(selected.length)for(const card of selected)group(card.title,card.items,card.kind);
      else for(const theme of view.themes)group(theme.title,[...(theme.summary?[{text:theme.summary,evidence:theme.evidence}]:[]),...theme.items]);
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
    if(block.block_type===19)return `<aside class="minutes-summary-callout tone-${[1,3,4,5,6].includes(block.callout.background_color)?block.callout.background_color:7}">${children()}</aside>`;
    if(block.block_type===24)return `<div class="minutes-summary-columns" data-columns="${block.grid.column_size===2?2:3}">${children()}</div>`;
    if(block.block_type===25)return `<div class="minutes-summary-column">${children()}</div>`;
    if(block.block_type===31){
      const size=block.table.property.column_size,rows=[];
      for(let i=0;i<block.children.length;i+=size)rows.push(`<tr>${block.children.slice(i,i+size).map(cell=>`<${i?'td':'th'}${i?'':' scope="col"'}>${render(cell)}</${i?'td':'th'}>`).join('')}</tr>`);
      return `<div class="minutes-summary-table" role="region" aria-label="推进安排与前置条件" tabindex="0"><table><thead>${rows[0]||''}</thead><tbody>${rows.slice(1).join('')}</tbody></table></div>`;
    }
    if(block.block_type===32)return children();
    const key=block.block_type===4?'heading2':block.block_type===5?'heading3':block.block_type===12?'bullet':'text';
    const content=(block[key]?.elements||[]).map(element=>{
      const run=element.text_run;if(!run)return '';const value=escape(run.content).replaceAll('\n','<br>');
      if(run.text_element_style?.background_color===personStyle.background_color)return `<span class="minutes-person-pill">${value}</span>`;
      return run.text_element_style?.bold?`<strong>${value}</strong>`:value;
    }).join('');
    return key==='heading2'?`<h2>${content}</h2>`:key==='heading3'?`<h3>${content}</h3>`:`<p${key==='bullet'?' class="minutes-summary-item"':''}>${content}</p>`;
  };
  return `<section class="minutes-summary" aria-label="会议总结">${(graph?.children_id||[]).map(render).join('')}</section>`;
}
