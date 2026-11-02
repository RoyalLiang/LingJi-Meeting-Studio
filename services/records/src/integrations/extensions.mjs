import { randomUUID } from 'node:crypto';
import { DomainError, digest, requireThat } from '../../../../packages/records/src/record.mjs';
import { remoteRequest, remoteUrl } from './remote-http.mjs';
import { createSecretStore } from './secret-store.mjs';

const text=(value,max)=>typeof value==='string'&&value.length<=max;
const publicItem=item=>Object.fromEntries(['id','type','name','description','source','provider','path','ref','version','enabled','tools','approvedTools','url','hasToken','updatedAt','warnings','networkMode'].filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
async function githubRequest(value,{headers}={}){
  const url=new URL(value);
  requireThat(url.origin==='https://api.github.com'&&url.pathname.startsWith('/repos/'),'invalid_skill_source',400);
  // Only this fixed, credential-free provider uses system DNS, including enterprise proxy fake-IP resolvers.
  const response=await fetch(url,{headers:{'User-Agent':'Lingji-Meeting-Studio',...headers},redirect:'error',signal:AbortSignal.timeout(20000)});
  const reader=response.body.getReader(),parts=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;requireThat(size<=2*1024*1024,'remote_response_too_large',502);parts.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return {status:response.status,headers:Object.fromEntries(response.headers),text:Buffer.concat(parts).toString('utf8')};
}
export function skillSource(input){
  let url;try{url=remoteUrl(input.source);}catch{throw new DomainError('invalid_skill_source',400);}
  const parts=url.pathname.replace(/\.git\/?$/,'').replace(/\/$/,'').split('/').filter(Boolean);
  const provider=input.provider||'github';
  requireThat(['github','gitlab'].includes(provider)&&!url.search&&parts.every(part=>/^[A-Za-z0-9_.-]{1,100}$/.test(part)&&!['.','..'].includes(part))&&(provider==='github'?url.hostname==='github.com'&&parts.length===2:!['github.com','api.github.com'].includes(url.hostname)&&parts.length>=2&&parts.length<=12),'invalid_skill_source',400);
  const path=input.path||'',ref=input.ref||'main';
  requireThat(text(path,300)&&(!path||path.split('/').every(part=>/^[A-Za-z0-9_.-]+$/.test(part)&&!['.','..'].includes(part)))&&text(ref,150)&&/^[A-Za-z0-9_./-]+$/.test(ref),'invalid_skill_source',400);
  return {source:`${url.origin}/${parts.join('/')}`,repo:parts.join('/'),path,ref,...(provider==='gitlab'?{provider}:{} )};
}
export function skillMetadata(content){
  requireThat(text(content,40000)&&content.startsWith('---\n'),'invalid_remote_skill',400);
  const end=content.indexOf('\n---',4);requireThat(end>0&&end<12000,'invalid_remote_skill',400);
  const front=content.slice(4,end),name=front.match(/^name:\s*([^\n]+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
  const raw=front.match(/^description:\s*([^\n]*)(?:\n((?:[ \t]+[^\n]*(?:\n|$))*))?/m);
  const description=(raw?.[1]?.match(/^[>|][-+]?$|^$/)?raw?.[2]:raw?.[1])?.trim().replace(/\s+/g,' ').replace(/^['"]|['"]$/g,'');
  requireThat(name&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)&&description&&description.length<=1024,'invalid_remote_skill',400);
  return {name,description};
}
function rpcResult(response,id){
  requireThat(response.status>=200&&response.status<300,'mcp_connection_failed',502);
  let data;
  try{if(String(response.headers['content-type']).includes('text/event-stream')){
    const messages=response.text.split(/\r?\n\r?\n/).map(event=>event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean).map(value=>JSON.parse(value));
    data=messages.find(item=>item.id===id);
  }else data=JSON.parse(response.text);}catch{throw new DomainError('invalid_mcp_response',502);}
  requireThat(data?.jsonrpc==='2.0'&&data.id===id&&!data.error&&data.result&&typeof data.result==='object','invalid_mcp_response',502);return data.result;
}

export async function createExtensions(repo,{request=remoteRequest,requestGithub=request===remoteRequest?githubRequest:request,localAccount=false}={}){
  const secrets=await createSecretStore(repo.root);
  const mcpRequest=(url,options)=>request(url,{...options,allowProxyFakeIp:localAccount===true});
  const get=async(owner,id)=>{const value=await repo.get(id);requireThat(value?.kind==='extension'&&value.owner===owner&&!value.deleted,'extension_not_found',404);return value;};
  const list=async owner=>(await repo.list('extension')).filter(item=>item.owner===owner&&!item.deleted).map(publicItem);
  async function github(url,shaOnly=false,token,optional=false){let result;try{result=await requestGithub(url,{headers:{Accept:shaOnly?'application/vnd.github.sha':'application/vnd.github+json',...(token?{Authorization:`Bearer ${token}`}:{})}});}catch{throw new DomainError('skill_download_failed',502);}if(optional&&result.status===404)return null;requireThat(![401,403,404].includes(result.status),'skill_access_denied',400);requireThat(result.status===200,'skill_download_failed',502);if(shaOnly&&/^[a-f0-9]{40}$/.test(result.text.trim()))return {sha:result.text.trim()};let value;try{value=JSON.parse(result.text);}catch{throw new DomainError('skill_download_failed',502);}return value;}
  async function gitlab(source,path,token,optional=false){
    const url=`${new URL(source.source).origin}/api/v4/projects/${encodeURIComponent(source.repo)}/repository/${path}`;
    // The desktop user selects this self-hosted GitLab; cloud and MCP requests stay public-only.
    let result;try{result=await request(url,{allowProxyFakeIp:localAccount===true,allowPrivateNetwork:localAccount===true,headers:{Accept:'application/json',...(token?{'PRIVATE-TOKEN':token}:{})}});}catch(error){if(error instanceof DomainError&&['remote_address_rejected','remote_redirect_rejected','remote_unavailable','remote_response_too_large'].includes(error.code))throw error;throw new DomainError('skill_download_failed',502);}
    if(optional&&result.status===404)return null;
    requireThat(![401,403,404].includes(result.status),'skill_access_denied',400);requireThat(result.status===200,'skill_download_failed',502);
    try{return JSON.parse(result.text);}catch{throw new DomainError('skill_download_failed',502);}
  }
  async function skillToken(input,owner,source){
    requireThat(text(input.token||'',16000)&&!/[^\x21-\x7e]/.test(input.token||''),'invalid_skill_token',400);
    if(input.extensionId){
      const current=await get(owner,input.extensionId);
      requireThat(current.type==='skill'&&current.source===source.source&&current.path===source.path,'invalid_skill_source',400);
      return input.token || (current.credentials?secrets.open(current.id,current.credentials).token:'');
    }
    return input.token||'';
  }
  async function skillPreview(input,owner){
    const source=skillSource(input),token=await skillToken(input,owner,source);
    const commit=source.provider==='gitlab'?{sha:(await gitlab(source,`commits/${encodeURIComponent(source.ref)}`,token)).id}:await github(`https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(source.ref)}`,true,token);
    requireThat(/^[a-f0-9]{40}$/.test(commit.sha),'skill_download_failed',502);
    const file=async(path,optional=false)=>{
      const value=source.provider==='gitlab'?await gitlab(source,`files/${encodeURIComponent(path)}?ref=${commit.sha}`,token,optional):await github(`https://api.github.com/repos/${source.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commit.sha}`,false,token,optional);
      if(value===null&&optional)return null;
      requireThat((source.provider==='gitlab'?value.file_path===path:value.type==='file')&&value.encoding==='base64'&&value.size<=120000&&typeof value.content==='string'&&/^[A-Za-z0-9+/=\r\n]+$/.test(value.content),'invalid_remote_skill',400);
      const content=Buffer.from(value.content,'base64').toString('utf8').replace(/\r\n/g,'\n');requireThat(Buffer.byteLength(content)<=120000,'invalid_remote_skill',400);return content;
    };
    const content=await file(`${source.path?source.path+'/':''}SKILL.md`,true);
    if(content===null){
      const entries=source.provider==='gitlab'?await gitlab(source,`tree?path=${encodeURIComponent(source.path)}&ref=${commit.sha}&per_page=100`,token):await github(`https://api.github.com/repos/${source.repo}/contents/${source.path.split('/').map(encodeURIComponent).join('/')}?ref=${commit.sha}`,false,token);
      requireThat(Array.isArray(entries)&&entries.length<=100,'invalid_remote_skill',400);
      const prefix=source.path?source.path+'/':'';
      const choices=entries.filter(entry=>['tree','dir'].includes(entry.type)&&typeof entry.name==='string'&&/^[A-Za-z0-9_.-]+$/.test(entry.name)&&!['.','..'].includes(entry.name)&&entry.path===prefix+entry.name).map(({name,path})=>({name,path}));
      requireThat(choices.length>0,'skill_directory_required',400);
      return {...source,version:commit.sha,choices};
    }
    const metadata=skillMetadata(content),references=[];
    const paths=[...new Set([...content.matchAll(/\[[^\]]+\]\(([^\s)]+\.md)(?:#[^)]*)?\)/g)].map(match=>match[1].replace(/^\.\//,'')))].filter(path=>!/^https?:/.test(path));
    requireThat(paths.length<=10,'invalid_remote_skill',400);
    for(const path of paths){
      if(/^https?:/.test(path))continue;
      requireThat(path.split('/').every(part=>/^[A-Za-z0-9_.-]+$/.test(part)&&!['.','..'].includes(part)),'invalid_remote_skill',400);
      references.push({path,content:await file(`${source.path?source.path+'/':''}${path}`)});
    }
    const guidance=content+references.map(item=>`\n\n--- Reference: ${item.path} ---\n${item.content}`).join('');
    requireThat(guidance.length<=40000,'invalid_remote_skill',400);
    return {...source,...metadata,version:commit.sha,content:guidance,warnings:['仅加载 Skill 与直接引用的 Markdown 指引；不执行仓库脚本、安装依赖或扩大会议读取权限。']};
  }
  async function installSkill(owner,input){
    requireThat(input.confirmed===true&&/^[a-f0-9]{40}$/.test(input.expectedVersion),'extension_confirmation_required',400);
    const requested=skillSource(input),token=await skillToken(input,owner,requested),value=await skillPreview({...requested,token,ref:input.expectedVersion},owner);
    requireThat(typeof value.content==='string'&&!value.choices,'skill_directory_required',400);
    requireThat(value.version===input.expectedVersion,'extension_version_changed',409);
    const id=`extension:${digest(`${owner}:skill:${value.source}:${value.path}`)}`,current=await repo.get(id);
    const next={id,kind:'extension',type:'skill',owner,...value,ref:requested.ref,enabled:false,hasToken:Boolean(token),...(token?{credentials:secrets.seal(id,{token})}:{}),updatedAt:Date.now()};
    if(current)await repo.change(id,item=>{Object.assign(item,next);if(!token)delete item.credentials;delete item.deleted;});else await repo.insert(next);
    return publicItem(next);
  }
  async function mcpSession(plugin,operation,signal){
    signal?.throwIfAborted();
    signal=AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])]);
    const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(plugin.credentials?{Authorization:`Bearer ${secrets.open(plugin.id,plugin.credentials).token}`}:{})};
    let session,protocol='2025-11-25';
    const call=async(method,params,id=randomUUID())=>{
      const response=await mcpRequest(plugin.url,{method:'POST',headers:{...headers,...(session?{'Mcp-Session-Id':session}:{}),...(method==='initialize'?{}:{'MCP-Protocol-Version':protocol})},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal,rpcId:id});
      if(method==='initialize'){session=response.headers['mcp-session-id'];requireThat(!session||typeof session==='string'&&/^[\x21-\x7e]{1,512}$/.test(session),'invalid_mcp_response',502);}
      return rpcResult(response,id);
    };
    try{
      const initialized=await call('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'lingji-meeting-studio',version:'1'}});
      requireThat(['2025-11-25','2025-06-18','2025-03-26'].includes(initialized.protocolVersion),'mcp_protocol_unsupported',400);protocol=initialized.protocolVersion;
      const notified=await mcpRequest(plugin.url,{method:'POST',headers:{...headers,'MCP-Protocol-Version':protocol,...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}),signal});
      requireThat(notified.status>=200&&notified.status<300,'mcp_connection_failed',502);
      return await operation(call);
    }finally{if(session)await mcpRequest(plugin.url,{method:'DELETE',headers:{...headers,'Mcp-Session-Id':session,'MCP-Protocol-Version':protocol},signal}).catch(()=>{});}
  }
  async function discover(plugin){
    return mcpSession(plugin,async call=>{
      const tools=[],seen=new Set();let cursor,pages=0;
      do{requireThat(++pages<=10&&!seen.has(cursor),'invalid_mcp_response',502);seen.add(cursor);const value=await call('tools/list',cursor?{cursor}:{});requireThat(Array.isArray(value.tools),'invalid_mcp_response',502);
        for(const tool of value.tools){requireThat(text(tool.name,100)&&tool.name&&text(tool.description||'',4000)&&tool.inputSchema?.type==='object'&&JSON.stringify(tool.inputSchema).length<20000,'invalid_mcp_response',502);tools.push({name:tool.name,description:tool.description||'',inputSchema:tool.inputSchema,readOnly:tool.annotations?.readOnlyHint===true});}
        requireThat(tools.length<=100&&new Set(tools.map(tool=>tool.name)).size===tools.length,'mcp_tool_limit',400);cursor=value.nextCursor;requireThat(cursor===undefined||text(cursor,1000)&&value.tools.length>0,'invalid_mcp_response',502);
      }while(cursor);
      return tools;
    });
  }
  async function installPlugin(owner,input){
    requireThat(input.confirmed===true&&text(input.name,80)&&input.name.trim()&&text(input.token||'',16000)&&!/[\r\n]/.test(input.token||''),'invalid_mcp_config',400);
    const target=remoteUrl(input.url);requireThat(!target.search,'invalid_mcp_config',400);
    const url=target.href,id=`extension:${randomUUID()}`;
    const plugin={id,kind:'extension',type:'mcp',owner,networkMode:localAccount?'desktop-proxy':'public-dns',name:input.name.trim(),url,enabled:false,approvedTools:[],version:randomUUID(),hasToken:Boolean(input.token),updatedAt:Date.now()};
    if(input.token)plugin.credentials=secrets.seal(id,{token:input.token});
    plugin.tools=await discover(plugin);await repo.insert(plugin);return publicItem(plugin);
  }
  async function check(owner,id){const plugin=await get(owner,id);requireThat(plugin.type==='mcp','invalid_extension',400);const tools=await discover(plugin);return repo.change(id,item=>{item.tools=tools;item.enabled=false;item.approvedTools=[];item.version=randomUUID();item.updatedAt=Date.now();return publicItem(item);});}
  async function change(owner,id,input){
    await get(owner,id);requireThat(typeof input.enabled==='boolean','invalid_extension',400);
    return repo.change(id,item=>{
      requireThat(item.owner===owner&&!item.deleted,'extension_not_found',404);
      if(input.enabled)requireThat(input.expectedVersion===item.version,'extension_version_changed',409);
      if(item.type==='mcp'&&input.enabled){requireThat(Array.isArray(input.approvedTools)&&input.approvedTools.length>0&&input.approvedTools.every(name=>item.tools.some(tool=>tool.name===name&&tool.readOnly)),'mcp_readonly_tools_required',400);item.approvedTools=[...new Set(input.approvedTools)];}
      item.enabled=input.enabled;item.updatedAt=Date.now();return publicItem(item);
    });
  }
  async function remove(owner,id){await get(owner,id);await repo.change(id,item=>{item.deleted=true;item.enabled=false;delete item.credentials;delete item.content;item.tools=[];});return {deleted:true};}
  async function snapshot(owner,input={}){
    const skillId=input.skillId||'meeting-review',pluginIds=input.pluginIds||[];
    requireThat(Array.isArray(pluginIds)&&pluginIds.length<=3&&new Set(pluginIds).size===pluginIds.length&&pluginIds.every(id=>typeof id==='string'),'invalid_extension_scope',400);
    const skill=skillId==='meeting-review'?{id:'meeting-review',name:'会议复盘',version:'1.0.0',content:''}:await get(owner,skillId);
    requireThat(skill.id==='meeting-review'||skill.type==='skill'&&skill.enabled,'extension_disabled',409);
    requireThat(skill.id==='meeting-review'||input.skillVersion===skill.version,'extension_version_changed',409);
    requireThat(!pluginIds.length||input.remoteToolsConfirmed===true,'mcp_scope_required',400);
    const plugins=[];for(const id of pluginIds){const plugin=await get(owner,id);requireThat(plugin.type==='mcp'&&plugin.enabled,'extension_disabled',409);requireThat(input.pluginVersions?.[id]===plugin.version,'extension_version_changed',409);plugins.push({id,name:plugin.name,version:plugin.version,url:plugin.url,tools:plugin.tools.filter(tool=>plugin.approvedTools.includes(tool.name))});}
    requireThat(!plugins.length||input.remoteToolsConfirmed===true,'mcp_scope_required',400);
    return {skill:{id:skill.id,name:skill.name,version:skill.version,content:skill.content},plugins};
  }
  async function validate(owner,snapshot){
    if(!snapshot)return;
    if(snapshot.skill.id!=='meeting-review'){const skill=await get(owner,snapshot.skill.id);requireThat(skill.enabled&&skill.version===snapshot.skill.version,'extension_version_changed',409);}
    for(const expected of snapshot.plugins){const plugin=await get(owner,expected.id);requireThat(plugin.enabled&&plugin.version===expected.version&&expected.tools.every(tool=>plugin.approvedTools.includes(tool.name)),'extension_version_changed',409);}
  }
  async function call(owner,snapshot,{pluginId,toolName,arguments:args},signal,beforeCall){
    await validate(owner,snapshot);const selected=snapshot?.plugins.find(item=>item.id===pluginId);
    requireThat(selected?.tools.some(tool=>tool.name===toolName)&&args&&typeof args==='object'&&!Array.isArray(args)&&JSON.stringify(args).length<=20000,'mcp_scope_required',400);
    const plugin=await get(owner,pluginId);
    return mcpSession(plugin,async call=>{
      await validate(owner,snapshot);await beforeCall?.();
      const output=await call('tools/call',{name:toolName,arguments:args});
      requireThat(!output.isError&&Array.isArray(output.content),'mcp_tool_failed',502);
      const content=output.content.filter(item=>item.type==='text'&&typeof item.text==='string').map(item=>item.text).join('\n');
      requireThat(content.length>0&&content.length<=40000,'mcp_result_too_large',502);return content;
    },signal);
  }
  return {list,skillPreview,installSkill,installPlugin,check,change,remove,snapshot,validate,call};
}
