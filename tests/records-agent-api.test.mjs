import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRecordServer } from '../services/records/src/server.mjs';

test('agent HTTP smoke: real Pi and production model bridge preserve auth, idempotency, sources and existing minutes', async () => {
  const root=await mkdtemp(join(tmpdir(),'lingji-agent-api-'));
  let record, calls=0, app;
  const model=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization,'Bearer isolated-test-key');
    assert.equal(input.model,'isolated-model');
    calls++;
    const response=calls===1?{toolCalls:[{name:'read_selected_meeting',arguments:{recordId:record.id}}]}:{result:{summary:'已确认周五评审。',decisions:[{text:'周五评审',evidence:[{recordId:record.id,segmentId:record.segments[0].id,revision:record.segments[0].revision}]}],actions:[]}};
    if(calls===2)assert.ok(JSON.stringify(input.messages).includes('决定周五评审'));
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(response)}}]}));
  });
  await new Promise((resolve,reject)=>{model.once('error',reject);model.listen(0,'127.0.0.1',resolve);});
  await writeFile(join(root,'providers.json'),JSON.stringify({LLM_API_KEY:'isolated-test-key',LLM_MODEL:'isolated-model',LLM_PROTOCOL:'chat-completions',LLM_API_URL:`http://127.0.0.1:${model.address().port}/v1/chat/completions`}));
  try {
    app=await createRecordServer({root,port:0});await app.start();
    let url=`http://127.0.0.1:${app.server.address().port}/api`;
    async function login(email='dev@local.test',path='login'){
      const res=await fetch(url+'/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'LocalMeeting2026!'})});
      assert.equal(res.status,200);const data=await res.json();return {cookie:res.headers.get('set-cookie').split(';')[0],csrf:data.csrf};
    }
    const owner=await login(),other=await login('other@local.test','register');
    async function request(path,{user=owner,method='GET',body,csrf=true}={}){
      const res=await fetch(url+path,{method,headers:{Cookie:user.cookie,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':user.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
      return {status:res.status,body:await res.json()};
    }
    record=(await request('/records',{method:'POST',body:{title:'Pi API 冒烟',autoMinutes:false}})).body;
    record=(await request(`/records/${record.id}/import-text`,{method:'POST',body:{text:'决定周五评审。\n小林准备评审材料。'}})).body;
    const body={recordIds:[record.id],prompt:'整理决策并引用原文。',requestId:'api-smoke-1',scopeConfirmed:true};
    assert.equal((await request('/agent/tasks',{method:'POST',body,csrf:false})).status,403);
    assert.equal((await request('/agent/tasks',{method:'POST',body:{...body,scopeConfirmed:false}})).status,400);
    const [first,duplicate]=await Promise.all([request('/agent/tasks',{method:'POST',body}),request('/agent/tasks',{method:'POST',body})]);
    assert.equal(first.status,202);assert.equal(duplicate.status,202);assert.equal(first.body.id,duplicate.body.id);
    const id=first.body.id;
    assert.equal((await request('/agent/tasks',{method:'POST',body:{...body,prompt:'changed'}})).status,409);
    assert.equal((await request(`/agent/tasks/${id}`,{user:other})).status,404);
    assert.deepEqual((await request('/agent/tasks',{user:other})).body.tasks,[]);
    let task;
    for(let i=0;i<200;i++){task=(await request(`/agent/tasks/${id}`)).body;if(['completed','failed','blocked'].includes(task.status))break;await delay(20);}
    assert.equal(task.status,'completed',JSON.stringify(task));assert.equal(task.result.summary,'已确认周五评审。');assert.equal(task.stale,false);assert.equal(calls,2);
    assert.equal((await request(`/records/${record.id}`)).body.minutes,record.minutes);
    assert.equal((await request('/agent/tasks')).body.tasks.length,1);
    const second=await createRecordServer({root,port:0});await second.start();
    try {
      const secondary=`http://127.0.0.1:${second.server.address().port}/api`;
      const headers={Cookie:owner.cookie};
      assert.equal((await fetch(secondary+'/records',{headers})).status,200);
      assert.equal((await fetch(secondary+'/bootstrap',{headers})).status,200);
      assert.equal((await fetch(secondary+'/agent/tasks',{headers})).status,503);
    } finally {await second.stop();}

    await app.stop();app=await createRecordServer({root,port:0});await app.start();url=`http://127.0.0.1:${app.server.address().port}/api`;
    assert.equal((await request(`/agent/tasks/${id}`)).body.status,'completed');assert.equal(calls,2);
    await app.repo.change(record.id,value=>{value.segments[0].revision++;value.transcriptRevision++;});
    assert.equal((await request(`/agent/tasks/${id}`)).body.stale,true);
    assert.equal((await request(`/agent/tasks/${id}/cancel`,{method:'POST',body:{}})).body.status,'completed');
  } finally {await app?.stop();await new Promise(resolve=>model.close(resolve));await rm(root,{recursive:true,force:true});}
});
