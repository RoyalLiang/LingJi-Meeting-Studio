import {minutesItemText,minutesActionText} from '../../../../packages/records/src/minutes-quality.mjs';
import { requireThat } from '../../../../packages/records/src/record.mjs';

// Use native mind-map nodes so the exported outline remains editable in Feishu.
export function feishuBoard(minutes) {
  const nodes=[];
  const add=(text,parent)=>{
    if(!String(text||'').trim())return parent;
    const id=`n1:${nodes.length+1}`;
    nodes.push({id,type:'mind_map',text:{text:String(text)},...(parent?{mind_map_node:{parent_id:parent,type:'mind_map_round_rect'}}:{x:0,y:0,mind_map_root:{layout:'tree_right',type:'mind_map_round_rect',line_style:'curve'}})});
    return id;
  };
  const root=add(minutes.title||'会议纪要'),topics=new Map();
  for(const topic of minutes.topics||[]){const id=add(topic.title,root);if(topic.id)topics.set(topic.id,topics.has(topic.id)?null:id);add(topic.summary,id);}
  for(const section of minutes.sections||[]){const id=add(section.heading,root);for(const item of section.items||[])add(minutesItemText(item),(item.topicId?topics.get(item.topicId):undefined)||id);}
  for(const [heading,items] of [['重点速览',minutes.highlights],['关键决策',minutes.decisions],['行动候选',minutes.actions]]){
    if(!items?.length)continue;const id=add(heading,root);for(const item of items)add([heading==='行动候选'?minutesActionText(item,minutes.topics):minutesItemText(item),item.owner,item.due].filter(Boolean).join(' · '),id);
  }
  for(const table of minutes.tables||[]){const id=add(table.title,(table.topicId?topics.get(table.topicId):undefined)||root);add(table.columns.join(' · '),id);for(const row of table.rows)add(row.cells.join(' · '),id);}
  for(const visual of minutes.visuals||[]){const id=add(visual.title,(visual.topicId?topics.get(visual.topicId):undefined)||root);for(const item of visual.entries||[])add([item.label,item.text||item.valueText].filter(Boolean).join('：'),id);}
  requireThat(nodes.length<=3000&&Buffer.byteLength(JSON.stringify(nodes))<=500000,'feishu_document_too_large',400);
  return nodes;
}
