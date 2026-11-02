const textKey=value=>String(value||'').trim();
const union=refs=>[...new Map(refs.map(ref=>[JSON.stringify([ref.segmentId,ref.revision]),ref])).values()];

// Only a stable task identity proves duplication; stripped or unknown identities stay separate.
export function uniqueMinutesItems(items=[]) {
  if(items.length<2||!items.some(item=>typeof item.id==='string'&&item.id))return items;
  const entries=new Map(),references=new Map();
  for(const item of items){
    if(typeof item.id!=='string'||!item.id){entries.set(Symbol(),item);continue;}
    const key=JSON.stringify([textKey(item.text),item.topicId,item.label,item.kind,item.status,item.owner,item.due,item.id,item.correctionOf]);
    const previous=entries.get(key);
    if(!previous){entries.set(key,item);continue;}
    if(!references.has(key))references.set(key,new Map((previous.evidence||[]).map(ref=>[JSON.stringify([ref.segmentId,ref.revision]),ref])));
    const refs=references.get(key);
    for(const ref of item.evidence||[])refs.set(JSON.stringify([ref.segmentId,ref.revision]),ref);
  }
  return [...entries].map(([key,item])=>references.has(key)?{...item,evidence:[...references.get(key).values()]}:item);
}

export function minutesReadingSections(minutes) {
  if(minutes.edited)return minutes.sections||[];
  return (minutes.sections||[]).flatMap(section=>{
    const items=section.items.filter(item=>item.label!=='过程记录');
    return items.length?[items.length===section.items.length?section:{...section,items}]:[];
  });
}

export function minutesReadingBranches(minutes) {
  const topics=minutes.topics||[],branches=topics.map(topic=>({...topic,summary:topic.summary||'',evidence:topic.evidence||[],items:[]}));
  const ids=new Map(),titles=new Map(),other=new Map();
  topics.forEach((topic,index)=>{
    if(topic.id)ids.set(topic.id,ids.has(topic.id)?-1:index);
    titles.set(topic.title,titles.has(topic.title)?-1:index);
  });
  for(const section of minutesReadingSections(minutes))for(const item of section.items){
    const index=(item.topicId?ids.get(item.topicId):titles.get(section.heading))??-1;
    if(index>=0)branches[index].items.push(section.heading===topics[index].title?item:{...item,label:[section.heading,item.label].filter(Boolean).join(' · ')});
    else {
      if(!other.has(section.heading)){const branch={title:section.heading,summary:'',evidence:[],items:[]};other.set(section.heading,branch);branches.push(branch);}
      other.get(section.heading).items.push(item);
    }
  }
  for(const branch of branches){
    if(!minutes.edited)branch.items=uniqueMinutesItems(branch.items);
    branch.evidence=union([...branch.evidence,...branch.items.flatMap(item=>item.evidence||[])]);
    if(!minutes.edited&&branch.items.some(item=>textKey(item.text)===textKey(branch.summary)))branch.summary='';
  }
  return branches;
}

// Explicit topic IDs only; shared citations are not proof of topic ownership.
export function minutesReadingLayout(minutes) {
  const branches=minutesReadingBranches(minutes).map(branch=>({...branch,tables:[],visuals:[]})),ids=new Map();
  branches.forEach((branch,index)=>{if(branch.id)ids.set(branch.id,ids.has(branch.id)?-1:index);});
  const unassigned={tables:[],visuals:[]};
  for(const kind of ['tables','visuals'])for(const value of minutes[kind]||[]){
    const index=ids.get(value.topicId)??-1;
    (index>=0?branches[index]:unassigned)[kind].push(value);
  }
  return {branches,unassigned};
}
