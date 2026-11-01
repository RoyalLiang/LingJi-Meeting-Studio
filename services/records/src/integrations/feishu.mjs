import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DomainError, digest, requireThat } from '../../../../packages/records/src/record.mjs';
import { exportMinutesMarkdown, minutesForExport } from '../markdown-export.mjs';
import { createSecretStore } from './secret-store.mjs';

import {FEISHU_CALLBACK,FEISHU_SCOPES,FEISHU_REDIRECT_URI,FEISHU_AUTHORIZE_URL,FEISHU_TOKEN_URL} from '../../../../packages/records/src/feishu-oauth.mjs';
import {openFeishuRelay} from './feishu-relay.mjs';
export {FEISHU_CALLBACK,FEISHU_SCOPES};
const api = 'https://open.feishu.cn/open-apis';
const autoId = owner => `feishu-auto:${digest(owner)}`;
const exportFields=['recordId','title','folderToken','includeNotes','includeEvidence','source','fingerprint','status','stage','createdAt','updatedAt','documentId','url','error','automatic'];
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
  const folderToken = feishuFolder(input.folderToken);
  const markdown = exportMinutesMarkdown(record, input), minutes = minutesForExport(record);
  requireThat(Buffer.byteLength(markdown) <= 500000, 'feishu_document_too_large', 400);
  const source = {minutesRevision:minutes.revision, transcriptRevision:minutes.transcriptRevision,
    notesRevision:input.includeNotes ? record.notesRevision : null, edited:Boolean(minutes.edited), draft:minutes !== record.minutes || record.capture !== 'completed'};
  return {title, folderToken, includeNotes:input.includeNotes, includeEvidence:input.includeEvidence, markdown, source,
    fingerprint:digest(JSON.stringify({title, folderToken, markdown, source}))};
}

const publicExport = value => Object.fromEntries(['id','recordId','title','folderToken','includeNotes','includeEvidence','source','fingerprint','status','stage','createdAt','updatedAt','documentId','url','error','automatic'].filter(key => value[key] !== undefined && value[key] !== null).map(key => [key,['includeNotes','includeEvidence','automatic'].includes(key)?Boolean(value[key]):value[key]]));

