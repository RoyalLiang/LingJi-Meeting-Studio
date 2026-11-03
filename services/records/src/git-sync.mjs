import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {createModels} from '@earendil-works/pi-ai/models';
import {Harness,defineDoc,defineTask,defineExtension,createRegistry} from '@earendil-works/pi-durable';
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
const safeCode=error=>/^(?:git_[a-z_]+|remote_[a-z_]+|minutes_not_configured|extension_[a-z_]+|mcp_[a-z_]+|agent_[a-z_]+)$/.test(error?.code||'')?error.code:'git_sync_failed';
const inline=value=>String(value).replace(/[<>]/g,c=>c==='<'?'&lt;':'&gt;').replace(/([\\`*_{}[\]#|])/g,'\\$1');
const modelHash=config=>digest(JSON.stringify([config.LLM_MODEL||'',config.LLM_API_URL||'',config.LLM_PROTOCOL||'',config.LLM_REASONING_EFFORT||'']));
const publicRule=rule=>rule?{configured:true,enabled:rule.enabled,root:rule.root,group:rule.group,projects:rule.projects,prompt:rule.prompt,skillId:rule.scope.skill.id,skillVersion:rule.scope.skill.version,skillIds:(rule.scope.skills||[rule.scope.skill]).map(s=>s.id),skillVersions:Object.fromEntries((rule.scope.skills||[rule.scope.skill]).map(s=>[s.id,s.version])),pluginIds:rule.scope.plugins.map(p=>p.id),pluginVersions:Object.fromEntries(rule.scope.plugins.map(p=>[p.id,p.version])),mappings:rule.mappings,aliases:rule.aliases,directory:rule.directory,mode:rule.mode,timezone:rule.timezone,includeNotes:rule.includeNotes,includeEvidence:rule.includeEvidence,hasToken:Boolean(rule.credentials),generation:rule.generation}:{configured:false,enabled:false};

export async function createGitSync({repo,agent,extensions,localAccount=false,request,pollMs=30000,agentPollMs=1000,retryDelayMs=30000}={}){
  const secrets=await createSecretStore(repo.root),git=createGitlab({request,localAccount});
  const lock=new DatabaseSync(join(repo.root,'git-sync-lock.sqlite'));
  try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_lock(v INTEGER)');}catch{lock.close();throw new DomainError('git_sync_busy',503);}
  let harness,root,timer,closing=false,busy=false,operations=Promise.resolve();const sourceCache=new Map(),saveIntents=new Map(),catalogCache=new Map();
  const enqueue=action=>{const next=operations.then(action);operations=next.catch(()=>{});return next;};
  const load=owner=>repo.get(ruleId(owner));
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
  async function publicJob(job){
    if(!retained((await repo.getRecordAccess([job.recordId]))[0],job.owner))return {id:job.id,recordId:job.recordId,title:'会议已删除或过期',status:'blocked',phase:job.phase,error:'git_source_unavailable',createdAt:job.createdAt,updatedAt:job.updatedAt};
    return Object.fromEntries(['id','recordId','title','status','phase','error','createdAt','updatedAt','project','basis','minutesRevision','transcriptRevision','branch','baseBranch','directory','mode','commit','url','agentId','automatic','paused'].filter(k=>job[k]!==undefined).map(k=>[k,job[k]]));
  }
  const history=async owner=>(await repo.listMetadata('git-sync-job',owner,['recordId','status','phase','title','createdAt','updatedAt','ruleGeneration','error','project','basis','minutesRevision','transcriptRevision','branch','baseBranch','directory','mode','commit','url','agentId','automatic','paused'],{limit:1000})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  async function guard(job,signal,remote=false,ignorePause=false,full=false){
    signal?.throwIfAborted();const rule=await load(job.owner);
    requireThat(rule?.enabled&&rule.generation===(job.authorizationGeneration||job.ruleGeneration),'git_rule_changed',409);
    const current=await repo.get(job.id);requireThat(ignorePause||!current.paused,'git_paused',409);
    const source=await sourceFor(job.owner,job.recordId,rule.includeNotes,full),record=source.record;
    requireThat(source.ready&&source.hash===job.sourceHash,'git_source_changed',409);
    if(job.modelConfigHash)requireThat(modelHash(await readConfig(repo.root))===job.modelConfigHash,'git_model_changed',409);
    await extensions.validate(job.owner,rule.scope);
    if(remote){const catalog=await git.catalog(connection(rule),signal),match=gitTarget(record,catalog.projects,rule.mappings,rule.aliases);requireThat(catalog.group.id===job.rootGroup.id&&match.status==='eligible'&&match.project.id===job.project.id&&match.project.default_branch===job.baseBranch,'git_target_changed',409);}
    return {rule,record};
  }
  async function update(id,values){return repo.change(id,row=>{const unavailable=row.error==='git_source_unavailable'||values.error==='git_source_unavailable';Object.assign(row,values,{updatedAt:now()});if(unavailable)Object.assign(row,{status:'blocked',error:'git_source_unavailable',files:null,original:null,title:''});return structuredClone(row);});}
  const phases=['resolve','prepare','organize','commit','merge'];
  function phaseHandler(phase){return async(task,runtime,taskContext)=>{
    let job=await repo.get(task.input.jobId);
    try{
      requireThat(job&&(!job.taskId||job.taskId===runtime.taskId),'git_task_replaced',409);
      await guard(job,runtime.signal,['commit','merge'].includes(phase));
      job=await update(job.id,{status:'running',phase,error:null,taskId:runtime.taskId});
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
        const child=job.agentId?await agent.get(job.owner,job.agentId):await agent.request(job.owner,{recordIds:[job.recordId],prompt:rule.prompt,requestId:`git-sync:${digest(`${job.id}:${job.agentAttempt||0}`)}`,scopeConfirmed:true,minutesOnly:true,includeNotes:rule.includeNotes,skillId:rule.scope.skill.id,skillVersion:rule.scope.skill.version,skillIds:(rule.scope.skills||[rule.scope.skill]).map(s=>s.id),skillVersions:Object.fromEntries((rule.scope.skills||[rule.scope.skill]).map(s=>[s.id,s.version])),pluginIds:rule.scope.plugins.map(p=>p.id),pluginVersions:Object.fromEntries(rule.scope.plugins.map(p=>[p.id,p.version])),remoteToolsConfirmed:true});
        if(!job.agentId)job=await update(job.id,{agentId:child.id});
        requireThat(Date.now()<job.deadline,'git_agent_timeout',504);
        if(['queued','running','cancelling'].includes(child.status)){await runtime.sleepUntil(Date.now()+agentPollMs,{phase},taskContext);return;}
        requireThat(child.status==='completed'&&!child.stale&&child.result,'git_agent_failed',502);
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
        const result=await git.commit(connection(rule),job,runtime.signal,beforeWrite);await update(job.id,{...result,url:`${gitRoot(rule.root).origin}/${job.project.path}/-/commit/${result.commit}`});
      }else{
        const {rule}=await guard(job,runtime.signal,true);
        const beforeWrite=async()=>{await guard(job,runtime.signal,true);job=await update(job.id,{writeStarted:true});await guard(job,runtime.signal);};
        const result=job.mode==='mr'&&!job.integrated?await git.mergeRequest(connection(rule),job,runtime.signal,beforeWrite):{url:`${gitRoot(rule.root).origin}/${job.project.path}/-/commit/${job.commit}`};
        await update(job.id,{...result,status:'succeeded',phase:'done',error:null});
        await runtime.commit(()=>terminal({status:'completed',result:{jobId:job.id}}),taskContext);return;
      }
      await guard(job,runtime.signal);
      await runtime.commit(()=>({status:'running',checkpoint:{phase:phases[phases.indexOf(phase)+1]}}),taskContext);
    }catch(error){
      if(closing||runtime.signal.aborted)throw error;
      if(error.code==='git_rate_limited'&&(job.rateAttempts||0)<3){const attempt=(job.rateAttempts||0)+1;await update(job.id,{status:'queued',error:'git_rate_limited',rateAttempts:attempt});await runtime.sleepUntil(Date.now()+retryDelayMs*2**(attempt-1),{phase},taskContext);return;}
      const code=safeCode(error),blocked=['git_rule_changed','git_source_changed','git_model_changed','git_source_unavailable','git_target_unclear','git_target_changed','git_target_unavailable','git_default_branch_missing','git_repository_empty','git_target_conflict','git_archive_exists','extension_version_changed','extension_disabled'].includes(code);
      if(code!=='git_paused')await update(job.id,{status:code==='git_result_unknown'?'unknown':blocked?'blocked':'failed',error:code});
      await runtime.commit(()=>terminal({status:'failed',error:{message:code}}),taskContext);
    }
  };}
  const Job=defineTask({name:'git-sync@1',version:1,initial:input=>({phase:input.phase||'resolve'}),phases:Object.fromEntries(phases.map(p=>[p,phaseHandler(p)])),abort:async(_task,runtime,taskContext)=>runtime.commit(()=>terminal({status:'aborted',result:{}}),taskContext)});
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
    requireThat(typeof input.enabled==='boolean','invalid_git_sync',400);const current=await load(owner);
    if(!input.enabled)return enqueue(async()=>{const latest=await load(owner);if(latest)await repo.change(latest.id,r=>{r.enabled=false;r.generation=randomUUID();});return publicRule(await load(owner));});
    requireThat(input.confirmed===true&&typeof input.prompt==='string'&&input.prompt.trim().length>=1&&input.prompt.length<=2000&&typeof input.includeNotes==='boolean'&&typeof input.includeEvidence==='boolean'&&['mr','direct'].includes(input.mode),'git_confirmation_required',400);
    requireThat(input.mode!=='direct'||input.directConfirmed===true,'git_direct_confirmation_required',400);
    const timezone=input.timezone||'UTC';requireThat(typeof timezone==='string'&&timezone.length<=100,'git_timezone_invalid',400);try{new Intl.DateTimeFormat('en-CA',{timeZone:timezone});}catch{throw new DomainError('git_timezone_invalid',400);}
    const rootValue=gitRoot(input.root).url,token=input.token||(current?.root===rootValue?connection(current).token:'');
    requireThat(typeof token==='string'&&token.length<=16000&&!/[^\x21-\x7e]/.test(token),'invalid_git_sync',400);
    const recent=catalogCache.get(owner),sameConnection=current?.root===rootValue&&connection(current).token===token;
    const catalog=recent?.key===digest(rootValue+':'+token)&&Date.now()-recent.at<30000?recent.catalog:sameConnection?{group:current.group,projects:current.projects}:await check(owner,input);
    const {group,projects}=catalog,scope=await extensions.snapshot(owner,input);
    requireThat(Array.isArray(input.mappings)&&input.mappings.length<=50&&Array.isArray(input.aliases)&&input.aliases.length<=100,'invalid_git_sync',400);
    for(const mapping of input.mappings){const workspace=await repo.get(mapping.workspaceId);requireThat(workspace?.kind==='workspace'&&workspace.owner===owner&&projects.some(p=>p.id===mapping.projectId),'git_mapping_invalid',400);}
    requireThat(new Set(input.mappings.map(m=>m.workspaceId)).size===input.mappings.length,'git_mapping_duplicate',400);
    requireThat(input.aliases.every(a=>typeof a.name==='string'&&a.name.trim().length>=3&&a.name.length<=100&&projects.some(p=>p.id===a.projectId)),'git_alias_invalid',400);
    let directory;try{directory=gitArchivePath(typeof input.directory==='string'&&input.directory.trim()?input.directory.trim():'docs/meetings');}catch{throw new DomainError('git_directory_invalid',400);}
    const policy={root:rootValue,group,projects,timezone,prompt:input.prompt.trim(),scope,mappings:input.mappings.map(({workspaceId,projectId})=>({workspaceId,projectId})),aliases:input.aliases.map(({name,projectId})=>({name:name.trim(),projectId})),directory,mode:input.mode,includeNotes:input.includeNotes,includeEvidence:input.includeEvidence};
    const fingerprint=digest(JSON.stringify({...policy,projects:undefined})),unchanged=current?.enabled&&current.fingerprint===fingerprint&&connection(current).token===token;
    const next={id:ruleId(owner),kind:'git-sync-rule',owner,...policy,fingerprint,enabled:true,generation:unchanged?current.generation:randomUUID(),enabledAt:unchanged?current.enabledAt:Date.now(),excluded:unchanged?current.excluded:(await repo.listSummaries(owner,'all','')).filter(r=>r.capture==='completed').map(r=>r.id),credentials:token?secrets.seal(ruleId(owner),{token}):null};
    return enqueue(async()=>{
      const latest=await load(owner);
      await extensions.validate(owner,scope);
      requireThat(!closing&&saveIntents.get(owner)===intent&&latest?.generation===current?.generation,'git_rule_changed',409);
      if(current)await repo.change(current.id,r=>Object.assign(r,next));else await repo.insert(next);return publicRule(next);
    });
  }
  async function preview(owner,input){const rule=input?.root?input:await load(owner);requireThat(rule,'git_not_configured',409);requireThat(Array.isArray(rule.mappings)&&rule.mappings.length<=50&&Array.isArray(rule.aliases)&&rule.aliases.length<=100&&rule.aliases.every(a=>typeof a.name==='string'&&a.name.length<=100),'invalid_git_sync',400);const {projects}=input?.root?await check(owner,input):await git.catalog(connection(rule));const results=[];for(const summary of await repo.listSummaries(owner,'all','')){const r=await recordFor(owner,summary.id),target=gitTarget(r,projects,rule.mappings,rule.aliases);results.push({recordId:r.id,title:r.title,workspaceId:r.workspaceId,...target});}return {results};}
  async function start(owner,recordId,automatic=false){
    const rule=await load(owner);requireThat(rule?.enabled,'git_not_configured',409);const record=await recordFor(owner,recordId);requireThat(gitFinal(record),'git_minutes_not_ready',409);
    const config=await readConfig(repo.root),configHash=modelHash(config),sourceHash=gitSourceHash(record,rule.includeNotes),archiveKey=digest(JSON.stringify([sourceHash,rule.fingerprint,configHash])),key=digest(`${owner}:${record.id}:${archiveKey}`),id=`git-sync:${key}`;
    const existing=await repo.get(id);if(existing)return publicJob(existing);
    const row={id,kind:'git-sync-job',owner,recordId,title:record.title,sourceHash,archiveKey,ruleGeneration:rule.generation,policyFingerprint:rule.fingerprint,modelConfigHash:configHash,model:config.LLM_MODEL||'injected-test-model',reasoningEffort:config.LLM_REASONING_EFFORT||'',rootGroup:rule.group,minutesRevision:record.minutesRevision,transcriptRevision:record.transcriptRevision,automatic,phase:'resolve',status:'queued',createdAt:now(),updatedAt:now(),deadline:Date.now()+900000};
    await repo.insert(row);if(row.status==='queued'){try{await schedule(row);}catch(error){await update(id,{status:'failed',error:safeCode(error)});}}return publicJob(await repo.get(id));
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
        for(const item of batch)if(!retained(access.get(item.recordId),rule.owner)&&item.error!=='git_source_unavailable'){await update(item.id,{status:'blocked',error:'git_source_unavailable',files:null,original:null,title:''});sourceCache.delete(`${item.recordId}:true`);sourceCache.delete(`${item.recordId}:false`);}
        if(batch.length<1000)break;const last=batch.at(-1);before=[last.createdAt,last.id];
      }
      if(!rule.enabled||rows.some(r=>['queued','running'].includes(r.status)))continue;
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
    harness=await Harness.open(await openNodeSqliteStorage(join(repo.root,'git-sync.sqlite')),{models:createModels(),registry,settings:{compaction:{enabled:false}}},context);root=await harness.root(context);
    for(const rule of await repo.list('git-sync-rule'))for(const row of await history(rule.owner)){const job=await repo.get(row.id);if(['queued','running'].includes(job.status)&&!job.taskId)await schedule(job);}
    harness.resume();timer=setInterval(()=>void enqueue(tick).catch(()=>{}),Math.max(50,pollMs));timer.unref();
    return {
    check,save:(owner,input)=>{const intent={};saveIntents.set(owner,intent);return save(owner,input,intent).finally(()=>{if(saveIntents.get(owner)===intent)saveIntents.delete(owner);});},preview,start:(owner,id)=>enqueue(()=>start(owner,id)),tick:()=>enqueue(tick),
      async settings(owner){return {...publicRule(await load(owner)),recent:await Promise.all((await history(owner)).slice(0,20).map(publicJob))};},
      async get(owner,id){return publicJob(await jobFor(owner,id));},
      control:(owner,id,action)=>enqueue(async()=>{
        let job=await jobFor(owner,id);if(job.status==='succeeded')return publicJob(job);
        requireThat(['pause','resume','retry'].includes(action),'invalid_git_sync',400);
        if(action==='pause'){
        job=await update(id,{paused:true,status:'paused'});
        // The durable pause fence blocks new writes even if a transport is slow to cancel.
        if(job.taskId)void harness.abortTask(job.taskId,context).catch(()=>{});
        }else{
          if(job.taskId){await harness.abortTask(job.taskId,context);await harness.waitForTask(job.taskId,context);}
          const rule=await load(owner),record=await recordFor(owner,job.recordId),sameSource=rule&&gitSourceHash(record,rule.includeNotes)===job.sourceHash,sameModel=modelHash(await readConfig(repo.root))===job.modelConfigHash;
          if(action==='retry'&&rule?.enabled&&sameSource&&sameModel&&rule.fingerprint===job.policyFingerprint&&rule.generation!==(job.authorizationGeneration||job.ruleGeneration))job=await update(id,{authorizationGeneration:rule.generation,reauthorizedAt:now()});
          if(action==='retry'&&!job.writeStarted&&rule?.enabled&&((job.authorizationGeneration||job.ruleGeneration)!==rule.generation||!sameSource||!sameModel)){await update(id,{status:'superseded',error:null,files:null,original:null});return start(owner,job.recordId);}
          await guard(job,undefined,false,true);

          const child=job.agentId?await agent.get(owner,job.agentId):null;
          job=await update(id,{paused:false,status:'queued',phase:job.project?job.phase:'resolve',error:null,rateAttempts:0,deadline:Date.now()+900000,...(child&&['failed','blocked','cancelled'].includes(child.status)?{agentId:null,agentAttempt:(job.agentAttempt||0)+1}:{})});await schedule(job);
        }return publicJob(await repo.get(id));
      }),
      async close(){closing=true;clearInterval(timer);await operations;await harness.close(context);lock.close();}
    };
  }catch(error){clearInterval(timer);await harness?.close(context);lock.close();throw error;}
}
