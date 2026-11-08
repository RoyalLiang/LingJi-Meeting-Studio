import {requireThat} from '../../../packages/records/src/record.mjs';

export function historyQuery(url){
  const params=new URL(url,'http://localhost').searchParams;
  return params.has('limit')||params.has('cursor')?{limit:params.get('limit')??'20',cursor:params.get('cursor')||''}:null;
}
export async function taskHistoryPage({repo,kind,owner,fields,query={},recordId,automatic,visible=async rows=>rows,map=row=>row}){
  const limit=Number(query.limit??20),cursor=query.cursor||'';
  requireThat(Number.isSafeInteger(limit)&&limit>=1&&limit<=100&&typeof cursor==='string'&&cursor.length<=700,'invalid_history_query',400);
  let before;
  if(cursor){
    try{before=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{/* Invalid cursors fail the same bounded validation. */}
    requireThat(/^[\w-]+$/.test(cursor)&&Array.isArray(before)&&before.length===2&&((typeof before[0]==='string'&&before[0].length<=200)||(Number.isSafeInteger(before[0])&&before[0]>=0))&&typeof before[1]==='string'&&before[1].length>0&&before[1].length<=200,'invalid_history_query',400);
  }
  const page=[];let scanned=0,last;
  const result=async more=>({items:await Promise.all(page.map(map)),nextCursor:more&&last?Buffer.from(JSON.stringify([last.createdAt,last.id])).toString('base64url'):null});
  while(scanned<1000){
    const batchSize=Math.min(100,limit+1,1000-scanned),rows=await repo.listMetadata(kind,owner,fields,{recordId,automatic,limit:batchSize,before});
    const allowed=new Set((await visible(rows)).map(row=>row.id));
    for(const row of rows){
      if(allowed.has(row.id)){if(page.length===limit)return result(true);page.push(row);}
      last=row;scanned++;
    }
    if(rows.length<batchSize)return result(false);
    before=[last.createdAt,last.id];
  }
  return result(true);
}
