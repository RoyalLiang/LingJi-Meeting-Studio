import { randomUUID } from 'node:crypto';
import { DomainError, digest, requireThat } from '../../../../packages/records/src/record.mjs';
import { exportMinutesMarkdown, minutesForExport } from '../markdown-export.mjs';
import { createSecretStore } from './secret-store.mjs';

import {FEISHU_SCOPES} from '../../../../packages/records/src/feishu.mjs';
import {feishuBoard} from './feishu-board.mjs';
import {createFeishuSdk} from './feishu-sdk.mjs';
export {FEISHU_SCOPES};
const api = 'https://open.feishu.cn/open-apis';
const autoId = owner => `feishu-auto:${digest(owner)}`;
const exportFields=['authMode','recordId','title','folderToken','destinationEmail','includeBoard','includeNotes','includeEvidence','source','fingerprint','status','stage','createdAt','updatedAt','documentId','url','error','automatic'];
const connectionId = owner => `feishu-connection:${digest(owner)}`;
const string = (value, max) => typeof value === 'string' && value.length <= max;
const documentToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);

export function feishuFolder(value = '') {
  requireThat(string(value, 1000), 'invalid_feishu_folder', 400);
  const input = value.trim();
  if (!input) return '';
  if (/^[A-Za-z0-9_-]{8,100}$/.test(input)) return input;
  let url; try { url = new URL(input); } catch { throw new DomainError('invalid_feishu_folder', 400); }
  const token = url.pathname.match(/^\/drive\/folder\/([A-Za-z0-9_-]{8,100})\/?$/)?.[1];
  requireThat(url.protocol === 'https:' && /(^|\.)feishu\.cn$/.test(url.hostname) && !url.username && !url.password && token, 'invalid_feishu_folder', 400);
  return token;
}

export function feishuMember(value=''){
  requireThat(string(value,254),'invalid_feishu_member',400);const email=value.trim();
  requireThat(!email||/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email),'invalid_feishu_member',400);return email;
}

export function feishuBlocks(converted) {
  const roots = converted?.first_level_block_ids, blocks = structuredClone(converted?.blocks);
  requireThat(Array.isArray(roots) && roots.length > 0 && Array.isArray(blocks) && blocks.length <= 1000, 'feishu_document_too_large', 400);
  const ids = new Map(blocks.map(block => [block.block_id, block]));
  requireThat(ids.size === blocks.length && roots.every(id => ids.has(id)), 'feishu_invalid_blocks', 502);
  const seen = new Set();
  const visit = id => {
    requireThat(ids.has(id) && !seen.has(id), 'feishu_invalid_blocks', 502); seen.add(id);
    const block = ids.get(id); delete block.parent_id;
    if (block.table) { delete block.table.cells; delete block.table.merge_info; if (block.table.property) delete block.table.property.merge_info; }
    requireThat(!block.image && !block.file && !block.iframe, 'feishu_unsupported_content', 400);
    for (const child of block.children || []) visit(child);
  };
  for (const id of roots) visit(id);
  requireThat(seen.size === blocks.length, 'feishu_invalid_blocks', 502);
  return {children_id:roots, descendants:blocks, index:-1};
}

function exportSnapshot(record, input) {
  const title = input.title?.trim();
  requireThat(string(title, 200) && title && !/[\u0000-\u001f]/.test(title), 'invalid_title', 400);
  requireThat(typeof input.includeNotes === 'boolean' && typeof input.includeEvidence === 'boolean', 'feishu_scope_required', 400);
  const folderToken = feishuFolder(input.folderToken),destinationEmail=feishuMember(input.destinationEmail);
  requireThat(!destinationEmail||!folderToken,'invalid_feishu_destination',400);
  requireThat(input.includeBoard===undefined||typeof input.includeBoard==='boolean','feishu_scope_required',400);
  const includeBoard=input.includeBoard===true;
  const markdown = exportMinutesMarkdown(record, input), minutes = minutesForExport(record);
  requireThat(Buffer.byteLength(markdown) <= 500000, 'feishu_document_too_large', 400);
  const source = {minutesRevision:minutes.revision, transcriptRevision:minutes.transcriptRevision,
    notesRevision:input.includeNotes ? record.notesRevision : null, edited:Boolean(minutes.edited), draft:minutes !== record.minutes || record.capture !== 'completed'};
  const boardNodes=includeBoard?feishuBoard(minutes):[];
  return {title, folderToken, destinationEmail, includeBoard, boardNodes, includeNotes:input.includeNotes, includeEvidence:input.includeEvidence, markdown, source,
    fingerprint:digest(JSON.stringify({title, folderToken, destinationEmail, includeBoard, boardNodes, markdown, source}))};
}

