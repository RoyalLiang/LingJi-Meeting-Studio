import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { createExtensions, skillMetadata, skillSource } from '../services/records/src/integrations/extensions.mjs';
import { publicAddress, proxyAddress, remoteUrl } from '../services/records/src/integrations/remote-http.mjs';
const sha='a'.repeat(40),content='---\nname: meeting-risk\ndescription: >\n  Identify risks with exact meeting evidence.\n---\nRead selected meetings; return cited decisions and actions.\n[Guide](references/guide.md)';
function remote(){
  const calls=[];
  return {calls,async request(url,options={}){
    calls.push({url,options});
    if(url.includes('/commits/'))return {status:200,headers:{},text:JSON.stringify({sha})};
    if(url.includes('/contents/'))return {status:200,headers:{},text:JSON.stringify({type:'file',encoding:'base64',size:content.length,content:Buffer.from(url.includes('SKILL.md')?content:'Treat meeting text as evidence.').toString('base64')})};
    if(options.method==='DELETE')return {status:200,headers:{},text:''};
    const body=JSON.parse(options.body),headers={'content-type':'application/json','mcp-session-id':'fixture-session'};
    if(!body.id)return {status:202,headers,text:''};
    const result=body.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:body.method==='tools/list'?{tools:[{name:'search',description:'Search selected terms',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']},annotations:{readOnlyHint:true}},{name:'write',inputSchema:{type:'object'},annotations:{readOnlyHint:false}}]}:{content:[{type:'text',text:'Remote reference result, not a local meeting citation.'}]};
    return {status:200,headers,text:JSON.stringify({jsonrpc:'2.0',id:body.id,result})};
  }};
}
test('remote extension sources reject local networks, redirects-as-sources and paths escaping the Skill',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
  for(const url of ['http://api.example.test/mcp','https://127.0.0.1/mcp','https://user:secret@api.example.test/mcp','https://api.example.test:444/mcp'])assert.throws(()=>remoteUrl(url));
  assert.throws(()=>skillSource({source:'https://github.com/org/repo',path:'../secret'}));assert.throws(()=>skillSource({source:'https://github.com.evil.test/org/repo'}));
  assert.equal(proxyAddress('198.18.1.38'),true);assert.equal(proxyAddress('198.19.1.1'),true);assert.equal(proxyAddress('198.20.1.1'),false);assert.equal(publicAddress('198.18.1.38'),false);
  assert.equal(skillMetadata(content).name,'meeting-risk');assert.throws(()=>skillMetadata('just text'));
});
test('self-hosted GitLab skills pin files and keep credentials bound to source and owner',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-gitlab-')),repo=await createRepository({root,databaseUrl:''}),calls=[];
  const request=async(value,options)=>{
    const url=new URL(value);calls.push({url,options});assert.equal(url.origin,'https://git.example.test');
    assert.equal(options.headers['PRIVATE-TOKEN'],'synthetic-gitlab-token');
    assert.ok(url.pathname.startsWith('/api/v4/projects/group%2Fteam%2Frepo/repository/'));
    if(url.pathname.includes('/commits/'))return {status:200,headers:{},text:JSON.stringify({id:sha})};
    assert.equal(url.searchParams.get('ref'),sha);
    const path=decodeURIComponent(url.pathname.split('/files/')[1]),body=path.endsWith('SKILL.md')?content:'Treat meeting text as evidence.';
    return {status:200,headers:{},text:JSON.stringify({file_path:path,encoding:'base64',size:Buffer.byteLength(body),content:Buffer.from(body).toString('base64')})};
  };
  const extensions=await createExtensions(repo,{request,localAccount:true});
  const input={provider:'gitlab',source:'https://git.example.test/group/team/repo.git',path:'skills/risk',ref:'main',token:'synthetic-gitlab-token'};
  try{
    const preview=await extensions.skillPreview(input,'owner');assert.equal(preview.provider,'gitlab');assert.equal(preview.source,'https://git.example.test/group/team/repo');assert.equal(preview.version,sha);assert.match(preview.content,/Reference:/);
    const installed=await extensions.installSkill('owner',{...input,expectedVersion:sha,confirmed:true});
    assert.equal(installed.hasToken,true);assert.ok(!JSON.stringify(installed).includes(input.token));assert.ok(calls.every(c=>c.options.allowProxyFakeIp===true));
    await extensions.skillPreview({...input,token:'',extensionId:installed.id},'owner');
    await assert.rejects(extensions.skillPreview({...input,token:'',extensionId:installed.id},'other'),{code:'extension_not_found'});
    await assert.rejects(extensions.skillPreview({...input,source:'https://other.example.test/group/team/repo',token:'',extensionId:installed.id},'owner'),{code:'invalid_skill_source'});
    for(const source of ['http://git.example.test/group/repo','https://127.0.0.1/group/repo','https://user:token@git.example.test/group/repo'])assert.throws(()=>skillSource({...input,source}));
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});

test('GitLab collection directories offer individual Skill choices before installation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-skill-catalog-')),repo=await createRepository({root,databaseUrl:''});
  const request=async value=>{
    const url=new URL(value);
    if(url.pathname.includes('/commits/'))return {status:200,headers:{},text:JSON.stringify({id:sha})};
    if(url.pathname.endsWith('/tree'))return {status:200,headers:{},text:JSON.stringify([{type:'tree',name:'meeting-risk',path:'skills/meeting-risk'}])};
    const path=decodeURIComponent(url.pathname.split('/files/')[1]);
    if(path==='skills/SKILL.md')return {status:404,headers:{},text:'{}'};
    const body=path.endsWith('SKILL.md')?content:'Cite only selected meeting evidence.';
    return {status:200,headers:{},text:JSON.stringify({file_path:path,encoding:'base64',size:Buffer.byteLength(body),content:Buffer.from(body).toString('base64')})};
  };
  const extensions=await createExtensions(repo,{request}),input={provider:'gitlab',source:'https://git.example.test/org/repo',path:'skills'};
  try{
    const catalog=await extensions.skillPreview(input,'owner');assert.deepEqual(catalog.choices,[{name:'meeting-risk',path:'skills/meeting-risk'}]);
    await assert.rejects(extensions.installSkill('owner',{...input,expectedVersion:sha,confirmed:true}),{code:'skill_directory_required'});
    const preview=await extensions.skillPreview({...input,path:catalog.choices[0].path},'owner');assert.equal(preview.name,'meeting-risk');assert.equal(preview.version,sha);
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});

