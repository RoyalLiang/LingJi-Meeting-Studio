import {minutesItemText,minutesActionText} from '../../../../packages/records/src/minutes-quality.mjs';
import { requireThat } from '../../../../packages/records/src/record.mjs';
import { minutesReadingLayout, uniqueMinutesItems } from '../../../../packages/records/src/minutes-reading.mjs';

// Use native mind-map nodes so the exported outline remains editable in Feishu.
export function feishuBoard(minutes) {
  const nodes=[];
  const add=(text,parent)=>{
    if(!String(text||'').trim())return parent;
    const id=`n1:${nodes.length+1}`;
    nodes.push({id,type:'mind_map',text:{text:String(text)},...(parent?{mind_map_node:{parent_id:parent,type:'mind_map_round_rect'}}:{x:0,y:0,mind_map_root:{layout:'tree_right',type:'mind_map_round_rect',line_style:'curve'}})});
    return id;
  };
  const root=add(minutes.title||'会议纪要'),layout=minutesReadingLayout(minutes);
  const tableNodes=(table,parent)=>{const id=add(table.title,parent);add(table.columns.join(' · '),id);for(const row of table.rows)add(row.cells.join(' · '),id);};
  const visualNodes=(visual,parent)=>{const id=add(visual.title,parent);for(const item of visual.entries||[])add([item.label,item.text||item.valueText].filter(Boolean).join('：'),id);};
  for(const branch of layout.branches){
    const id=add(branch.title,root);add(branch.summary,id);
    for(const item of branch.items)add(minutesItemText(item),id);
    for(const table of branch.tables)tableNodes(table,id);
    for(const visual of branch.visuals)visualNodes(visual,id);
  }
  for(const [heading,items] of [['重点速览',minutes.highlights],['关键决策',minutes.decisions],['行动候选',minutes.actions]]){
    if(!items?.length)continue;const id=add(heading,root);for(const item of minutes.edited?items:uniqueMinutesItems(items))add([heading==='行动候选'?minutesActionText(item,minutes.topics):minutesItemText(item),item.owner,item.due].filter(Boolean).join(' · '),id);
  }
  for(const table of layout.unassigned.tables)tableNodes(table,root);
  for(const visual of layout.unassigned.visuals)visualNodes(visual,root);
  requireThat(nodes.length<=3000&&Buffer.byteLength(JSON.stringify(nodes))<=500000,'feishu_document_too_large',400);
  return nodes;
}