export async function createFeishu(repo, {fetch:fetcher = globalThis.fetch, now = Date.now, autoPollMs=30000, relayFetch=globalThis.fetch, relayPollMs=1500} = {}) {
  const secrets = await createSecretStore(repo.root), pending = new Map(), refreshes = new Map(), jobs = new Set(), stopping = new AbortController();
  let autoBusy=false,autoTimer,autoWork;
  const authorizations=new Map();
  function retire(owner){for(const [state,entry]of pending)if(entry.owner===owner){pending.delete(state);entry.controller?.abort();void entry.relay?.close();}authorizations.delete(owner);}
  const runningOwners=new Map();
  const connections=new Map();
  const connectionSignal=(owner,generation)=>{const key=`${owner}|${generation}`;if(!connections.has(key))connections.set(key,new AbortController());return connections.get(key).signal;};
  const abortConnection=owner=>{for(const [key,controller]of connections)if(key.startsWith(`${owner}|`))controller.abort();refreshes.delete(owner);};
  const history=async(owner,recordId,limit=200)=>{
    const entries=await repo.listMetadata('feishu-export',owner,exportFields,{recordId,limit});
    const access=new Map((await repo.getRecordAccess(entries.map(item=>item.recordId))).map(item=>[item.id,item]));
    return entries.filter(item=>{const record=access.get(item.recordId);return record?.owner===owner&&!record.deleted&&Date.parse(record.deleteAt)>now();});
  };
  const load = owner => repo.get(connectionId(owner));
  const open = conn => secrets.open(conn.id, conn.credentials);
  const saveCredentials = async (conn, credentials) => repo.change(conn.id, current => {
    requireThat(current.generation === conn.generation, 'feishu_connection_changed', 409);
    current.credentials = secrets.seal(current.id, credentials);
  });
  async function request(url, {token, body, write = false, signal} = {}) {
    let response, data;
    try {
      response = await fetcher(url, {method:body ? 'POST' : 'GET', redirect:'error',
        signal:AbortSignal.any([stopping.signal, AbortSignal.timeout(20000),...(signal?[signal]:[])]),
        headers:{...(token ? {Authorization:`Bearer ${token}`} : {}), 'Content-Type':'application/json; charset=utf-8'},
        ...(body ? {body:JSON.stringify(body)} : {})});
      const text = await response.text();
      requireThat(text.length <= 10 * 1024 * 1024, 'feishu_invalid_response', 502);
      data = JSON.parse(text);
      requireThat(data&&typeof data==='object'&&!Array.isArray(data),'feishu_invalid_response',502);
    } catch {
      const error = new DomainError(write ? 'feishu_write_unknown' : 'feishu_unavailable', 502); error.uncertain = write; throw error;
    }
    const oauth=url===FEISHU_TOKEN_URL;
    if (!response.ok || (oauth ? Boolean(data.error)||(data.code!==undefined&&data.code!==0) : data.code!==0)) {
      const permission = response.status === 403 || [99991663,99991672,99991679].includes(data.code);
      const error = new DomainError(response.status === 429 || data.code === 99991400 ? 'feishu_rate_limited' : permission ? 'feishu_permission_required' : 'feishu_request_rejected', 502);
      error.uncertain = write && response.status >= 500; throw error;
    }
    return data;
  }
  async function tokenFor(owner) {
    if (refreshes.has(owner)) return refreshes.get(owner);
    const task = (async () => {
      const conn = await load(owner); requireThat(conn?.connected, 'feishu_not_connected', 409);
      const credentials = open(conn);
      if (credentials.expiresAt > now()+60000) return credentials.accessToken;
      requireThat(credentials.refreshToken && credentials.refreshExpiresAt > now(), 'feishu_reauthorize', 409);
      const token = await request('https://accounts.feishu.cn/oauth/v3/token', {signal:connectionSignal(owner,conn.generation),body:{grant_type:'refresh_token', client_id:conn.appId, client_secret:credentials.appSecret, refresh_token:credentials.refreshToken}});
      requireThat(string(token.access_token, 16000) && token.access_token && Number.isFinite(token.expires_in), 'feishu_reauthorize', 502);
      await saveCredentials(conn, {...credentials, accessToken:token.access_token, expiresAt:now()+token.expires_in*1000,
        refreshToken:token.refresh_token || credentials.refreshToken, refreshExpiresAt:token.refresh_token ? now()+token.refresh_token_expires_in*1000 : credentials.refreshExpiresAt});
      return token.access_token;
    })();
    refreshes.set(owner, task); try { return await task; } finally { if(refreshes.get(owner)===task)refreshes.delete(owner); }
  }
  async function settings(owner) {
    const conn=await load(owner),redirectUri=conn?.redirectUri||FEISHU_REDIRECT_URI,status=authorizations.get(owner);
    return {appId:conn?.appId||'',hasSecret:Boolean(conn?.credentials),redirectUri,recommendedRedirectUri:FEISHU_REDIRECT_URI,relayManaged:redirectUri===FEISHU_REDIRECT_URI,requiresCallbackUpdate:redirectUri.startsWith('http:'),
      authorization:status?{status:status.status,error:status.error||null}:{status:'idle',error:null},connected:Boolean(conn?.connected),identity:conn?.connected?conn.identity:null,scopes:FEISHU_SCOPES};
  }
  async function configure(owner, input) {
    requireThat(input && typeof input === 'object' && !Array.isArray(input), 'invalid_feishu_config', 400);
    requireThat(string(input.appId, 100) && /^cli_[A-Za-z0-9_]{6,90}$/.test(input.appId), 'invalid_feishu_config', 400);
    const current = await load(owner);
    const appSecret = input.appSecret === '' && current ? open(current).appSecret : input.appSecret;
    requireThat(string(appSecret,2048) && appSecret.length >= 8 && !/[\r\n]/.test(appSecret), 'invalid_feishu_config', 400);
    let redirect; try { redirect = new URL(input.redirectUri); } catch { throw new DomainError('invalid_feishu_config',400); }
    requireThat(redirect.protocol==='https:' && redirect.pathname===FEISHU_CALLBACK && !redirect.search && !redirect.hash && !redirect.username && !redirect.password,'invalid_feishu_config',400);
    const next = {id:connectionId(owner),kind:'feishu-connection',owner,appId:input.appId,redirectUri:redirect.href,generation:randomUUID(),connected:false};
    next.credentials = secrets.seal(next.id,{appSecret});
    if (current) await repo.change(next.id,value=>Object.assign(value,next)); else await repo.insert(next);
    abortConnection(owner);retire(owner);
    for (const [state, entry] of pending) if(entry.owner === owner) pending.delete(state);
    return settings(owner);
  }
  async function completeAuthorization(entry,code){
    const active=()=>requireThat(pending.get(entry.state)===entry&&!entry.controller.signal.aborted&&entry.expires>now(),'feishu_oauth_expired',409);
    active();
    const conn=await load(entry.owner);requireThat(conn?.generation===entry.generation,'feishu_connection_changed',409);
    const credentials=open(conn);
    const signal=AbortSignal.any([connectionSignal(entry.owner,entry.generation),entry.controller.signal]);
    const token=await request(FEISHU_TOKEN_URL,{signal,body:{grant_type:'authorization_code',client_id:conn.appId,client_secret:credentials.appSecret,redirect_uri:conn.redirectUri,code,code_verifier:entry.verifier}});
    active();
    requireThat(string(token.access_token,16000)&&token.access_token&&Number.isFinite(token.expires_in),'feishu_invalid_response',502);
    const result=await request(`${api}/authen/v1/user_info`,{token:token.access_token,signal});
    requireThat(result.data?.open_id&&result.data?.tenant_key,'feishu_invalid_response',502);
    await repo.change(conn.id,current=>{
      active();requireThat(current.authorizationAttempt===digest(entry.state),'feishu_oauth_expired',409);
      requireThat(current.generation===entry.generation,'feishu_connection_changed',409);
      current.credentials=secrets.seal(conn.id,{...credentials,accessToken:token.access_token,expiresAt:now()+token.expires_in*1000,refreshToken:token.refresh_token||'',refreshExpiresAt:now()+(token.refresh_token_expires_in||0)*1000});
      delete current.authorizationAttempt;current.generation=randomUUID();current.connected=true;current.identity={name:String(result.data.name||'').slice(0,80),openId:result.data.open_id,tenantKey:result.data.tenant_key};
    });
    connections.get(`${entry.owner}|${entry.generation}`)?.abort();refreshes.delete(entry.owner);
    if(authorizations.get(entry.owner)?.state===entry.state)authorizations.delete(entry.owner);
  }
  async function callback(url){
    const state=url.searchParams.get('state'),entry=pending.get(state);
    requireThat(entry&&!entry.relay&&!entry.exchanging&&entry.expires>now(),'feishu_oauth_expired',400);entry.exchanging=true;
    try{
      requireThat(!url.searchParams.has('error'),'feishu_authorization_denied',400);
      const code=url.searchParams.get('code');requireThat(string(code,4096)&&code,'feishu_oauth_invalid',400);
      await completeAuthorization(entry,code);
    }catch(error){if(authorizations.get(entry.owner)?.state===state)authorizations.set(entry.owner,{state,status:'failed',error:error instanceof DomainError?error.code:'feishu_unavailable',expires:now()+600000});throw error;}
    finally{if(pending.get(state)===entry)pending.delete(state);entry.controller.abort();}
  }
  async function callbackResponse(req,res) {
    let ok=false;
    try { const url=new URL(req.url,'http://localhost'); requireThat(req.method==='GET' && url.pathname===FEISHU_CALLBACK,'not_found',404); const entry=pending.get(url.searchParams.get('state')),conn=entry&&await load(entry.owner);requireThat(conn&&req.headers.host===new URL(conn.redirectUri).host,'feishu_oauth_invalid',400);await callback(url); ok=true; }
    catch { /* The callback page never echoes codes, state, provider messages or credentials. */ }
    res.writeHead(ok?200:400,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"});
    res.end(`<meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>聆记 · 飞书授权</title><style>body{font:16px system-ui;padding:10vh 8vw;color:#244637;background:#f2f6f2}h1{font-size:24px}</style><h1>${ok?'飞书已连接':'未完成飞书授权'}</h1><p>${ok?'可以关闭此页，返回聆记继续导出。':'请返回聆记检查应用权限与回调地址，然后重新授权。'}</p>`);
  }
  async function authorize(owner) {
    const conn=await load(owner);requireThat(conn?.credentials,'feishu_not_configured',409);
    requireThat(conn.redirectUri.startsWith('https:'),'feishu_https_callback_required',409);
    retire(owner);
    for(const [state,entry]of pending)if(entry.expires<=now()){pending.delete(state);entry.controller?.abort();void entry.relay?.close();}
    for(const [id,value]of authorizations)if(value.expires<=now())authorizations.delete(id);
    requireThat(pending.size<100,'feishu_authorization_busy',429);
    if(authorizations.size>=100)authorizations.delete(authorizations.keys().next().value);
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),controller=new AbortController();
    const challenge=createHash('sha256').update(verifier).digest('base64url'),entry={owner,state,generation:conn.generation,verifier,expires:now()+600000,controller};
    pending.set(state,entry);authorizations.set(owner,{state,status:'waiting',expires:entry.expires});
    try{
      await repo.change(conn.id,current=>{requireThat(pending.get(state)===entry&&!controller.signal.aborted,'feishu_oauth_expired',409);requireThat(current.generation===conn.generation,'feishu_connection_changed',409);current.authorizationAttempt=digest(state);});
      requireThat(pending.get(state)===entry&&!controller.signal.aborted,'feishu_oauth_expired',409);
    }catch(error){pending.delete(state);controller.abort();if(authorizations.get(owner)?.state===state)authorizations.set(owner,{state,status:'failed',error:error.code||'feishu_unavailable',expires:now()+600000});throw error;}
    if(conn.redirectUri===FEISHU_REDIRECT_URI){
      try{entry.relay=await openFeishuRelay({state,challenge,clientId:conn.appId,signal:AbortSignal.any([stopping.signal,controller.signal]),fetcher:relayFetch,now,pollMs:relayPollMs});entry.expires=entry.relay.expiresAt;}
      catch(error){pending.delete(state);if(authorizations.get(owner)?.state===state)authorizations.set(owner,{state,status:'failed',error:error.code||'feishu_relay_unavailable',expires:now()+600000});throw error;}
      const task=(async()=>{
        try{const code=await entry.relay.wait();requireThat(pending.get(state)===entry&&entry.expires>now(),'feishu_oauth_expired',409);entry.exchanging=true;await completeAuthorization(entry,code);}
        catch(error){pending.delete(state);if(authorizations.get(owner)?.state===state)authorizations.set(owner,{state,status:'failed',error:error instanceof DomainError?error.code:'feishu_relay_unavailable',expires:now()+600000});}
        finally{if(pending.get(state)===entry)pending.delete(state);entry.controller.abort();await entry.relay.close();}
      })();jobs.add(task);void task.finally(()=>jobs.delete(task));
    }
    const url=new URL(FEISHU_AUTHORIZE_URL);
    url.search=new URLSearchParams({client_id:conn.appId,response_type:'code',redirect_uri:conn.redirectUri,scope:FEISHU_SCOPES.join(' '),prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
    return {url:url.href,expiresAt:entry.expires};
  }
  async function cancelAuthorization(owner){const attempts=new Set([...pending.values()].filter(entry=>entry.owner===owner).map(entry=>digest(entry.state)));const status=authorizations.get(owner);if(status)attempts.add(digest(status.state));retire(owner);const conn=await load(owner);if(conn)await repo.change(conn.id,current=>{if(attempts.has(current.authorizationAttempt))delete current.authorizationAttempt;});return settings(owner);}
  async function disconnect(owner){abortConnection(owner);retire(owner);const conn=await load(owner);if(conn)await repo.change(conn.id,value=>{value.credentials=secrets.seal(value.id,{appSecret:open(value).appSecret});value.connected=false;delete value.identity;value.generation=randomUUID();});for(const [state,entry]of pending)if(entry.owner===owner)pending.delete(state);return settings(owner);}
  async function ownedRecord(owner,id){const record=await repo.get(id);requireThat(record?.kind==='record'&&record.owner===owner&&!record.deleted&&Date.parse(record.deleteAt)>now(),'record_not_found',404);return record;}
  async function ownedExport(owner,id){const value=await repo.get(id);requireThat(value?.kind==='feishu-export'&&value.owner===owner,'not_found',404);await ownedRecord(owner,value.recordId);return value;}
  async function preview(owner,recordId,input,automatic=false,id=randomUUID(),rule){
    const conn=await load(owner);requireThat(conn?.connected,'feishu_not_connected',409);
    const record=await ownedRecord(owner,recordId),snapshot=exportSnapshot(record,input);
    requireThat((await history(owner)).filter(value=>value.createdAt>now()-86400000).length<200,'feishu_export_limit',429);
    const draft=await repo.insert({id,kind:'feishu-export',owner,recordId,...snapshot,connectionGeneration:conn.generation,status:'draft',stage:'preview',createdAt:now(),updatedAt:now(),automatic,...(rule?{ruleGeneration:rule.generation}:{})});
    return {...publicExport(draft),markdown:draft.markdown};
  }
  async function get(owner,id){const value=await ownedExport(owner,id);if(value.status==='publishing'&&value.updatedAt<now()-180000)await repo.change(id,current=>{if(current.status==='publishing'&&current.updatedAt<now()-180000){current.status=current.documentId?'partial':'unknown';current.error='feishu_interrupted';current.updatedAt=now();}});const current=await ownedExport(owner,id);return {...publicExport(current),...(current.status==='draft'?{markdown:current.markdown}:{})};}
  async function run(owner,id){
    runningOwners.set(owner,(runningOwners.get(owner)||0)+1);
    let stage='convert';
    const update=patch=>repo.change(id,current=>Object.assign(current,patch,{updatedAt:now()}));
    try{
      const value=await ownedExport(owner,id),conn=await load(owner);
      requireThat(conn?.connected&&conn.generation===value.connectionGeneration,'feishu_connection_changed',409);
      const guard=async()=>{if(value.automatic){const rule=await repo.get(autoId(owner));requireThat(rule?.enabled&&rule.generation===value.ruleGeneration,'feishu_automation_changed',409);}await ownedRecord(owner,value.recordId);const current=await load(owner);requireThat(current?.connected&&current.generation===value.connectionGeneration,'feishu_connection_changed',409);};
      await guard();const signal=connectionSignal(owner,conn.generation);
      const token=await tokenFor(owner),converted=await request(`${api}/docx/v1/documents/blocks/convert`,{signal,token,body:{content_type:'markdown',content:value.markdown}});
      const blocks=feishuBlocks(converted.data);
      await guard();stage='create';await update({stage});
      const created=await request(`${api}/docx/v1/documents`,{signal,token,body:{title:value.title,...(value.folderToken?{folder_token:value.folderToken}:{})},write:true});
      const documentId=created.data?.document?.document_id;requireThat(documentToken(documentId),'feishu_write_unknown',502);
      stage='verify';await update({stage,documentId});
      const metadata=async()=>{
        const verified=await request(`${api}/drive/v1/metas/batch_query`,{signal,token,body:{request_docs:[{doc_token:documentId,doc_type:'docx'}],with_url:true}});
        const meta=verified.data?.metas?.find(item=>item.doc_token===documentId);
        let url;try{url=new URL(meta?.url);}catch{throw new DomainError('feishu_verification_failed',502);}
        requireThat(!verified.data?.failed_list?.some(item=>item.token===documentId)&&meta.doc_type==='docx'&&meta.title===value.title&&url.protocol==='https:'&&/(^|\.)feishu\.cn$/.test(url.hostname)&&!url.username&&!url.password&&!url.port&&url.pathname===`/docx/${documentId}`,'feishu_verification_failed',502);
        return url.href;
      };
      await update({url:await metadata()});
      await guard();stage='write';await update({stage});
      await request(`${api}/docx/v1/documents/${documentId}/blocks/${documentId}/descendant?document_revision_id=-1&client_token=${id}`,{signal,token,body:blocks,write:true});
      stage='verify';await update({stage});
      await update({status:'succeeded',stage:'completed',url:await metadata(),markdown:''});
    }catch(error){const value=await repo.get(id);await update({status:value.documentId?'partial':stage==='create'&&(error.uncertain||error.code==='feishu_write_unknown')?'unknown':'failed',stage,markdown:'',error:error instanceof DomainError?error.code:'feishu_unavailable'});}
    finally{const count=runningOwners.get(owner)-1;if(count)runningOwners.set(owner,count);else runningOwners.delete(owner);}
  }
  async function publish(owner,id,input){
    requireThat(input?.confirmed===true,'feishu_confirmation_required',400);
    const draft=await ownedExport(owner,id),conn=await load(owner);
    requireThat(conn?.connected&&conn.generation===draft.connectionGeneration,'feishu_connection_changed',409);
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
  async function automation(owner){const rule=await repo.get(autoId(owner));return {enabled:Boolean(rule?.enabled),folderToken:rule?.folderToken||'',includeNotes:Boolean(rule?.includeNotes),includeEvidence:rule?.includeEvidence!==false,connectionChanged:rule?.enabled&&(await load(owner))?.generation!==rule.connectionGeneration,recent:(await history(owner)).filter(item=>item.automatic).slice(0,10).map(publicExport)};}
  async function saveAutomation(owner,input){
    requireThat(typeof input?.enabled==='boolean','invalid_feishu_automation',400);
    const id=autoId(owner),current=await repo.get(id);
    if(!input.enabled){if(current)await repo.change(id,value=>{value.enabled=false;value.generation=randomUUID();});return automation(owner);}
    requireThat(input.confirmed===true&&typeof input.includeNotes==='boolean'&&typeof input.includeEvidence==='boolean','feishu_confirmation_required',400);
    const conn=await load(owner);requireThat(conn?.connected,'feishu_not_connected',409);
    const excluded=(await repo.listSummaries(owner,'all','')).filter(record=>record.capture==='completed').map(record=>record.id);
    const rule={id,kind:'feishu-auto-rule',owner,enabled:true,generation:randomUUID(),connectionGeneration:conn.generation,folderToken:feishuFolder(input.folderToken),includeNotes:input.includeNotes,includeEvidence:input.includeEvidence,excluded,enabledAt:now()};
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
          if(entry.createdAt<now()-3600000||!record||record.deleted||Date.parse(record.deleteAt)<=now())await repo.change(entry.id,value=>{if(value.status==='draft'){value.markdown='';value.status='failed';value.error='feishu_preview_stale';value.updatedAt=now();}});
        }
      }
      for(const rule of await repo.list('feishu-auto-rule')){
        const conn=await load(rule.owner);if(!rule.enabled||!conn?.connected||conn.generation!==rule.connectionGeneration||runningOwners.has(rule.owner))continue;
        for(const summary of await repo.listSummaries(rule.owner,'all','')){
          if(summary.capture!=='completed'||!summary.hasMinutes||rule.excluded.includes(summary.id))continue;
          const hash=digest(`${rule.generation}:${summary.id}`),id=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
          if(await repo.get(id))continue;
          const record=await ownedRecord(rule.owner,summary.id);
          const finalJob=record.jobs.filter(job=>job.scope!=='live').at(-1);
          if(!record.minutes||record.transcription!=='ready'||record.jobs.some(job=>['queued','running'].includes(job.status))||record.minutes.transcriptRevision!==record.transcriptRevision||finalJob?.status==='failed')continue;
          try{await preview(rule.owner,record.id,{title:record.title,folderToken:rule.folderToken,includeNotes:rule.includeNotes,includeEvidence:rule.includeEvidence},true,id,rule);await publish(rule.owner,id,{confirmed:true});break;}catch(error){if(!['already_exists','feishu_export_started'].includes(error.code))throw error;}
        }
      }
    }finally{autoBusy=false;}
  }
  autoTimer=setInterval(()=>{if(!autoBusy)autoWork=automaticTick().catch(()=>{});},Math.max(100,autoPollMs));autoTimer.unref();
  return {settings,configure,authorize,cancelAuthorization,disconnect,callbackResponse,preview,publish,get,automation,saveAutomation,automaticTick,
    async list(owner,recordId){await ownedRecord(owner,recordId);return (await history(owner,recordId,10)).map(publicExport);},
    async close(){clearInterval(autoTimer);stopping.abort();await autoWork;for(const owner of [...new Set([...pending.values()].map(entry=>entry.owner))])retire(owner);pending.clear();await Promise.allSettled(jobs);}
  };
}
