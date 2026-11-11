import {modelConfigFingerprint} from './model-profile.mjs';
import {taskHistoryPage} from './task-history.mjs';
import {externalWrite} from './external-write.mjs';
import {meetingTasks,openMeetingHarness} from './meeting-tasks.mjs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {createModels} from '@earendil-works/pi-ai/models';
import {defineDoc,defineTask,defineExtension,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {DomainError,digest,requireThat} from '../../../packages/records/src/record.mjs';
import {gitRoot,gitTarget,gitSourceHash,gitArchivePath,gitFinal,gitCitations} from '../../../packages/records/src/git-sync.mjs';
import {createSecretStore} from './integrations/secret-store.mjs';
import {createGitlab} from './integrations/gitlab.mjs';
import {exportMinutesMarkdown} from './markdown-export.mjs';
import {readConfig} from './config.mjs';

const Index=defineDoc({kind:'git-sync.index.v1',version:1,scope:'session',initial:()=>({jobs:[]}),checkpointWhen:()=>true});
const ruleId=owner=>`git-sync-rule:${digest(owner)}`;
const now=()=>new Date().toISOString();
const terminal=outcome=>({status:'terminal',outcome});
const safeCode=error=>/^(?:git_[a-z_]+|external_write_(?:unknown|conflict)|remote_[a-z_]+|minutes_not_configured|extension_[a-z_]+|mcp_[a-z_]+|agent_[a-z_]+|invalid_agent_output|invalid_llm_response|provider_(?:[a-z_]+|http_[45]\d{2})|llm_[a-z_]+)$/.test(error?.code||'')?error.code:'git_sync_failed';
const recoverable=code=>/^(?:provider_http_50[234]|llm_(?:timeout|connection_failed|stream_(?:failed|incomplete|interrupted))|invalid_agent_output)$/.test(code||'');
const inline=value=>String(value).replace(/[<>]/g,c=>c==='<'?'&lt;':'&gt;').replace(/([\\`*_{}[\]#|])/g,'\\$1');
const modelHash=config=>digest(JSON.stringify([config.LLM_MODEL||'',config.LLM_API_URL||'',config.LLM_PROTOCOL||'',config.LLM_REASONING_EFFORT||'']));
const writeFingerprint=job=>digest(JSON.stringify([job.archiveKey,job.project.id,job.branch,job.files,job.mode]));
function confirmedArchive(job){
  if(!['mr','direct'].includes(job.mode)||!job.files||!Object.keys(job.files).length||!Object.values(job.files).every(value=>typeof value==='string')||!job.project?.path||!Number.isSafeInteger(job.project.id)||!job.branch)return null;
  const commit=job.writes?.commit,receipt=commit?.receipt,fingerprint=writeFingerprint(job);
  if(commit?.status!=='confirmed'||commit.fingerprint!==fingerprint||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt?.commit||'')||job.commit&&job.commit!==receipt.commit)return null;
  const commitPath=`/${job.project.path}/-/commit/${receipt.commit}`;
  const parse=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash?url:null;}catch{return null;}};
  if(job.mode==='direct'||receipt.integrated===true){
    const url=parse(job.url);return url?.pathname===commitPath?{commit:receipt.commit,url:url.href,integrated:receipt.integrated===true}:null;
  }
  const merge=job.writes?.merge,result=merge?.receipt,url=parse(result?.url);
  if(merge?.status!=='confirmed'||merge.fingerprint!==fingerprint||!Number.isSafeInteger(result?.iid)||result.iid<=0||url?.pathname!==`/${job.project.path}/-/merge_requests/${result.iid}`)return null;
  if(job.url){const previous=parse(job.url);if(!previous||previous.origin!==url.origin||![commitPath,url.pathname].includes(previous.pathname))return null;}
  return {commit:receipt.commit,url:url.href,iid:result.iid,integrated:false};
}
const publicRule=rule=>rule?{configured:true,enabled:rule.enabled,root:rule.root,group:rule.group,projects:rule.projects,prompt:rule.prompt,skillId:rule.scope.skill.id,skillVersion:rule.scope.skill.version,skillIds:(rule.scope.skills||[rule.scope.skill]).map(s=>s.id),skillVersions:Object.fromEntries((rule.scope.skills||[rule.scope.skill]).map(s=>[s.id,s.version])),pluginIds:rule.scope.plugins.map(p=>p.id),pluginVersions:Object.fromEntries(rule.scope.plugins.map(p=>[p.id,p.version])),mappings:rule.mappings,aliases:rule.aliases,directory:rule.directory,mode:rule.mode,timezone:rule.timezone,includeNotes:rule.includeNotes,includeEvidence:rule.includeEvidence,hasToken:Boolean(rule.credentials),generation:rule.generation}:{configured:false,enabled:false};

export async function createGitSync({repo,agent,extensions,localAccount=false,request,pollMs=30000,agentPollMs=1000,retryDelayMs=30000}={}){
  const kernel=meetingTasks(repo),secrets=await createSecretStore(repo.root),git=createGitlab({request,localAccount});
  const lock=new DatabaseSync(join(repo.root,'git-sync-lock.sqlite'));
  try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_lock(v INTEGER)');}catch{lock.close();throw new DomainError('git_sync_busy',503);}
  let harness,root,timer,closing=false,busy=false,operations=Promise.resolve();const sourceCache=new Map(),saveIntents=new Map(),catalogCache=new Map();
  const enqueue=action=>{const next=operations.then(action);operations=next.catch(()=>{});return next;};
  const load=async owner=>{const rule=await repo.get(ruleId(owner));return rule?{...rule,managed:rule.managed??(rule.scope.skills||[rule.scope.skill]).some(skill=>skill.id!=='meeting-review')}:rule;};
  const connection=rule=>({root:rule.root,token:rule.credentials?secrets.open(rule.id,rule.credentials).token:''});
  async function recordFor(owner,id){const r=await repo.get(id);requireThat(r?.kind==='record'&&r.owner===owner&&!r.deleted&&Date.parse(r.deleteAt)>Date.now(),'git_source_unavailable',410);return r;}
  const retained=(record,owner)=>record?.kind==='record'&&record.owner===owner&&!record.deleted&&Date.parse(record.deleteAt)>Date.now();
  async function sourceFor(owner,id,includeNotes,full=false){
    const access=(await repo.getRecordAccess([id]))[0];requireThat(retained(access,owner),'git_source_unavailable',410);
    const key=`${id}:${includeNotes}`,cached=sourceCache.get(key);
    if(!full&&cached?.version===access.version)return cached;
    const record=await recordFor(owner,id),value={version:access.version,hash:gitSourceHash(record,includeNotes),ready:gitFinal(record),record:{id:record.id,title:record.title,workspaceId:record.workspaceId}};
    sourceCache.set(key,value);if(sourceCache.size>256)sourceCache.delete(sourceCache.keys().next().value);
    return full?{...value,record}:value;
  }
  async function jobFor(owner,id){const job=await repo.get(id);requireThat(job?.kind==='git-sync-job'&&job.owner===owner,'git_task_not_found',404);return job;}
  function conversation(...groups){
    const entries=new Map();for(const item of groups.flat())if(item?.question){const key=JSON.stringify([item.question,item.answer]);if(!entries.has(key))entries.set(key,item);}
    return [...entries.values()];
  }
  async function writeRemote(operation,rule,job,signal,beforeWrite){
    return externalWrite({key:operation,fingerprint:writeFingerprint(job),load:()=>repo.get(job.id),save:(key,state)=>repo.change(job.id,row=>{row.writes||={};row.writes[key]=state;}),guard:()=>guard(job,signal,true),reconcile:()=>operation==='commit'?git.reconcileCommit(connection(rule),job,signal):git.reconcileMerge(connection(rule),job,signal),execute:()=>operation==='commit'?git.commit(connection(rule),job,signal,beforeWrite):git.mergeRequest(connection(rule),job,signal,beforeWrite)});
 }
 async function publicJob(job,detail=false){
  if(detail)job={...job,kernelId:await kernel.adopt('git-sync',job.owner,job.id,[job.recordId])};
    if(!retained((await repo.getRecordAccess([job.recordId]))[0],job.owner))return {id:job.id,recordId:job.recordId,title:'会议已删除或过期',status:'blocked',phase:job.phase,error:'git_source_unavailable',createdAt:job.createdAt,updatedAt:job.updatedAt};
    if(job.agentId&&(detail||['queued','running','waiting'].includes(job.status))){
      const child=await agent.get(job.owner,job.agentId,{summary:!detail});
      const visible=!child.stale&&child.status!=='blocked',running=['queued','running','waiting'].includes(job.status),interaction=visible&&child.status!=='cancelled'&&running&&(child.interaction||(job.interaction?.kind==='continuation'?job.interaction:undefined));
      job={...job,...(job.status==='failed'&&job.error==='agent_failed'&&visible&&child.status==='failed'&&child.error?{error:child.error}:{}),...(detail&&visible?{timeline:child.timeline,ledger:child.ledger,progress:child.progress,activity:child.activity}:{}),...(visible&&running&&job.phase==='organize'&&child.status==='queued'?{status:'queued'}:{}),...(interaction?{status:'waiting',interaction}:{interaction:undefined}),preview:visible?child.preview:undefined,...(detail?{conversation:visible?conversation(job.feedback||[],child.conversation||[]):[]}:{} )};
    }else if(detail)job={...job,conversation:job.feedback||[]};
    if(!['queued','running','waiting'].includes(job.status))job={...job,interaction:undefined};
    if(detail){
      const archived=confirmedArchive(job);let requiresScopeReview=Boolean(job.error&&job.writeStarted&&!archived);
      if(requiresScopeReview){
        const rule=await load(job.owner);
        if(rule?.enabled&&rule.fingerprint===job.policyFingerprint){
          const source=await sourceFor(job.owner,job.recordId,rule.includeNotes),config=await readConfig(repo.root);
          requiresScopeReview=source.hash!==job.sourceHash||modelHash(config)!==job.modelConfigHash||Boolean(job.runtimeConfigHash&&modelConfigFingerprint(config)!==job.runtimeConfigHash);
        }
      }
      job={...job,canRetryWithFeedback:job.status==='failed'&&job.phase==='organize'&&!job.writeStarted&&recoverable(job.error),canRestoreArchive:Boolean(archived),requiresScopeReview};
    }
    return Object.fromEntries(['id','recordId','title','status','phase','error','createdAt','updatedAt','project','basis','minutesRevision','transcriptRevision','branch','baseBranch','directory','mode','commit','url','agentId','automatic','paused','interaction','preview','managed',...(detail?['conversation','timeline','ledger','kernelId','progress','activity','canRetryWithFeedback','canRestoreArchive','requiresScopeReview']:[])].filter(k=>job[k]!==undefined).map(k=>[k,['automatic','paused','managed'].includes(k)?Boolean(job[k]):job[k]]));
  }
  const historyFields=['recordId','status','phase','title','createdAt','updatedAt','ruleGeneration','error','project','basis','minutesRevision','transcriptRevision','branch','baseBranch','directory','mode','commit','url','agentId','automatic','paused','interaction','preview','managed'];
  const history=async owner=>(await repo.listMetadata('git-sync-job',owner,historyFields,{limit:1000})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  async function guard(job,signal,remote=false,ignorePause=false,full=false){
    signal?.throwIfAborted();const rule=await load(job.owner);
    requireThat(rule?.enabled&&rule.generation===(job.authorizationGeneration||job.ruleGeneration),'git_rule_changed',409);
    const current=await repo.get(job.id);requireThat(ignorePause||!current.paused,'git_paused',409);
    const source=await sourceFor(job.owner,job.recordId,rule.includeNotes,full),record=source.record;
    requireThat(source.ready&&source.hash===job.sourceHash,'git_source_changed',409);
    if(job.modelConfigHash){const config=await readConfig(repo.root);requireThat(modelHash(config)===job.modelConfigHash&&(!job.runtimeConfigHash||modelConfigFingerprint(config)===job.runtimeConfigHash),'git_model_changed',409);}
    await extensions.validate(job.owner,rule.scope);
    if(remote){const catalog=await git.catalog(connection(rule),signal),match=gitTarget(record,catalog.projects,rule.mappings,rule.aliases);requireThat(catalog.group.id===job.rootGroup.id&&match.status==='eligible'&&match.project.id===job.project.id&&match.project.default_branch===job.baseBranch,'git_target_changed',409);}
    return {rule,record};
  }
  async function update(id,values){const current=await repo.get(id);if(Object.entries(values).every(([key,value])=>JSON.stringify(current[key])===JSON.stringify(value)))return current;return repo.change(id,row=>{const unavailable=row.error==='git_source_unavailable'||values.error==='git_source_unavailable';Object.assign(row,values,{...(row.paused&&values.paused!==false&&['running','queued','waiting'].includes(values.status)?{status:'paused'}:{}),updatedAt:now()});if(unavailable)Object.assign(row,{status:'blocked',error:'git_source_unavailable',files:null,original:null,title:'',feedback:null,interaction:null,preview:null});return structuredClone(row);});}
  const phases=['resolve','prepare','organize','commit','merge'];
  function phaseHandler(phase){return async(task,runtime,taskContext)=>{
    let job=await repo.get(task.input.jobId);
    try{
      requireThat(job&&(!job.taskId||job.taskId===runtime.taskId),'git_task_replaced',409);
      await guard(job,runtime.signal,['commit','merge'].includes(phase));
      job=await update(job.id,{status:phase==='organize'&&job.status==='waiting'?'waiting':'running',phase,error:null,taskId:runtime.taskId});
      if(phase==='resolve'){
        const {rule,record}=await guard(job,runtime.signal),catalog=await git.catalog(connection(rule),runtime.signal),target=gitTarget(record,catalog.projects,rule.mappings,rule.aliases);
        requireThat(catalog.group.id===job.rootGroup.id,'git_target_changed',409);requireThat(target.status==='eligible',target.reason||'git_target_unclear',409);
        job=await update(job.id,{project:target.project,basis:target.basis,baseBranch:target.project.default_branch,branch:rule.mode==='mr'?`lingji/archive-${record.id}-${job.archiveKey.slice(0,12)}`:target.project.default_branch,mode:rule.mode,directory:rule.directory});
      }else if(phase==='prepare'){
        const {rule,record}=await guard(job,runtime.signal,false,false,true);
        const date=new Intl.DateTimeFormat('en-CA',{timeZone:rule.timezone||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(record.createdAt)),path=`${rule.directory}/${date}-${record.id}-v${job.minutesRevision}-${job.archiveKey.slice(0,8)}`;
        job=await update(job.id,{original:exportMinutesMarkdown(record,{includeNotes:rule.includeNotes,includeEvidence:rule.includeEvidence}),filePath:`${path}.md`,manifestPath:`${path}.source.json`});
      }else if(phase==='organize'){
        const {rule}=await guard(job,runtime.signal);
        if(!job.modelConfigHash){const config=await readConfig(repo.root);job=await update(job.id,{modelConfigHash:modelHash(config),model:config.LLM_MODEL||'injected-test-model'});}
        const child=job.agentId?await agent.get(job.owner,job.agentId):await agent.request(job.owner,{recordIds:[job.recordId],prompt:rule.prompt,requestId:`git-sync:${digest(`${job.id}:${job.agentAttempt||0}`)}`,scopeConfirmed:true,minutesOnly:true,includeNotes:rule.includeNotes,skillId:rule.scope.skill.id,skillVersion:rule.scope.skill.version,skillIds:(rule.scope.skills||[rule.scope.skill]).map(s=>s.id),skillVersions:Object.fromEntries((rule.scope.skills||[rule.scope.skill]).map(s=>[s.id,s.version])),pluginIds:rule.scope.plugins.map(p=>p.id),pluginVersions:Object.fromEntries(rule.scope.plugins.map(p=>[p.id,p.version])),remoteToolsConfirmed:true},{jobId:job.id,managed:job.managed===true,root:rule.root,project:{id:job.project.id,path:job.project.path,defaultBranch:job.baseBranch},mode:rule.mode||null,directory:rule.directory||null,pendingArchive:Boolean(job.files),feedback:job.feedback||[],instruction:job.managed?'The user requirements and selected meeting/repository scope are immutable. Follow the selected Skills to choose the process, archive directory and write mode where not specified. Ask the user when necessary. Use manage_git_sync to archive before completing.':'Organize the meeting according to the selected guidance; the application will perform the archive.'});
        if(!job.agentId)job=await update(job.id,{agentId:child.id});
        if(['queued','running','cancelling'].includes(child.status)){await update(job.id,{status:child.interaction?'waiting':'running'});await runtime.sleepUntil(Date.now()+agentPollMs,{phase},taskContext);return;}
        const archived=await repo.get(job.id);if(job.managed&&archived.commit&&archived.url&&(archived.mode!=='mr'||archived.iid||archived.integrated)){await update(job.id,{status:'succeeded',phase:'done',error:null});await runtime.commit(()=>terminal({status:'completed',result:{jobId:job.id}}),taskContext);return;}
        requireThat(child.status==='completed'&&!child.stale&&child.result,child.error||'git_agent_failed',502);
        if(job.managed){
          job=await repo.get(job.id);
          if(!(job.commit&&job.url&&(job.mode!=='mr'||job.iid||job.integrated))){
          requireThat(!job.writeStarted,'git_result_unknown',409);
            if(!job.interaction)await update(job.id,{status:'waiting',error:null,interaction:{kind:'continuation',id:`continue:${child.id}`,question:`${child.result.summary}\n\n尚未收到可核对的仓库结果。请补充说明，继续核对并完成同一会议与项目的同步。`,options:['继续核对并完成同步']}});
            await runtime.sleepUntil(Date.now()+agentPollMs,{phase},taskContext);return;
          }
          await update(job.id,{status:'succeeded',phase:'done',error:null});await runtime.commit(()=>terminal({status:'completed',result:{jobId:job.id}}),taskContext);return;
        }
        const cite=item=>(item.evidence||[]).map(e=>`${e.segmentId}@${e.revision}`).join(', ');
        const lines=['','## 归档整理','',inline(child.result.summary),''];
        for(const [name,items] of [['决策',child.result.decisions],['行动候选（待确认）',child.result.actions]]){lines.push(`### ${name}`,'');for(const item of items)lines.push(`- ${inline(item.text)}${rule.includeEvidence?`（引用：${inline(cite(item))}）`:''}`);lines.push('');}
        const {record}=await guard(job,runtime.signal,false,false,true);
        const manifest={recordId:job.recordId,minutesRevision:job.minutesRevision,transcriptRevision:job.transcriptRevision,sourceHash:job.sourceHash,archiveKey:job.archiveKey,policyHash:job.policyFingerprint,timezone:rule.timezone||'UTC',citations:gitCitations(record.minutes),ruleGeneration:job.ruleGeneration,promptHash:digest(rule.prompt),skill:{id:rule.scope.skill.id,version:rule.scope.skill.version},skills:(rule.scope.skills||[rule.scope.skill]).map(({id,name,version})=>({id,name,version})),skillFiles:(rule.scope.guides||[]).map(({key,name,path,version})=>({key,name,path,version})),plugins:rule.scope.plugins.map(p=>({id:p.id,version:p.version,tools:p.tools.map(t=>t.name)})),model:job.model,reasoningEffort:job.reasoningEffort,modelConfigHash:job.modelConfigHash,agentId:child.id,projectId:job.project.id,rootGroupId:job.rootGroup.id};
        const files={[job.filePath]:job.original+lines.join('\n'),[job.manifestPath]:JSON.stringify(manifest,null,2)+'\n'};
        requireThat(Buffer.byteLength(JSON.stringify(files))<=160000,'git_archive_too_large',413);
        job=await update(job.id,{files});
      }else if(phase==='commit'){
        const {rule}=await guard(job,runtime.signal,true);
        const beforeWrite=async()=>{await guard(job,runtime.signal,true);job=await update(job.id,{writeStarted:true});await guard(job,runtime.signal);};
        const result=await writeRemote('commit',rule,job,runtime.signal,beforeWrite);await update(job.id,{...result,url:`${gitRoot(rule.root).origin}/${job.project.path}/-/commit/${result.commit}`});
      }else{
        const {rule}=await guard(job,runtime.signal,true);
        const beforeWrite=async()=>{await guard(job,runtime.signal,true);job=await update(job.id,{writeStarted:true});await guard(job,runtime.signal);};
        const result=job.mode==='mr'&&!job.integrated?await writeRemote('merge',rule,job,runtime.signal,beforeWrite):{url:`${gitRoot(rule.root).origin}/${job.project.path}/-/commit/${job.commit}`};
        await update(job.id,{...result,status:'succeeded',phase:'done',error:null});
        await runtime.commit(()=>terminal({status:'completed',result:{jobId:job.id}}),taskContext);return;
      }
      await guard(job,runtime.signal);
      await runtime.commit(()=>({status:'running',checkpoint:{phase:phases[phases.indexOf(phase)+1]}}),taskContext);
    }catch(error){
      if(closing||runtime.signal.aborted)throw error;
      if(error.code==='git_rate_limited'&&(job.rateAttempts||0)<3){const attempt=(job.rateAttempts||0)+1;await update(job.id,{status:'queued',error:'git_rate_limited',rateAttempts:attempt});await runtime.sleepUntil(Date.now()+retryDelayMs*2**(attempt-1),{phase},taskContext);return;}
      const code=safeCode(error),blocked=['git_rule_changed','git_source_changed','git_model_changed','git_source_unavailable','git_target_unclear','git_target_changed','git_target_unavailable','git_default_branch_missing','git_repository_empty','git_target_conflict','git_archive_exists','extension_version_changed','extension_disabled'].includes(code);
      if(code!=='git_paused'){
        if(job.agentId)await agent.cancel(job.owner,job.agentId).catch(()=>{});
        await update(job.id,{status:['git_result_unknown','external_write_unknown'].includes(code)?'unknown':blocked?'blocked':'failed',error:code});
      }
      await runtime.commit(()=>terminal({status:'failed',error:{message:code}}),taskContext);
    }
  };}
  const Job=defineTask({name:'git-sync@1',version:1,initial:input=>({phase:input.phase||'resolve'}),phases:Object.fromEntries(phases.map(p=>[p,phaseHandler(p)])),abort:async(_task,runtime,taskContext)=>runtime.commit(()=>terminal({status:'aborted',result:{}}),taskContext)});
  async function stopActiveChild(job){
    if(!job.agentId)return;
    const child=await agent.get(job.owner,job.agentId);
    if(['queued','running','cancelling'].includes(child.status)&&!child.interaction)await agent.cancel(job.owner,job.agentId);
  }
  async function schedule(job){
    const id=await root.commit(async tx=>{const index=await tx.doc(Index),previous=index.jobs.filter(j=>j.jobId===job.id).at(-1);if(previous&&(await tx.task(previous.taskId))?.state.status!=='terminal')return previous.taskId;const taskId=await tx.createTask(Job,{jobId:job.id,phase:phases.includes(job.phase)?job.phase:'resolve'},{ownership:{kind:'conversation'}});index.jobs.push({jobId:job.id,taskId});return taskId;},context);
    await update(job.id,{taskId:id});harness.resume();
  }
  async function check(owner,input){
    const rootValue=gitRoot(input.root).url,current=await load(owner);
    const token=input.token||(current?.root===rootValue?connection(current).token:'');
    requireThat(typeof token==='string'&&token.length<=16000&&!/[^\x21-\x7e]/.test(token),'invalid_git_sync',400);
    const catalog=await git.catalog({root:rootValue,token});catalogCache.set(owner,{key:digest(rootValue+':'+token),at:Date.now(),catalog});if(catalogCache.size>32)catalogCache.delete(catalogCache.keys().next().value);return catalog;
  }
  async function save(owner,input,intent){
    requireThat(typeof input.enabled==='boolean','invalid_git_sync',400);let current=await load(owner);
    if(!input.enabled&&current?.enabled){await enqueue(async()=>{requireThat(saveIntents.get(owner)===intent,'git_rule_changed',409);await repo.change(current.id,row=>{row.enabled=false;row.generation=randomUUID();});});current=await load(owner);}
    if(!input.enabled&&input.root===undefined&&input.prompt===undefined)return enqueue(async()=>{requireThat(saveIntents.get(owner)===intent,'git_rule_changed',409);const latest=await load(owner);if(latest)await repo.change(latest.id,r=>{r.enabled=false;r.generation=randomUUID();});return publicRule(await load(owner));});
    requireThat((!input.enabled||input.confirmed===true)&&typeof input.prompt==='string'&&input.prompt.trim().length>=1&&input.prompt.length<=2000&&typeof input.includeNotes==='boolean'&&typeof input.includeEvidence==='boolean'&&['','mr','direct'].includes(input.mode||''),'git_confirmation_required',400);
    requireThat(!input.enabled||input.mode!=='direct'||input.directConfirmed===true,'git_direct_confirmation_required',400);
    const timezone=input.timezone||'UTC';requireThat(typeof timezone==='string'&&timezone.length<=100,'git_timezone_invalid',400);try{new Intl.DateTimeFormat('en-CA',{timeZone:timezone});}catch{throw new DomainError('git_timezone_invalid',400);}
    const rootValue=gitRoot(input.root).url,token=input.token||(current?.root===rootValue?connection(current).token:'');
    requireThat(typeof token==='string'&&token.length<=16000&&!/[^\x21-\x7e]/.test(token),'invalid_git_sync',400);
    const recent=catalogCache.get(owner),sameConnection=current?.root===rootValue&&connection(current).token===token;
    const catalog=recent?.key===digest(rootValue+':'+token)&&(sameConnection||Date.now()-recent.at<30000)?recent.catalog:sameConnection?{group:current.group,projects:current.projects}:await check(owner,input);
    const {group,projects}=catalog,scope=await extensions.snapshot(owner,input.enabled?input:{...input,remoteToolsConfirmed:true}); // Disabled drafts store selections only; enabling rechecks explicit tool consent.
    const managed=scope.skills.some(skill=>skill.id!=='meeting-review');requireThat(managed||input.mode,'git_write_mode_required',400);
    requireThat(Array.isArray(input.mappings)&&input.mappings.length<=50&&Array.isArray(input.aliases)&&input.aliases.length<=100,'invalid_git_sync',400);
    for(const mapping of input.mappings){const workspace=await repo.get(mapping.workspaceId);requireThat(workspace?.kind==='workspace'&&workspace.owner===owner&&projects.some(p=>p.id===mapping.projectId),'git_mapping_invalid',400);}
    requireThat(new Set(input.mappings.map(m=>m.workspaceId)).size===input.mappings.length,'git_mapping_duplicate',400);
    requireThat(input.aliases.every(a=>typeof a.name==='string'&&a.name.trim().length>=3&&a.name.length<=100&&projects.some(p=>p.id===a.projectId)),'git_alias_invalid',400);
    let directory;try{directory=managed&&!input.directory?.trim()?'':gitArchivePath(typeof input.directory==='string'&&input.directory.trim()?input.directory.trim():'docs/meetings');}catch{throw new DomainError('git_directory_invalid',400);}
    const policy={root:rootValue,group,projects,timezone,prompt:input.prompt.trim(),scope,mappings:input.mappings.map(({workspaceId,projectId})=>({workspaceId,projectId})),aliases:input.aliases.map(({name,projectId})=>({name:name.trim(),projectId})),directory,mode:input.mode||'',managed,includeNotes:input.includeNotes,includeEvidence:input.includeEvidence};
    const fingerprint=digest(JSON.stringify({...policy,projects:undefined})),unchanged=current?.enabled&&current.fingerprint===fingerprint&&connection(current).token===token;
    const next={id:ruleId(owner),kind:'git-sync-rule',owner,...policy,fingerprint,enabled:input.enabled,generation:unchanged?current.generation:randomUUID(),enabledAt:unchanged?current.enabledAt:Date.now(),excluded:unchanged?current.excluded:(await repo.listSummaries(owner,'all','')).filter(r=>r.capture==='completed').map(r=>r.id),credentials:token?secrets.seal(ruleId(owner),{token}):null};
    return enqueue(async()=>{
      const latest=await load(owner);
      await extensions.validate(owner,scope);
      requireThat(!closing&&saveIntents.get(owner)===intent&&latest?.generation===current?.generation,'git_rule_changed',409);
      if(current)await repo.change(current.id,r=>Object.assign(r,next));else await repo.insert(next);return publicRule(next);
    });
  }
  async function preview(owner,input){const rule=input?.root?input:await load(owner);requireThat(rule,'git_not_configured',409);requireThat(Array.isArray(rule.mappings)&&rule.mappings.length<=50&&Array.isArray(rule.aliases)&&rule.aliases.length<=100&&rule.aliases.every(a=>typeof a.name==='string'&&a.name.length<=100),'invalid_git_sync',400);const {projects,group}=input?.root?await check(owner,input):await git.catalog(connection(rule));const results=[];for(const summary of await repo.listSummaries(owner,'all','')){const r=await recordFor(owner,summary.id),target=gitTarget(r,projects,rule.mappings,rule.aliases);results.push({recordId:r.id,title:r.title,workspaceId:r.workspaceId,...target});}return {results,projects,group};}
  async function start(owner,recordId,automatic=false){
    const rule=await load(owner);requireThat(rule?.enabled,'git_not_configured',409);const record=await recordFor(owner,recordId);requireThat(gitFinal(record),'git_minutes_not_ready',409);
    const config=await readConfig(repo.root),configHash=modelHash(config),sourceHash=gitSourceHash(record,rule.includeNotes),archiveKey=digest(JSON.stringify([sourceHash,rule.fingerprint,configHash])),key=digest(`${owner}:${record.id}:${archiveKey}`),id=`git-sync:${key}`;
    const existing=await repo.get(id);if(existing){
      if(existing.status!=='superseded')return publicJob(existing,true);
      requireThat(!existing.writeStarted,'git_result_unknown',409);
      const revived=await update(id,{status:'queued',paused:false,phase:'resolve',error:null,authorizationGeneration:rule.generation,runtimeConfigHash:modelConfigFingerprint(config),agentId:null,agentAttempt:(existing.agentAttempt||0)+1,rateAttempts:0,startedAt:now()});
      await guard(revived);await schedule(revived);return publicJob(await repo.get(id),true);
    }
    const row={id,kind:'git-sync-job',owner,recordId,title:record.title,sourceHash,archiveKey,ruleGeneration:rule.generation,policyFingerprint:rule.fingerprint,modelConfigHash:configHash,runtimeConfigHash:modelConfigFingerprint(config),model:config.LLM_MODEL||'injected-test-model',reasoningEffort:config.LLM_REASONING_EFFORT||'',rootGroup:rule.group,minutesRevision:record.minutesRevision,transcriptRevision:record.transcriptRevision,automatic,managed:rule.managed===true,phase:'resolve',status:'queued',createdAt:now(),updatedAt:now(),startedAt:now()};
    await repo.insert(row);await kernel.adopt('git-sync',owner,id,[recordId]);if(row.status==='queued'){try{await schedule(row);}catch(error){await update(id,{status:'failed',error:safeCode(error)});}}return publicJob(await repo.get(id),true);
  }
  async function tick(){
    if(busy||closing)return;busy=true;
    try{for(const rule of await repo.list('git-sync-rule')){
      const rows=await history(rule.owner);
      // Retention must cover all jobs, independently of the recent history shown in the UI.
      let before;
      for(;;){
        const batch=await repo.listMetadata('git-sync-job',rule.owner,['recordId','createdAt','error'],{limit:1000,before});
        const access=new Map((await repo.getRecordAccess([...new Set(batch.map(row=>row.recordId))])).map(r=>[r.id,r]));
        for(const item of batch)if(!retained(access.get(item.recordId),rule.owner)&&item.error!=='git_source_unavailable'){await update(item.id,{status:'blocked',error:'git_source_unavailable',files:null,original:null,title:'',feedback:null,interaction:null,preview:null});sourceCache.delete(`${item.recordId}:true`);sourceCache.delete(`${item.recordId}:false`);}
        if(batch.length<1000)break;const last=batch.at(-1);before=[last.createdAt,last.id];
      }
      if(!rule.enabled||rows.some(r=>['queued','running','waiting'].includes(r.status)))continue;
      for(const summary of await repo.listSummaries(rule.owner,'all','')){
        if(summary.capture!=='completed'||!summary.hasMinutes||rule.excluded.includes(summary.id)||rows.some(r=>r.ruleGeneration===rule.generation&&r.recordId===summary.id))continue;
        const record=await recordFor(rule.owner,summary.id);if(!gitFinal(record))continue;
        try{await start(rule.owner,summary.id,true);}catch(error){
          const id=`git-sync:${digest(`${rule.owner}:${rule.generation}:${summary.id}:${gitSourceHash(record,rule.includeNotes)}`)}`;
          if(!await repo.get(id))await repo.insert({id,kind:'git-sync-job',owner:rule.owner,recordId:summary.id,title:record.title,ruleGeneration:rule.generation,sourceHash:gitSourceHash(record,rule.includeNotes),phase:'prepare',status:'failed',error:safeCode(error),createdAt:now(),updatedAt:now(),automatic:true});
        }break;
      }
    }}finally{busy=false;}
  }
  try{
    const registry=createRegistry();registry.install(defineExtension({name:'git-sync@1',tasks:[Job]}));
    harness=await openMeetingHarness(repo,await openNodeSqliteStorage(join(repo.root,'git-sync.sqlite')),{models:createModels(),registry,settings:{compaction:{enabled:false}}},context);root=await harness.root(context);
    for(const rule of await repo.list('git-sync-rule'))for(const row of await history(rule.owner)){const job=await repo.get(row.id);if(['queued','running','waiting'].includes(job.status)&&!job.taskId)await schedule(job);}
    agent.setGitSyncHandler?.(async(owner,id,args,signal)=>{
      let job=await jobFor(owner,id);const {rule}=await guard(job,signal,!['read_file','list_files'].includes(args.action),false,!['read_file','list_files'].includes(args.action));
      requireThat(job.managed&&rule.managed,'agent_scope_denied',403);
      if(args.action==='list_files'){const path=args.path?gitArchivePath(args.path):'';return git.listFiles(connection(rule),job,path,args.page||0,signal);}
      if(args.action==='read_file'){
        const path=gitArchivePath(args.path);return git.readFile(connection(rule),job,path,signal);
      }
      if(args.action==='archive'){
      requireThat(args.files===undefined||Array.isArray(args.files)&&args.files.length>0&&args.files.length<=20,'invalid_git_sync',400);
      const mode=rule.mode||args.mode,directory=rule.directory||(args.directory==='.'?'':gitArchivePath(args.directory||'docs/meetings'));
      requireThat(['mr','direct'].includes(mode)&&(!rule.mode||!args.mode||rule.mode===args.mode)&&(!rule.directory||!args.directory||rule.directory===args.directory),'git_scope_changed',409);
      const stem=job.filePath.slice(job.filePath.lastIndexOf('/')+1),prefix=directory?`${directory}/`:'';
      const proposed=args.files||[{path:args.path||stem,content:args.content}];
      requireThat(proposed.every(file=>typeof file.content==='string'&&file.content.trim()&&file.content.length<=100000),'invalid_git_sync',400);
      const paths=proposed.map(file=>prefix+gitArchivePath(file.path));requireThat(new Set(paths).size===paths.length,'invalid_git_sync',400);
      const filePath=paths[0],manifestPath=`${prefix}${stem.replace(/\.md$/,'.source.json')}`;requireThat(!paths.includes(manifestPath),'invalid_git_sync',400);
      const files=Object.fromEntries(proposed.map((file,index)=>[paths[index],file.content+'\n']));
      files[manifestPath]=JSON.stringify({recordId:job.recordId,minutesRevision:job.minutesRevision,transcriptRevision:job.transcriptRevision,sourceHash:job.sourceHash,archiveKey:job.archiveKey,skills:rule.scope.skills.map(({id,version})=>({id,version})),skillFiles:(rule.scope.guides||[]).map(({key,name,path,version})=>({key,name,path,version})),citations:gitCitations((await recordFor(owner,job.recordId)).minutes),originalMarkdown:job.original},null,2)+'\n';
      requireThat((args.commitMessage===undefined||typeof args.commitMessage==='string'&&args.commitMessage.trim().length>0&&args.commitMessage.length<=500)&&(args.title===undefined||typeof args.title==='string'&&args.title.trim().length>0&&args.title.length<=200),'invalid_git_sync',400);
      requireThat(Buffer.byteLength(JSON.stringify(files))<=160000,'git_archive_too_large',413);
      if(job.files)requireThat(JSON.stringify(job.files)===JSON.stringify(files)&&job.mode===mode,'git_write_conflict',409);
      job=await update(id,{files,filePath,manifestPath,mode,directory,commitMessage:args.commitMessage||job.commitMessage||`docs: ${job.recordId}`,mergeTitle:args.title||job.mergeTitle||`会议归档：${job.title}`.slice(0,200),branch:mode==='mr'?`lingji/archive-${job.recordId}-${job.archiveKey.slice(0,12)}`:job.baseBranch});
      }else requireThat(args.action==='reconcile'&&job.files&&job.mode,'git_agent_archive_required',409);
      try{
      const beforeWrite=async()=>{await guard(job,signal,true);job=await update(id,{writeStarted:true});await guard(job,signal);};
      const result=await writeRemote('commit',rule,job,signal,beforeWrite);job=await update(id,{...result,url:`${gitRoot(rule.root).origin}/${job.project.path}/-/commit/${result.commit}`});
      const merged=job.mode==='mr'&&!job.integrated?await writeRemote('merge',rule,job,signal,beforeWrite):{url:job.url};
      job=await update(id,{...merged,remoteError:null});return {commit:job.commit,url:job.url,mode:job.mode,filePath:job.filePath};
      }catch(error){await update(id,{remoteError:safeCode(error)});throw error;}
    });
    for(const rule of await repo.list('git-sync-rule'))for(const job of await history(rule.owner))if(job.paused||job.status==='paused')await stopActiveChild(job);
  harness.resume();timer=setInterval(()=>void enqueue(tick).catch(()=>{}),Math.max(50,pollMs));timer.unref();
    const service={
    check,save:(owner,input)=>{const intent={};saveIntents.set(owner,intent);return save(owner,input,intent).finally(()=>{if(saveIntents.get(owner)===intent)saveIntents.delete(owner);});},preview,start:(owner,id)=>enqueue(()=>start(owner,id)),tick:()=>enqueue(tick),
      async status(owner){return {enabled:Boolean((await load(owner))?.enabled),recent:await Promise.all((await history(owner)).slice(0,20).map(job=>publicJob(job)))};},
      historyPage:(owner,query)=>taskHistoryPage({repo,kind:'git-sync-job',owner,fields:historyFields,query,map:job=>publicJob(job)}),
      async settings(owner){
return {...publicRule(await load(owner)),recent:await Promise.all((await history(owner)).slice(0,20).map(job=>publicJob(job)))};},
      get:async(owner,id)=>publicJob(await jobFor(owner,id),true),
    respond:async(owner,id,input)=>{let job=await jobFor(owner,id);const config=await readConfig(repo.root);
      if(!job.writeStarted&&job.runtimeConfigHash&&modelHash(config)===job.modelConfigHash&&job.runtimeConfigHash!==modelConfigFingerprint(config))job=await update(id,{runtimeConfigHash:modelConfigFingerprint(config)});
      await guard(job);requireThat(job.agentId,'agent_input_changed',409);
      if(job.interaction?.kind==='continuation'){
        requireThat(input?.id===job.interaction.id&&typeof input.answer==='string'&&input.answer.trim()&&input.answer.length<=4000,'agent_input_changed',409);
        await repo.change(id,current=>{
          requireThat(current.status==='waiting'&&current.interaction?.id===input.id,'agent_input_changed',409);
          const feedback=[...(current.feedback||[]),{question:current.interaction.question,answer:input.answer.trim()}];
          requireThat(JSON.stringify(feedback).length<=60000,'agent_input_too_large',413);
          Object.assign(current,{feedback,agentAttempt:(current.agentAttempt||0)+1,agentId:null,interaction:null,status:'running',updatedAt:new Date().toISOString()});
        });
      }else {
        requireThat(typeof input?.id==='string'&&typeof input.answer==='string'&&input.answer.trim()&&input.answer.length<=4000,'invalid_agent_request',400);
        const child=await agent.get(owner,job.agentId),question=child.interaction;
        requireThat(question?.id===input?.id,'agent_input_changed',409);
        const feedback=conversation(job.feedback||[],(child.conversation||[]).filter(item=>item.answer!==undefined),[{question:question.question,answer:input.answer?.trim()}]);
        requireThat(JSON.stringify(feedback).length<=60000,'agent_input_too_large',413);
        if(!job.writeStarted&&await agent.configurationMatches?.(owner,job.agentId)===false){
          // Keep the answer before replacing the old configured model; never wake it with a stale key.
          job=await update(id,{paused:true,status:'paused',feedback});
          if(job.taskId){await harness.abortTask(job.taskId,context);await harness.waitForTask(job.taskId,context);}
          await agent.cancel(owner,job.agentId);
          job=await update(id,{paused:false,status:'queued',runtimeConfigHash:modelConfigFingerprint(config),agentId:null,agentAttempt:(job.agentAttempt||0)+1,interaction:null,phase:'organize',files:null});
          await schedule(job);
        }else{await agent.respond(owner,job.agentId,input);await update(id,{feedback});}
      }
      return publicJob(await repo.get(id),true);},
      control:(owner,id,action,input={})=>enqueue(async()=>{
        let job=await jobFor(owner,id);requireThat(input?.answer===undefined||(typeof input.answer==='string'&&input.answer.trim()&&input.answer.length<=4000),'invalid_agent_request',400);const clarification=input?.answer?.trim();if(job.status==='succeeded'){requireThat(!clarification,'agent_input_changed',409);return publicJob(job);}
        requireThat(['pause','resume','retry'].includes(action),'invalid_git_sync',400);
        if(action==='pause'){
        job=await update(id,{paused:true,status:'paused'});
        // The durable pause fence blocks new writes even if a transport is slow to cancel.
        if(job.taskId)void harness.abortTask(job.taskId,context).catch(()=>{});
        await stopActiveChild(job);
        job=await update(id,{paused:true,status:'paused'});
        }else{
          if(job.taskId){await harness.abortTask(job.taskId,context);await harness.waitForTask(job.taskId,context);}
          job=await jobFor(owner,id);
          const completed=action==='retry'&&!clarification&&confirmedArchive(job);
          if(completed){
            await recordFor(owner,job.recordId);
            if(job.agentId){const child=await agent.get(owner,job.agentId);if(['queued','running','cancelling'].includes(child.status))await agent.cancel(owner,job.agentId);}
            // Restore the journal's historical success; never authorize another write with new settings.
            return publicJob(await update(id,{...completed,status:'succeeded',phase:'done',error:null,paused:false}),true);
          }
          const config=await readConfig(repo.root);
          const rule=await load(owner),record=await recordFor(owner,job.recordId),sameSource=rule&&gitSourceHash(record,rule.includeNotes)===job.sourceHash,sameModel=modelHash(config)===job.modelConfigHash;
          if(clarification){requireThat(action==='retry'&&job.status==='failed'&&job.phase==='organize'&&!job.writeStarted,'agent_input_changed',409);requireThat(sameSource,'git_source_changed',409);requireThat(sameModel,'git_model_changed',409);requireThat(rule?.fingerprint===job.policyFingerprint,'git_rule_changed',409);}
        if(['retry','resume'].includes(action)&&rule?.enabled&&sameSource&&sameModel&&rule.fingerprint===job.policyFingerprint&&rule.generation!==(job.authorizationGeneration||job.ruleGeneration))job=await update(id,{authorizationGeneration:rule.generation,reauthorizedAt:now()});
          if(['retry','resume'].includes(action)&&!job.writeStarted&&rule?.enabled&&((job.authorizationGeneration||job.ruleGeneration)!==rule.generation||!sameSource||!sameModel)){await update(id,{status:'superseded',error:null,files:null,original:null});return start(owner,job.recordId);}
          const previousChild=job.agentId?await agent.get(owner,job.agentId):null;
          const runtimeChanged=job.runtimeConfigHash?job.runtimeConfigHash!==modelConfigFingerprint(config):previousChild&&await agent.configurationMatches?.(owner,job.agentId)===false;
          const refreshNeeded=runtimeChanged||previousChild?.error==='agent_model_changed';
          if(refreshNeeded&&!job.writeStarted){
            if(previousChild?.interaction||job.interaction?.kind==='continuation'){job=await update(id,{runtimeConfigHash:modelConfigFingerprint(config)});}
            else{await stopActiveChild(job);
            job=await update(id,{runtimeConfigHash:modelConfigFingerprint(config),agentId:null,agentAttempt:(job.agentAttempt||0)+1,phase:job.project?'organize':'resolve',files:null,feedback:conversation(job.feedback||[],(previousChild?.conversation||[]).filter(item=>item.answer!==undefined))});}
          }
          await guard(job,undefined,false,true);

          const child=job.agentId?await agent.get(owner,job.agentId):null;
        if(clarification)requireThat(recoverable(child?.error||job.error),'agent_input_changed',409);
        const feedback=conversation(job.feedback||[],(child?.conversation||[]).filter(item=>item.answer!==undefined),clarification?[{question:'同步中断后的补充说明',answer:clarification}]:[]);requireThat(JSON.stringify(feedback).length<=60000,'agent_input_too_large',413);
          job=await update(id,{paused:false,status:'queued',phase:job.project?job.phase:'resolve',error:null,rateAttempts:0,startedAt:now(),...(child&&(['failed','blocked','cancelled'].includes(child.status)||job.managed&&job.error&&child.status==='completed')?{agentId:null,agentAttempt:(job.agentAttempt||0)+1,feedback}:{})});await schedule(job);
        }return publicJob(await repo.get(id),true);
      }),
      async close(){closing=true;clearInterval(timer);await operations;await harness.close(context);lock.close();}
  };
  const unregister=kernel.register('git-sync',{validate:(_owner,input)=>{requireThat(input?.confirmed===true,'git_confirmation_required',400);},sources:(_owner,input)=>[input.recordId],submit:(owner,input)=>service.start(owner,input.recordId),inspect:(owner,id)=>service.get(owner,id),cancel:(owner,id)=>service.cancel(owner,id)});
  service.cancel=async(owner,id)=>{const current=await jobFor(owner,id);if(['succeeded','cancelled'].includes(current.status))return publicJob(current,true);await service.control(owner,id,'pause');if(current.agentId)await agent.cancel(owner,current.agentId).catch(()=>{});return enqueue(async()=>publicJob(await update(id,{paused:true,status:'cancelled'}),true));};
  const close=service.close;service.close=async()=>{unregister();await close();};
  return service;
 }catch(error){clearInterval(timer);await harness?.close(context);lock.close();throw error;}
}