const publicExport = value => Object.fromEntries(['authMode','id','recordId','title','folderToken','destinationEmail','includeBoard','includeNotes','includeEvidence','source','fingerprint','status','stage','createdAt','updatedAt','documentId','url','error','automatic'].filter(key => value[key] !== undefined && value[key] !== null).map(key => [key,['includeBoard','includeNotes','includeEvidence','automatic'].includes(key)?Boolean(value[key]):value[key]]));

export async function createFeishu(repo, {sdkFactory=createFeishuSdk,now=Date.now,autoPollMs=30000}={}) {
  const secrets=await createSecretStore(repo.root),clients=new Map(),controlVersions=new Map(),jobs=new Set(),stopping=new AbortController();
  let autoBusy=false,autoTimer,autoWork;
  const runningOwners=new Map();
  const control=owner=>{const version=(controlVersions.get(owner)||0)+1;controlVersions.set(owner,version);return()=>requireThat(controlVersions.get(owner)===version&&!stopping.signal.aborted,'feishu_connection_changed',409);};
  const abortConnection=owner=>{const current=clients.get(owner);if(current){clients.delete(owner);current.controller.abort();current.sdk?.close();}};
  const connectionSignal=(owner,generation)=>{const current=clients.get(owner);requireThat(current?.generation===generation&&!current.controller.signal.aborted,'feishu_connection_changed',409);return current.controller.signal;};
  const history=async(owner,recordId,limit=200)=>{
    const entries=await repo.listMetadata('feishu-export',owner,exportFields,{recordId,limit});
    const access=new Map((await repo.getRecordAccess(entries.map(item=>item.recordId))).map(item=>[item.id,item]));
    return entries.filter(item=>{const record=access.get(item.recordId);return record?.owner===owner&&!record.deleted&&Date.parse(record.deleteAt)>now();});
  };
  const load = owner => repo.get(connectionId(owner));
  const open = conn => secrets.open(conn.id, conn.credentials);
  async function startConnection(conn,controlActive=()=>{}){
    controlActive();const previous=clients.get(conn.owner);if(previous?.generation===conn.generation&&previous.started)return previous.starting;
    abortConnection(conn.owner);
    const entry={generation:conn.generation,controller:new AbortController(),sdk:null,error:null};clients.set(conn.owner,entry);
    const active=()=>{controlActive();requireThat(clients.get(conn.owner)===entry&&!entry.controller.signal.aborted&&!stopping.signal.aborted,'feishu_connection_changed',409);};
    entry.starting=(async()=>{
      try{
        const latest=await load(conn.owner);active();requireThat(latest?.generation===conn.generation&&latest.connected,'feishu_connection_changed',409);
        const sdk=await sdkFactory({appId:conn.appId,appSecret:open(conn).appSecret,signal:AbortSignal.any([stopping.signal,entry.controller.signal])});
        entry.sdk=sdk;active();await sdk.start();active();entry.started=true;return sdk;
      }catch{entry.error='feishu_connection_failed';entry.sdk?.close();throw new DomainError('feishu_connection_failed',502);}
    })();return entry.starting;
  }
  async function settings(owner){
    const conn=await load(owner),entry=clients.get(owner),status=entry?.sdk?.status();
    const connection=entry&&entry.generation===conn?.generation?{state:entry.error?'failed':status?.state||'connecting',reconnectAttempts:status?.reconnectAttempts||0}:{state:conn?.credentials?'disconnected':'unconfigured',reconnectAttempts:0};
    return {authMode:'app',appId:conn?.appId||'',hasSecret:Boolean(conn?.credentials),enabled:Boolean(conn?.connected),connected:Boolean(conn?.connected&&connection.state==='connected'),connection,scopes:FEISHU_SCOPES};
  }
  async function request(client,url,{body,write=false,signal}={}){
    let data;
    try{data=await client.request(url,{body,signal});}
    catch(error){if(error?.response){const code=error.response.data?.code;const permission=error.response.status===403||[99991663,99991672,99991679,1063002,1063004,2890005].includes(code);const rejected=new DomainError(error.response.status===429||code===99991400?'feishu_rate_limited':permission?'feishu_permission_required':'feishu_request_rejected',502);rejected.uncertain=write&&error.response.status>=500;throw rejected;}
      const failed=new DomainError(write?'feishu_write_unknown':'feishu_unavailable',502);failed.uncertain=write;throw failed;}
    requireThat(data&&typeof data==='object'&&!Array.isArray(data),'feishu_invalid_response',502);
    if(data.code!==0){throw new DomainError([99991400,1063006,2890006].includes(data.code)?'feishu_rate_limited':[99991663,99991672,99991679,1063002,1063004,2890005].includes(data.code)?'feishu_permission_required':'feishu_request_rejected',502);}
    return data;
  }
  async function configure(owner, input) {
    requireThat(input && typeof input === 'object' && !Array.isArray(input), 'invalid_feishu_config', 400);
    requireThat(string(input.appId, 100) && /^cli_[a-f0-9]{16}$/i.test(input.appId), 'invalid_feishu_config', 400);
    const active=control(owner),current = await load(owner);active();
    const appSecret = input.appSecret === '' && current ? open(current).appSecret : input.appSecret;
    requireThat(string(appSecret,2048) && appSecret.length >= 8 && !/[\r\n]/.test(appSecret), 'invalid_feishu_config', 400);
    requireThat(input.authMode===undefined||input.authMode==='app','invalid_feishu_config',400);
    requireThat(input.redirectUri===undefined,'invalid_feishu_config',400);
    if(current?.appId===input.appId&&open(current).appSecret===appSecret&&current.authMode==='app'){
      await repo.change(current.id,value=>{active();value.connected=true;});
      const previous=clients.get(owner);if(previous?.error||previous?.sdk?.status().state==='failed')abortConnection(owner);
      await startConnection({...current,connected:true},active);return settings(owner);
    }
    const next={id:connectionId(owner),kind:'feishu-connection',owner,authMode:'app',appId:input.appId,generation:randomUUID(),connected:true};
    next.credentials=secrets.seal(next.id,{appSecret});
    if(current)await repo.change(next.id,value=>{active();abortConnection(owner);Object.assign(value,next);delete value.identity;delete value.redirectUri;delete value.authorizationAttempt;});else{await repo.insert({...next,connected:false});active();await repo.change(next.id,value=>{active();requireThat(value.generation===next.generation,'feishu_connection_changed',409);value.connected=true;});}
    active();await startConnection(next,active);return settings(owner);
  }
  async function connect(owner){
    const active=control(owner),conn=await load(owner);active();requireThat(conn?.credentials,'feishu_not_configured',409);
    await repo.change(conn.id,current=>{active();requireThat(current.generation===conn.generation,'feishu_connection_changed',409);current.connected=true;});active();
    const previous=clients.get(owner);if(previous?.generation===conn.generation&&(previous.error||previous.sdk?.status().state==='failed'))abortConnection(owner);
    await startConnection(conn,active);active();
    requireThat(!stopping.signal.aborted&&clients.get(owner)?.generation===conn.generation&&!clients.get(owner).controller.signal.aborted,'feishu_connection_changed',409);
    return settings(owner);
  }
  async function disconnect(owner){
    const active=control(owner);abortConnection(owner);const conn=await load(owner);active();
    if(conn)await repo.change(conn.id,value=>{active();if(value.generation!==conn.generation)return;value.credentials=secrets.seal(value.id,{appSecret:open(value).appSecret});value.connected=false;value.generation=randomUUID();});
    if(clients.get(owner)?.generation===conn?.generation)abortConnection(owner);
    return settings(owner);
  }
  async function ownedRecord(owner,id){const record=await repo.get(id);requireThat(record?.kind==='record'&&record.owner===owner&&!record.deleted&&Date.parse(record.deleteAt)>now(),'record_not_found',404);return record;}
  async function ownedExport(owner,id){const value=await repo.get(id);requireThat(value?.kind==='feishu-export'&&value.owner===owner,'not_found',404);await ownedRecord(owner,value.recordId);return value;}
  async function preview(owner,recordId,input,automatic=false,id=randomUUID(),rule){
    const conn=await load(owner);requireThat((await settings(owner)).connected,'feishu_not_connected',409);
    const record=await ownedRecord(owner,recordId),snapshot=exportSnapshot(record,input);
    requireThat((await history(owner)).filter(value=>value.createdAt>now()-86400000).length<200,'feishu_export_limit',429);
    const draft=await repo.insert({id,kind:'feishu-export',owner,recordId,...snapshot,authMode:'app',connectionGeneration:conn.generation,status:'draft',stage:'preview',createdAt:now(),updatedAt:now(),automatic,...(rule?{ruleGeneration:rule.generation}:{})});
    return {...publicExport(draft),markdown:draft.markdown,boardNodes:draft.boardNodes};
  }
  async function get(owner,id){const value=await ownedExport(owner,id);if(value.status==='publishing'&&value.updatedAt<now()-180000)await repo.change(id,current=>{if(current.status==='publishing'&&current.updatedAt<now()-180000){current.status=current.documentId?'partial':'unknown';current.error='feishu_interrupted';current.updatedAt=now();}});const current=await ownedExport(owner,id);return {...publicExport(current),...(current.status==='draft'?{markdown:current.markdown,boardNodes:current.boardNodes}:{})};}
  async function run(owner,id){
    runningOwners.set(owner,(runningOwners.get(owner)||0)+1);
    let stage='convert';
    const update=patch=>repo.change(id,current=>Object.assign(current,patch,{updatedAt:now()}));
    try{
      const value=await ownedExport(owner,id),conn=await load(owner);
      requireThat(conn?.connected&&conn.generation===value.connectionGeneration,'feishu_connection_changed',409);
      const guard=async()=>{if(value.automatic){const rule=await repo.get(autoId(owner));requireThat(rule?.enabled&&rule.generation===value.ruleGeneration,'feishu_automation_changed',409);}await ownedRecord(owner,value.recordId);const current=await load(owner);requireThat(current?.connected&&current.generation===value.connectionGeneration&&(await settings(owner)).connected,'feishu_connection_changed',409);};
      await guard();const signal=connectionSignal(owner,conn.generation);
      const client=clients.get(owner)?.sdk,converted=await request(client,`${api}/docx/v1/documents/blocks/convert`,{signal,body:{content_type:'markdown',content:value.markdown}});
      const blocks=feishuBlocks(converted.data);
      await guard();stage='create';await update({stage});
      const created=await request(client,`${api}/docx/v1/documents`,{signal,body:{title:value.title,...(value.folderToken?{folder_token:value.folderToken}:{})},write:true});
      const documentId=created.data?.document?.document_id;requireThat(documentToken(documentId),'feishu_write_unknown',502);
      stage='verify';await update({stage,documentId});
      const metadata=async()=>{
        const verified=await request(client,`${api}/drive/v1/metas/batch_query`,{signal,body:{request_docs:[{doc_token:documentId,doc_type:'docx'}],with_url:true}});
        const meta=verified.data?.metas?.find(item=>item.doc_token===documentId);
        let url;try{url=new URL(meta?.url);}catch{throw new DomainError('feishu_verification_failed',502);}
        requireThat(!verified.data?.failed_list?.some(item=>item.token===documentId)&&meta.doc_type==='docx'&&meta.title===value.title&&url.protocol==='https:'&&/(^|\.)feishu\.cn$/.test(url.hostname)&&!url.username&&!url.password&&!url.port&&url.pathname===`/docx/${documentId}`,'feishu_verification_failed',502);
        return url.href;
      };
      await update({url:await metadata()});
      await guard();stage='write';await update({stage});
      await request(client,`${api}/docx/v1/documents/${documentId}/blocks/${documentId}/descendant?document_revision_id=-1&client_token=${id}`,{signal,body:blocks,write:true});
      if(value.includeBoard){
        await guard();stage='board';await update({stage});
        const block=await request(client,`${api}/docx/v1/documents/${documentId}/blocks/${documentId}/children?document_revision_id=-1&client_token=${id}-board`,{signal,body:{children:[{block_type:43,board:{}}],index:-1},write:true});
        const boardToken=block.data?.children?.find(item=>item.block_type===43)?.board?.token;
        requireThat(documentToken(boardToken),'feishu_verification_failed',502);await update({boardToken});await guard();
        const createdNodes=await request(client,`${api}/board/v1/whiteboards/${boardToken}/nodes?client_token=${id}`,{signal,body:{nodes:value.boardNodes},write:true});
        requireThat(Array.isArray(createdNodes.data?.ids)&&createdNodes.data.ids.length===value.boardNodes.length,'feishu_verification_failed',502);
      }
      stage='verify';await update({stage});const url=await metadata();
      if(value.destinationEmail){
        await guard();stage='transfer';await update({stage});
        await request(client,`${api}/drive/v1/permissions/${documentId}/members/transfer_owner?type=docx&stay_put=false&remove_old_owner=false&old_owner_perm=full_access`,{signal,body:{member_type:'email',member_id:value.destinationEmail},write:true});
      }
      await update({status:'succeeded',stage:'completed',url,markdown:'',boardNodes:[]});
    }catch(error){const value=await repo.get(id);await update({status:value.documentId?'partial':stage==='create'&&(error.uncertain||error.code==='feishu_write_unknown')?'unknown':'failed',stage,markdown:'',boardNodes:[],error:error instanceof DomainError?error.code:'feishu_unavailable'});}
    finally{const count=runningOwners.get(owner)-1;if(count)runningOwners.set(owner,count);else runningOwners.delete(owner);}
  }
  async function publish(owner,id,input){
    requireThat(input?.confirmed===true,'feishu_confirmation_required',400);
    const draft=await ownedExport(owner,id),conn=await load(owner);
    requireThat(conn?.connected&&conn.generation===draft.connectionGeneration&&(await settings(owner)).connected,'feishu_connection_changed',409);
    if(draft.status!=='draft')return get(owner,id);
    await repo.changeMany([id,draft.recordId],values=>{
      const current=values.find(value=>value.id===id),record=values.find(value=>value.id===draft.recordId);
      requireThat(current.owner===owner&&record.owner===owner&&!record.deleted&&Date.parse(record.deleteAt)>now(),'record_not_found',404);
      requireThat(current.status==='draft','feishu_export_started',409);
      requireThat(current.createdAt>now()-3600000&&exportSnapshot(record,current).fingerprint===current.fingerprint,'feishu_preview_stale',409);
      Object.assign(current,{status:'publishing',stage:'convert',updatedAt:now()});
    });
    const job=run(owner,id);jobs.add(job);job.finally(()=>jobs.delete(job)).catch(()=>{});
    return get(owner,id);
  }
  async function automation(owner){const rule=await repo.get(autoId(owner));return {configured:Boolean(rule),enabled:Boolean(rule?.enabled),folderToken:rule?.folderToken||'',destinationEmail:rule?.destinationEmail||'',includeBoard:Boolean(rule?.includeBoard),includeNotes:Boolean(rule?.includeNotes),includeEvidence:rule?.includeEvidence!==false,connectionChanged:rule?.enabled&&(await load(owner))?.generation!==rule.connectionGeneration,recent:(await history(owner)).filter(item=>item.automatic).slice(0,10).map(publicExport)};}
  async function saveAutomation(owner,input){
    requireThat(typeof input?.enabled==='boolean','invalid_feishu_automation',400);
    const id=autoId(owner),current=await repo.get(id);
    if(!input.enabled){if(current)await repo.change(id,value=>{value.enabled=false;value.generation=randomUUID();});return automation(owner);}
    requireThat(input.confirmed===true&&typeof input.includeNotes==='boolean'&&typeof input.includeEvidence==='boolean','feishu_confirmation_required',400);
    const conn=await load(owner);requireThat((await settings(owner)).connected,'feishu_not_connected',409);
    const folderToken=feishuFolder(input.folderToken),destinationEmail=feishuMember(input.destinationEmail),includeBoard=input.includeBoard===true;
    requireThat(!destinationEmail||!folderToken,'invalid_feishu_destination',400);
    requireThat(input.includeBoard===undefined||typeof input.includeBoard==='boolean','invalid_feishu_automation',400);
    const unchanged=current?.enabled&&current.connectionGeneration===conn.generation&&current.folderToken===folderToken&&(current.destinationEmail||'')===destinationEmail&&Boolean(current.includeBoard)===includeBoard&&current.includeNotes===input.includeNotes&&current.includeEvidence===input.includeEvidence;
    if(unchanged)return automation(owner);
    const excluded=(await repo.listSummaries(owner,'all','')).filter(record=>record.capture==='completed').map(record=>record.id);
    const rule={id,kind:'feishu-auto-rule',owner,enabled:true,generation:randomUUID(),connectionGeneration:conn.generation,folderToken,destinationEmail,includeBoard,includeNotes:input.includeNotes,includeEvidence:input.includeEvidence,excluded,enabledAt:now()};
    if(current)await repo.change(id,value=>Object.assign(value,rule));else await repo.insert(rule);
    return automation(owner);
  }
  async function automaticTick(){
    if(autoBusy||stopping.signal.aborted)return;autoBusy=true;
    try{
      for(const conn of await repo.list('feishu-connection')){
        const drafts=await repo.listMetadata('feishu-export',conn.owner,['recordId','createdAt','status'],{status:'draft',limit:1000}),access=new Map((await repo.getRecordAccess(drafts.map(item=>item.recordId))).map(item=>[item.id,item]));
        for(const entry of drafts){
          const record=access.get(entry.recordId);
          if(entry.createdAt<now()-3600000||!record||record.deleted||Date.parse(record.deleteAt)<=now())await repo.change(entry.id,value=>{if(value.status==='draft'){value.markdown='';value.boardNodes=[];value.status='failed';value.error='feishu_preview_stale';value.updatedAt=now();}});
        }
      }
      for(const rule of await repo.list('feishu-auto-rule')){
        const conn=await load(rule.owner);if(!rule.enabled||!(await settings(rule.owner)).connected||conn.generation!==rule.connectionGeneration||runningOwners.has(rule.owner))continue;
        for(const summary of await repo.listSummaries(rule.owner,'all','')){
          if(summary.capture!=='completed'||!summary.hasMinutes||rule.excluded.includes(summary.id))continue;
          const hash=digest(`${rule.generation}:${summary.id}`),id=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
          if(await repo.get(id))continue;
          const record=await ownedRecord(rule.owner,summary.id);
          const finalJob=record.jobs.filter(job=>job.scope!=='live').at(-1);
          if(!record.minutes||record.transcription!=='ready'||record.jobs.some(job=>['queued','running'].includes(job.status))||record.minutes.transcriptRevision!==record.transcriptRevision||finalJob?.status==='failed')continue;
          try{await preview(rule.owner,record.id,{title:record.title,folderToken:rule.folderToken,destinationEmail:rule.destinationEmail||'',includeBoard:Boolean(rule.includeBoard),includeNotes:rule.includeNotes,includeEvidence:rule.includeEvidence},true,id,rule);await publish(rule.owner,id,{confirmed:true});break;}catch(error){if(!['already_exists','feishu_export_started'].includes(error.code))throw error;}
        }
      }
    }finally{autoBusy=false;}
  }
  for(const conn of await repo.list('feishu-connection')){
    const credentials=open(conn),legacy=conn.authMode!=='app';
    if(legacy||Object.keys(credentials).some(key=>key!=='appSecret'))await repo.change(conn.id,current=>{current.credentials=secrets.seal(current.id,{appSecret:credentials.appSecret});delete current.redirectUri;delete current.identity;delete current.authorizationAttempt;current.authMode='app';if(legacy){current.connected=false;current.generation=randomUUID();}});
    const current=await load(conn.owner);if(current.connected){const work=startConnection(current).catch(()=>{});jobs.add(work);work.finally(()=>jobs.delete(work));}
  }
  autoTimer=setInterval(()=>{if(!autoBusy)autoWork=automaticTick().catch(()=>{});},Math.max(100,autoPollMs));autoTimer.unref();
  return {settings,configure,disconnect,async setEnabled(owner,input){requireThat(typeof input?.enabled==='boolean','invalid_feishu_config',400);return input.enabled?connect(owner):disconnect(owner);},preview,publish,get,automation,saveAutomation,automaticTick,
    async list(owner,recordId){await ownedRecord(owner,recordId);return (await history(owner,recordId,10)).map(publicExport);},
    async close(){clearInterval(autoTimer);stopping.abort();await autoWork;for(const owner of clients.keys())abortConnection(owner);await Promise.allSettled(jobs);}
  };
}
