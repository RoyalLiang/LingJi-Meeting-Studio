import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordServer } from '../services/records/src/server.mjs';

test('real Pi uses pinned Skill, selected notes and explicitly approved MCP tool without modifying minutes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-agent-ext-')),sha='a'.repeat(40);let app,record,pluginId,calls=0,remoteCalls=0,bigTools=false;
  const model=http.createServer(async(req,res)=>{
    const bytes=[];for await(const part of req)bytes.push(part);const body=JSON.parse(Buffer.concat(bytes).toString()),wire=JSON.stringify(body.messages);calls++;
    assert.match(wire,/meeting-risk/);
    let answer;
    if(calls===1)answer={toolCalls:[{name:'read_selected_meeting',arguments:{recordId:record.id}}]};
    else if(calls===2){assert.match(wire,/saved-notes-for-this-scope/);answer={toolCalls:[{name:'call_selected_mcp',arguments:{pluginId,toolName:'search',input:'{"query":"release"}'}}]};}
    else{assert.match(wire,/bounded-remote-reference/);answer={result:{summary:'整理了本场会议。',decisions:[{text:'周五评审',evidence:[{recordId:record.id,segmentId:record.segments[0].id,revision:1}]}],actions:[]}};}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}));
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const requestRemote=async(url,options={})=>{
    if(url.includes('/commits/'))return {status:200,headers:{},text:JSON.stringify({sha})};
    if(url.includes('/contents/')){const text='---\nname: meeting-risk\ndescription: Read selected meeting risks.\n---\nUse only selected sources, then cite decisions.';return {status:200,headers:{},text:JSON.stringify({type:'file',encoding:'base64',size:text.length,content:Buffer.from(text).toString('base64')})};}
    if(options.method==='DELETE')return {status:200,headers:{},text:''};const body=JSON.parse(options.body),headers={'content-type':'application/json'};
    if(!body.id)return {status:202,headers,text:''};let result;
    if(body.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if(body.method==='tools/list'&&bigTools)result={tools:Array.from({length:8},(_,index)=>({name:`large-${index}`,description:'read-only fixture',inputSchema:{type:'object',description:'x'.repeat(18000)},annotations:{readOnlyHint:true}}))};
    else if(body.method==='tools/list')result={tools:[{name:'search',inputSchema:{type:'object',properties:{query:{type:'string'}}},annotations:{readOnlyHint:true}}]};
    else{remoteCalls++;assert.equal(body.method,'tools/call');assert.equal(body.params.name,'search');result={content:[{type:'text',text:'bounded-remote-reference'}]};return {status:200,headers:{'content-type':'text/event-stream'},text:`data: ${JSON.stringify({jsonrpc:'2.0',id:body.id,result})}\n\n`};}
    return {status:200,headers,text:JSON.stringify({jsonrpc:'2.0',id:body.id,result})};
  };
  try{
    await writeFile(join(root,'providers.json'),JSON.stringify({LLM_API_KEY:'fixture-key',LLM_MODEL:'fixture-model',LLM_PROTOCOL:'chat-completions',LLM_API_URL:`http://127.0.0.1:${model.address().port}/v1/chat/completions`}));
    app=await createRecordServer({root,databaseUrl:'',port:0,extensionOptions:{request:requestRemote}});const address=await app.start(),base=`http://127.0.0.1:${address.port}/api`;
    const login=await fetch(`${base}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dev@local.test',password:'LocalMeeting2026!'})}),user=await login.json(),headers={Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':user.csrf,'Content-Type':'application/json'};
    const api=async(path,method='GET',body)=>{const response=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
    record=await api('/records','POST',{});await api(`/records/${record.id}/import-text`,'POST',{text:'决定周五评审。'});await app.repo.change(record.id,r=>{r.notes='saved-notes-for-this-scope';r.notesRevision++;});record=await app.repo.get(record.id);
    const skill=await api('/extensions/skills','POST',{source:'https://github.com/org/repo',path:'',ref:'main',expectedVersion:sha,confirmed:true});await api(`/extensions/${encodeURIComponent(skill.id)}`,'PATCH',{enabled:true,expectedVersion:skill.version});
    const plugin=await api('/extensions/plugins','POST',{name:'Fixture MCP',url:'https://mcp.example.test/mcp',confirmed:true});pluginId=plugin.id;await api(`/extensions/${encodeURIComponent(plugin.id)}`,'PATCH',{enabled:true,expectedVersion:plugin.version,approvedTools:['search']});
    const request={recordIds:[record.id],prompt:'整理评审风险',requestId:'fixture-extension-task',scopeConfirmed:true,skillId:skill.id,skillVersion:skill.version,pluginVersions:{[plugin.id]:plugin.version},pluginIds:[plugin.id],includeNotes:true,remoteToolsConfirmed:true};
    let task=await api('/agent/tasks','POST',request);
    for(let i=0;i<100&&!['completed','failed','blocked'].includes(task.status);i++){await new Promise(resolve=>setTimeout(resolve,10));task=await api(`/agent/tasks/${task.id}`);}
    assert.equal(task.status,'completed',JSON.stringify(task));assert.equal(task.skill.id,skill.id);assert.equal(task.skill.version,sha);assert.equal(task.progress.read,1);assert.equal(task.includeNotes,true);assert.equal(task.plugins[0].id,plugin.id);assert.equal(remoteCalls,1);assert.equal(calls,3);
    assert.deepEqual((await app.repo.get(record.id)).minutes,record.minutes);assert.equal((await api('/agent/tasks','POST',request)).id,task.id);
    await app.repo.change(record.id,r=>{r.notes='changed notes';r.notesRevision++;});assert.equal((await api(`/agent/tasks/${task.id}`)).stale,true);
    bigTools=true;const huge=await api('/extensions/plugins','POST',{name:'Large fixture MCP',url:'https://large.example.test/mcp',confirmed:true});await api(`/extensions/${encodeURIComponent(huge.id)}`,'PATCH',{enabled:true,expectedVersion:huge.version,approvedTools:huge.tools.map(tool=>tool.name)});
    const rejected=await fetch(`${base}/agent/tasks`,{method:'POST',headers,body:JSON.stringify({...request,requestId:'too-large-extensions',pluginIds:[huge.id],pluginVersions:{[huge.id]:huge.version}})});assert.equal(rejected.status,413);assert.equal((await rejected.json()).error,'agent_input_too_large');assert.equal(calls,3);

  }finally{await app?.stop();await new Promise(resolve=>model.close(resolve));await rm(root,{recursive:true,force:true});}
});
