import assert from 'node:assert/strict';
import {DomainError} from '../../packages/records/src/record.mjs';
export const source='https://git.example.test/root',baseSha='a'.repeat(40),writeSha='b'.repeat(40);
export const projects=[{id:10,name:'浦东机场',path:'root/airport/pudong',path_with_namespace:'root/airport/pudong',namespace:{id:2,full_path:'root/airport'},default_branch:'main',web_url:source+'/airport/pudong'},{id:20,name:'PSA',path:'root/psa/operations',path_with_namespace:'root/psa/operations',namespace:{id:3,full_path:'root/psa'},default_branch:'main'}];
export function gitRemoteFixture(expectedPrivate=true){
  const branches=new Map([['main',baseSha]]),files=new Map(),mrs=[],writes=[],tokens=new Set(['synthetic-git-token']),readonly=new Set();let timeout=false,forbidden=false,onRead,commitCount=0;
  return {branches,files,mrs,writes,allowToken(token,readOnly=false){tokens.add(token);if(readOnly)readonly.add(token);},onRead(fn){onRead=fn;},timeoutAfterCommit(){timeout=true;},denyWrites(value=true){forbidden=value;},async request(value,options){
    const url=new URL(value),path=decodeURIComponent(url.pathname.replace('/api/v4','')),body=options.body&&JSON.parse(options.body);assert.equal(url.origin,'https://git.example.test');assert.ok(tokens.has(options.headers['PRIVATE-TOKEN']));assert.equal(options.allowPrivateNetwork,expectedPrivate);
    const ok=data=>({status:200,headers:{},text:JSON.stringify(data)}),missing=()=>({status:404,headers:{},text:'{}'});
    if(options.method==='GET'&&onRead){const result=await onRead(path,options);if(result)return result;}
    if(options.method!=='GET'){writes.push({path,body,token:options.headers['PRIVATE-TOKEN']});if(forbidden||readonly.has(options.headers['PRIVATE-TOKEN']))return {status:403,headers:{},text:'{}'};}
    if(/^\/groups\/(root|1)$/.test(path))return ok({id:1,full_path:'root'});
    if(path==='/groups/1/projects')return ok(projects);
    const project=path.match(/^\/projects\/(10|20)$/);if(project)return ok(projects.find(p=>p.id===Number(project[1])));
    const branch=path.match(/^\/projects\/\d+\/repository\/branches(?:\/(.+))?$/);
    if(branch){if(options.method==='POST'){branches.set(body.branch,body.ref);return ok({name:body.branch,commit:{id:body.ref}});}return branches.has(branch[1])?ok({name:branch[1],commit:{id:branches.get(branch[1])}}):missing();}
    const file=path.match(/^\/projects\/\d+\/repository\/files\/(.+)$/);
    if(file){const ref=url.searchParams.get('ref'),name=branches.has(ref)?ref:[...branches].find(([,sha])=>sha===ref)?.[0],content=files.get(`${name}:${file[1]}`);return content===undefined?missing():ok({encoding:'base64',content:Buffer.from(content).toString('base64'),last_commit_id:writeSha});}
    if(path.endsWith('/repository/commits')){const commitSha=(11+commitCount++).toString(16).repeat(40);for(const action of body.actions){assert.equal(action.action,'create');assert.ok(!files.has(`${body.branch}:${action.file_path}`));files.set(`${body.branch}:${action.file_path}`,action.content);}branches.set(body.branch,commitSha);if(timeout){timeout=false;throw new DomainError('remote_unavailable',502);}return ok({id:commitSha});}
    if(path.endsWith('/merge_requests')){if(options.method==='POST'){const mr={iid:mrs.length+1,state:'opened',source_branch:body.source_branch,target_branch:body.target_branch,web_url:'https://git.example.test/'+projects.find(p=>path.startsWith(`/projects/${p.id}/`)).path+'/-/merge_requests/'+(mrs.length+1)};mrs.push(mr);return ok(mr);}return ok(mrs.filter(m=>m.source_branch===url.searchParams.get('source_branch')&&m.target_branch===url.searchParams.get('target_branch')));}
    throw Error('Unexpected fixture path '+path);
  }};
}
