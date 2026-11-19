import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {digest} from '../packages/records/src/record.mjs';
import {createRecordServer} from '../services/records/src/server.mjs';
import {runCycle} from '../services/records/src/worker.mjs';

const jpeg = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABNAAEBAAAAAAAAAAAAAAAAAAAABwEBAQEAAAAAAAAAAAAAAAAAAAUHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAGAAgAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjgDf0oAAAAAB/9k=';
const visualText = '试运行看板显示容量为 275 台';

for (const protocol of ['chat-completions','responses']) {
  test(`selected-window screenshots reach minutes over ${protocol} and follow meeting deletion`, async t => {
    const root = await mkdtemp(join(tmpdir(),'meeting-screenshots-'));
    let imageRequests = 0, summaryRequests = 0;
    const unsupported = protocol === 'responses';
    const model = createServer(async (req,res) => {
      try {
        let input = '';
        for await (const segment of req) input += segment;
        const messages = JSON.parse(input).messages || JSON.parse(input).input;
        const image = messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).find(part=>['image_url','input_image'].includes(part.type));
        let output;
        if (image) {
          imageRequests++;
          assert.equal(image.type, unsupported ? 'input_image' : 'image_url');
          assert.equal(typeof image.image_url === 'string' ? image.image_url : image.image_url.url, 'data:image/jpeg;base64,'+jpeg);
          if (unsupported) {
            res.writeHead(400,{'Content-Type':'application/json'});
            res.end(JSON.stringify({error:{message:'Image input unsupported'}}));
            return;
          }
          output = {observations:[{frame:1,text:visualText}]};
        } else {
          summaryRequests++;
          const usesVisuals = input.includes(visualText);
          assert.equal(usesVisuals,!unsupported);
          const text = usesVisuals ? '试运行需核对看板显示的 275 台容量。' : '试运行需要核对看板容量。';
          output = {title:'试运行',sections:[{heading:'容量',items:[{text,evidence:[0]}]}],actions:[]};
        }
        res.writeHead(200,{'Content-Type':'application/json'});
        const content = JSON.stringify(output);
        res.end(JSON.stringify(unsupported ? {output_text:content} : {choices:[{message:{content}}]}));
      } catch (error) {
        res.writeHead(500,{'Content-Type':'text/plain'});
        res.end(error.message);
      }
    });
    let app;
    t.after(async ()=>{
      await app?.stop();
      model.closeAllConnections();
      await new Promise(resolve=>model.close(resolve));
      await rm(root,{recursive:true,force:true});
    });
    await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
    await writeFile(join(root,'providers.json'),JSON.stringify({
      LLM_API_URL:`http://127.0.0.1:${model.address().port}/v1`,LLM_API_KEY:'synthetic-vision-key',
      LLM_MODEL:'synthetic-vision',LLM_PROTOCOL:protocol,MINUTES_MODE:'asr-llm',ASR_PROVIDER:'openai-compatible',
    }));
    app = await createRecordServer({root,databaseUrl:'',port:0});
    const base = `http://127.0.0.1:${(await app.start()).port}/api`;
    const json = {'Content-Type':'application/json'};
    const registration = await fetch(base+'/auth/register',{method:'POST',headers:json,
      body:JSON.stringify({email:'screenshots@example.test',password:'screenshots-test-password'})});
    assert.ok(registration.ok);
    const headers = {...json, Cookie:registration.headers.get('set-cookie').split(';')[0],
      'X-CSRF-Token':(await registration.json()).csrf};
    async function request(path,method,body,expected=200) {
      const response = await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      const value = await response.json();
      assert.equal(response.status,expected,JSON.stringify(value));
      return value;
    }
    const meeting = await request('/records','POST',{autoMinutes:true},201);
    const path = '/records/'+meeting.id;
    const source = await request(path+'/sources','POST',{kind:'microphone'});
    const frame = {sessionId:source.sessionId,consent:true,surface:'window',jpeg};
    assert.equal((await fetch(base+path+'/screenshots',{method:'POST',headers:json,body:JSON.stringify(frame)})).status,401);
    await request(path+'/screenshots','POST',{...frame,consent:false},400);
    await request(path+'/screenshots','POST',{...frame,surface:'monitor'},400);
    await request(path+'/screenshots','POST',{...frame,sessionId:randomUUID()},409);
    await request(path+'/screenshots','POST',{...frame,jpeg:'invalid'},400);
    const saves = await Promise.all([request(path+'/screenshots','POST',frame),request(path+'/screenshots','POST',frame)]);
    assert.deepEqual(saves,[{count:1,full:false},{count:1,full:false}]);
    const pcm = Buffer.alloc(32000,4);
    await request(path+'/audio','POST',{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,
      sequence:0,sampleOffset:0,sampleCount:16000,sampleRate:16000,digest:digest(pcm),pcm:pcm.toString('base64')});
    await request(path+'/seal','POST',{sources:[{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,lastSequence:0}]});
    await request(path+'/screenshots','POST',frame,409);
    for (let cycle=0;cycle<3;cycle++) {
      await runCycle(app.repo,{transcribe:async()=> '讨论试运行容量，请核对看板。'});
      if ((await app.repo.get(meeting.id)).minutes) break;
    }
    const detail = await request(path,'GET');
    assert.equal(imageRequests,1);
    assert.ok(summaryRequests >= 1);
    assert.equal(detail.visualRevision,1);
    assert.ok(!JSON.stringify(detail).includes(jpeg));
    assert.equal(detail.minutes?.screenshotInput?.used,unsupported ? 0 : 1, JSON.stringify(detail.jobs));
    assert.equal(detail.minutes?.visualRevision,1);
    assert.equal((await fetch(base+path+'/screenshots?through=1')).status,401);
    await request(path+'/screenshots?through=2','GET',undefined,400);
    const images = await request(path+'/screenshots?through=1','GET');
    assert.deepEqual(images.frames.map(({revision,jpeg})=>({revision,jpeg})),[{revision:1,jpeg}]);
    const item = detail.minutes.sections[0].items[0];
    assert.equal(item.text.includes('275'),!unsupported);
    assert.ok(item.evidence.some(ref=>ref.segmentId===detail.segments[0].id && ref.revision===detail.segments[0].revision));
    await request(path,'DELETE');
    await runCycle(app.repo);
    assert.deepEqual((await app.repo.get('meeting-screenshots:'+meeting.id)).frames,[]);
  });
}
