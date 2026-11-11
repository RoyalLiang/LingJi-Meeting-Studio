import {digest,requireThat} from './record.mjs';

export function gitRoot(value){
  let url;try{url=new URL(value);}catch{requireThat(false,'invalid_git_sync',400);}
  const parts=url.pathname.replace(/\/$/,'').split('/').filter(Boolean);
  requireThat(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&parts.length>0&&parts.length<=12&&parts.every(p=>/^[A-Za-z0-9_.-]+$/.test(p)&&!['.','..'].includes(p)),'invalid_git_sync',400);
  return {origin:url.origin,path:parts.join('/'),url:`${url.origin}/${parts.join('/')}`};
}
export const inGitRoot=(project,root)=>!project.archived&&project.namespace&&(project.namespace.full_path===root.full_path||project.namespace.full_path.startsWith(root.full_path+'/'));
const normalized=value=>String(value).normalize('NFKC').toLocaleLowerCase('en').trim();
function includesName(title,value){
  const name=normalized(value);if(name.length<3)return false;
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return /[^\x00-\x7f]/.test(name)?title.includes(name):new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`,'u').test(title);
}
export function gitTarget(record,projects,mappings=[],aliases=[]){
  const matches=projects.filter(p=>[p.name,...aliases.filter(a=>a.projectId===p.id).map(a=>a.name)].some(name=>includesName(normalized(record.title),name)));
  const mapped=mappings.find(m=>m.workspaceId===record.workspaceId),workspace=mapped&&projects.find(p=>p.id===mapped.projectId);
  if(matches.length>1||workspace&&matches.length===1&&matches[0].id!==workspace.id)return {status:'blocked',reason:'git_target_conflict'};
  if(mapped&&!workspace)return {status:'blocked',reason:'git_target_unavailable'};
  const project=workspace||matches[0];
  return project?{status:'eligible',basis:workspace?'workspace':'title',project}:{status:'blocked',reason:'git_target_unclear'};
}
export const gitSourceHash=(record,includeNotes=false)=>digest(JSON.stringify({title:record.title,createdAt:record.createdAt,workspaceId:record.workspaceId||null,minutes:record.minutes,minutesRevision:record.minutesRevision,transcriptRevision:record.transcriptRevision,...(includeNotes?{notes:record.notes,notesRevision:record.notesRevision}:{})}));
export function gitCitations(minutes){const refs=new Map();const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){if(key==='evidence'&&Array.isArray(child)){for(const ref of child)if(typeof ref.segmentId==='string'&&Number.isSafeInteger(ref.revision))refs.set(`${ref.segmentId}:${ref.revision}`,{segmentId:ref.segmentId,revision:ref.revision});}else if(key!=='evidenceSnapshot')visit(child);}};visit(minutes);return [...refs.values()];}
export function gitArchivePath(value){
  requireThat(typeof value==='string'&&value.length<=160&&value.split('/').every(p=>/^[\p{L}\p{N}\p{M}._() -]+$/u.test(p)&&p.trim()===p&&!['.','..'].includes(p))&&!value.startsWith('.git'),'invalid_git_sync',400);
  return value;
}
export function gitFinal(record){return record.capture==='completed'&&record.transcription==='ready'&&record.minutes&&record.minutes.transcriptRevision===record.transcriptRevision&&!record.jobs.some(j=>['queued','running'].includes(j.status))&&record.jobs.filter(j=>j.scope!=='live').at(-1)?.status!=='failed';}

export function gitMeetingFilename(record,timezone='Asia/Shanghai'){
  let title=String(record.title||'会议').normalize('NFKC').replace(/[^\p{L}\p{N}\p{M} ._()-]+/gu,'-').replace(/\s+/g,' ').replace(/^[. -]+|[. -]+$/g,'')||'会议';
  title=[...title].slice(0,100).join('');
  while(Buffer.byteLength(title)>180)title=[...title].slice(0,-1).join('');
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(record.createdAt));
  return `${title}-${date}.md`;
}
