import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRecordServer} from '../services/records/src/server.mjs';

test('task histories page beyond old caps, retain timestamp ties and isolate owners',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-history-'));
  const app=await createRecordServer({root,databaseUrl:'',port:0});
  const address=await app.start(),base=`http://127.0.0.1:${address.port}/api`;
  t.after(async()=>{await app.stop();await rm(root,{recursive:true,force:true});});
  const registered=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'history@example.test',password:'fixture-password'})});
  const user=await registered.json(),headers={Cookie:registered.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':user.csrf,'Content-Type':'application/json'};
  const request=async(path,method='GET',body)=>{const res=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json()};};
  const record=(await request('/records','POST',{})).body;
  const owner=(await app.repo.get(record.id)).owner;
  for(let i=0;i<45;i++){
    const id='git-sync:'+createHash('sha256').update(String(i)).digest('hex');
    await app.repo.insert({id,kind:'git-sync-job',owner,recordId:record.id,title:`Git ${i}`,status:'failed',phase:'organize',createdAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z'});
    await app.repo.insert({id:randomUUID(),kind:'feishu-export',owner,recordId:record.id,title:`Feishu ${i}`,status:'failed',automatic:i%2===0,createdAt:1793491200000,updatedAt:1793491200000});
  }
  await app.repo.insert({id:'git-sync:'+ 'a'.repeat(64),kind:'git-sync-job',owner:'other-owner',recordId:record.id,title:'hidden other owner',status:'failed',createdAt:'2026-11-02T00:00:00.000Z',updatedAt:'2026-11-02T00:00:00.000Z'});
  for(const [path,key,count]of [['/integrations/git-sync/tasks/history','items',45],['/integrations/feishu/automation/history','items',23],[`/records/${record.id}/feishu`,'exports',45]]){
    let cursor='',seen=[];
    for(let page=0;page<5;page++){
      const result=await request(`${path}?limit=20${cursor?'&cursor='+encodeURIComponent(cursor):''}`);
      assert.equal(result.status,200,path);assert.ok(result.body[key].length<=20);
      seen.push(...result.body[key]);cursor=result.body.nextCursor||'';if(!cursor)break;
    }
    assert.equal(cursor,'',path+' terminates');assert.equal(seen.length,count,path+' includes old records');
    assert.equal(new Set(seen.map(row=>row.id)).size,count,'equal timestamps do not duplicate or skip');
    assert.ok(seen.every(row=>!row.title?.includes('other owner')));
    assert.equal((await request(path+'?limit=20&cursor=malformed')).status,400);
  }
  const removed=(await request('/records','POST',{})).body;
  await app.repo.change(removed.id,row=>{row.deleted=true;});
  for(let i=0;i<20;i++)await app.repo.insert({id:randomUUID(),kind:'feishu-export',owner,recordId:removed.id,title:'deleted source',status:'failed',automatic:true,createdAt:1793577600000,updatedAt:1793577600000});
  const visiblePage=await request('/integrations/feishu/automation/history?limit=20');
  assert.equal(visiblePage.status,200);assert.equal(visiblePage.body.items.length,20,'deleted recent sources do not leave an empty first page');
  assert.ok(visiblePage.body.items.every(row=>row.title!=='deleted source'));
});