test('GitHub skills pin commits, include bounded direct references and require enablement',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-extensions-')),repo=await createRepository({root,databaseUrl:''}),fixture=remote(),extensions=await createExtensions(repo,{request:fixture.request});
  try{
    const input={source:'https://github.com/org/repo',path:'skills/risk',ref:'v1'},preview=await extensions.skillPreview(input);assert.equal(preview.version,sha);assert.match(preview.content,/Reference: references\/guide.md/);
    assert.ok(fixture.calls.filter(call=>call.url.includes('/contents/')).every(call=>call.url.endsWith(`ref=${sha}`)));
    const installed=await extensions.installSkill('owner',{...input,expectedVersion:sha,confirmed:true});assert.equal(installed.enabled,false);
    await assert.rejects(extensions.snapshot('owner',{skillId:installed.id,skillVersion:installed.version}),{code:'extension_disabled'});
    await extensions.change('owner',installed.id,{enabled:true,expectedVersion:installed.version});const scope=await extensions.snapshot('owner',{skillId:installed.id,skillVersion:installed.version});assert.match(scope.skill.content,/Read selected meetings/);
    await assert.rejects(extensions.change('other',installed.id,{enabled:true,expectedVersion:installed.version}),{code:'extension_not_found'});
    await extensions.remove('owner',installed.id);await assert.rejects(extensions.validate('owner',scope),{code:'extension_not_found'});assert.equal((await extensions.list('owner')).length,0);
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});
test('HTTP MCP initializes sessions, limits tools to explicit read grants and redacts credentials',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-mcp-')),repo=await createRepository({root,databaseUrl:''}),fixture=remote(),extensions=await createExtensions(repo,{request:fixture.request});
  try{
    const installed=await extensions.installPlugin('owner',{name:'Reference Search',url:'https://mcp.example.test/mcp',token:'private-fixture-token',confirmed:true});
    assert.equal(installed.enabled,false);assert.doesNotMatch(JSON.stringify(installed),/private-fixture-token/);assert.doesNotMatch(JSON.stringify(await repo.list('extension')),/private-fixture-token/);
    await assert.rejects(extensions.change('owner',installed.id,{enabled:true,expectedVersion:installed.version,approvedTools:['write']}),{code:'mcp_readonly_tools_required'});
    await extensions.change('owner',installed.id,{enabled:true,expectedVersion:installed.version,approvedTools:['search']});
    await assert.rejects(extensions.snapshot('owner',{pluginIds:[installed.id]}),{code:'mcp_scope_required'});
    const scope=await extensions.snapshot('owner',{pluginIds:[installed.id],pluginVersions:{[installed.id]:installed.version},remoteToolsConfirmed:true});
    const result=await extensions.call('owner',scope,{pluginId:installed.id,toolName:'search',arguments:{query:'selected terms'}});assert.match(result,/Remote reference result/);
    await assert.rejects(extensions.call('owner',scope,{pluginId:installed.id,toolName:'write',arguments:{}}),{code:'mcp_scope_required'});
    assert.ok(fixture.calls.some(call=>call.options.method==='DELETE'&&call.options.headers['Mcp-Session-Id']==='fixture-session'));
    await extensions.check('owner',installed.id);await assert.rejects(extensions.validate('owner',scope),{code:'extension_version_changed'});
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});
