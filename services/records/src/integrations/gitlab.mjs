import {DomainError,requireThat} from '../../../../packages/records/src/record.mjs';
import {gitRoot,inGitRoot} from '../../../../packages/records/src/git-sync.mjs';
import {remoteRequest,remoteUrl} from './remote-http.mjs';

export function createGitlab({request=remoteRequest,localAccount=false}={}){
  async function call(connection,path,{method='GET',body,optional=false,signal,beforeWrite}={}){
    remoteUrl(connection.root);const root=gitRoot(connection.root);
    if(method!=='GET'){requireThat(typeof beforeWrite==='function','git_confirmation_required',400);await beforeWrite();signal?.throwIfAborted();}
    let response;try{response=await request(`${root.origin}/api/v4${path}`,{method,signal,allowPrivateNetwork:localAccount===true,allowProxyFakeIp:localAccount===true,headers:{Accept:'application/json','Content-Type':'application/json',...(connection.token?{'PRIVATE-TOKEN':connection.token}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch(error){if(method!=='GET')throw new DomainError('git_result_unknown',502);throw new DomainError(['remote_address_rejected','remote_redirect_rejected'].includes(error.code)?error.code:'remote_unavailable',502);}
    if(optional&&response.status===404)return null;
    requireThat(![401,403].includes(response.status),method==='GET'?'git_access_denied':'git_write_forbidden',403);
    requireThat(response.status!==429,'git_rate_limited',429);
    requireThat(response.status>=200&&response.status<300,method==='GET'?'git_access_failed':response.status===400||response.status===409?'git_write_conflict':'git_result_unknown',502);
    let data;try{data=JSON.parse(response.text);}catch{throw new DomainError(method==='GET'?'git_invalid_response':'git_result_unknown',502);}
    return data;
  }
  async function catalog(connection,signal){
    const root=gitRoot(connection.root),group=await call(connection,`/groups/${encodeURIComponent(root.path)}`,{signal});
    requireThat(Number.isSafeInteger(group.id)&&group.full_path===root.path,'git_invalid_response',502);
    const projects=[];
    for(let page=1;page<=11;page++){
      const values=await call(connection,`/groups/${group.id}/projects?include_subgroups=true&with_shared=false&per_page=100&page=${page}`,{signal});
      requireThat(Array.isArray(values),'git_invalid_response',502);
      for(const p of values){requireThat(Number.isSafeInteger(p.id)&&typeof p.name==='string'&&typeof p.path_with_namespace==='string'&&typeof p.namespace?.full_path==='string','git_invalid_response',502);if(inGitRoot(p,group))projects.push({id:p.id,name:p.name,path:p.path_with_namespace,namespace:p.namespace,default_branch:p.default_branch,web_url:p.web_url});}
      requireThat(projects.length<=1000&&page<=10,'git_catalog_limit',400);
      if(values.length<100)return {group:{id:group.id,full_path:group.full_path},projects};
    }
  }
  async function project(connection,id,root,signal){const currentRoot=await call(connection,`/groups/${root.id}`,{signal});requireThat(currentRoot.id===root.id&&currentRoot.full_path===root.full_path,'git_target_unavailable',409);const value=await call(connection,`/projects/${id}`,{signal});requireThat(value.id===id&&inGitRoot(value,root),'git_target_unavailable',409);requireThat(typeof value.default_branch==='string'&&value.default_branch,value.empty_repo===true?'git_repository_empty':'git_default_branch_missing',409);return value;}
  const branch=(c,id,name,signal)=>call(c,`/projects/${id}/repository/branches/${encodeURIComponent(name)}`,{optional:true,signal});
  const file=(c,id,path,ref,signal)=>call(c,`/projects/${id}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,{optional:true,signal});
  async function commit(connection,job,signal,beforeWrite){
    const {id}=job.project,prefix=`/projects/${id}`;
    const target=await project(connection,id,job.rootGroup,signal);
    const base=await branch(connection,id,job.baseBranch,signal);
    requireThat(base||target.empty_repo===true,'git_default_branch_missing',409);
    requireThat(base||job.mode==='direct','git_repository_empty',409);
    requireThat(!base||/^[a-f0-9]{40}$/.test(base.commit?.id),'git_invalid_response',502);
    const baseFiles=base?await Promise.all(Object.keys(job.files).map(path=>file(connection,id,path,base.commit.id,signal))):[];
    if(base&&baseFiles.every((f,i)=>f?.encoding==='base64'&&Buffer.from(f.content,'base64').toString('utf8')===Object.values(job.files)[i]))return {commit:base.commit.id,integrated:true};
    requireThat(!baseFiles.some(Boolean),'git_archive_exists',409);
    let head=await branch(connection,id,job.branch,signal);
    if(!head&&base){
      // Reject pre-existing archive files; never overwrite human-maintained repository content.
      head=await call(connection,`${prefix}/repository/branches`,{method:'POST',body:{branch:job.branch,ref:base.commit.id},signal,beforeWrite});
    }
    const existing=await Promise.all(Object.keys(job.files).map(path=>file(connection,id,path,job.branch,signal)));
    if(existing.some(Boolean)){
      requireThat(existing.every((f,i)=>f&&f.encoding==='base64'&&Buffer.from(f.content,'base64').toString('utf8')===Object.values(job.files)[i]),'git_write_conflict',409);
    }else{
      // Persisted branch + immutable file content make a replay reconcile before sending again.
      await call(connection,`${prefix}/repository/commits`,{method:'POST',body:{branch:job.branch,commit_message:`${job.commitMessage||`docs: archive meeting ${job.recordId}`}\n\nLingji-Task: ${job.id}`,actions:Object.entries(job.files).map(([file_path,content])=>({action:'create',file_path,content}))},signal,beforeWrite});
    }
    const final=await branch(connection,id,job.branch,signal);requireThat(/^[a-f0-9]{40}$/.test(final?.commit?.id),'git_result_unknown',502);
    const verified=await Promise.all(Object.keys(job.files).map(path=>file(connection,id,path,final.commit.id,signal)));
    requireThat(verified.every((f,i)=>f?.encoding==='base64'&&Buffer.from(f.content,'base64').toString('utf8')===Object.values(job.files)[i]),'git_result_unknown',502);
    return {commit:final.commit.id};
  }
  async function mergeRequest(connection,job,signal,beforeWrite){
    await project(connection,job.project.id,job.rootGroup,signal);
    const prefix=`/projects/${job.project.id}/merge_requests`,existing=await call(connection,`${prefix}?source_branch=${encodeURIComponent(job.branch)}&target_branch=${encodeURIComponent(job.baseBranch)}&scope=all&per_page=100`,{signal});
    requireThat(Array.isArray(existing)&&existing.length<=1,'git_write_conflict',409);
    const mr=existing[0]||await call(connection,prefix,{method:'POST',body:{source_branch:job.branch,target_branch:job.baseBranch,title:job.mergeTitle||`会议归档：${job.title}`.slice(0,200),description:`Lingji-Task: ${job.id}\n会议 ${job.recordId} · 纪要 v${job.minutesRevision}`,remove_source_branch:false},signal,beforeWrite});
    requireThat(Number.isSafeInteger(mr.iid)&&mr.source_branch===job.branch&&mr.target_branch===job.baseBranch&&['opened','merged'].includes(mr.state),'git_write_conflict',409);
    const url=new URL(mr.web_url);requireThat(url.origin===gitRoot(connection.root).origin&&url.pathname.startsWith(`/${job.project.path}/-/merge_requests/`),'git_invalid_response',502);
    return {url:url.href,iid:mr.iid};
  }
  async function readFile(connection,job,path,signal){
    await project(connection,job.project.id,job.rootGroup,signal);const value=await file(connection,job.project.id,path,job.baseBranch,signal);
    if(!value)return {path,exists:false};requireThat(value.encoding==='base64'&&typeof value.content==='string'&&value.content.length<=160000,'git_archive_too_large',413);return {path,exists:true,content:Buffer.from(value.content,'base64').toString('utf8')};
  }
  async function listFiles(connection,job,path,page,signal){
    requireThat(Number.isSafeInteger(page)&&page>=0&&page<10,'invalid_git_sync',400);await project(connection,job.project.id,job.rootGroup,signal);
    const values=await call(connection,`/projects/${job.project.id}/repository/tree?ref=${encodeURIComponent(job.baseBranch)}&path=${encodeURIComponent(path)}&per_page=100&page=${page+1}`,{signal});requireThat(Array.isArray(values)&&values.length<=100&&values.every(item=>typeof item.path==='string'&&typeof item.name==='string'&&['tree','blob'].includes(item.type)),'git_invalid_response',502);
    return {files:values.map(({path,name,type})=>({path,name,type})),...(values.length===100?{nextPage:page+1}:{})};
  }
  return {catalog,readFile,listFiles,project,commit,mergeRequest};
}
