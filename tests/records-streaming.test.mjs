import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { completeJson } from '../services/records/src/providers.mjs';

async function endpoint(handler, run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const bytes of req) text += bytes;
    const body = JSON.parse(text); requests.push({ path: req.url, body });
    await handler(req, res, body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const credentials = { LLM_MODEL: 'fixture-model', LLM_API_KEY: 'fixture-key' };
test('Responses uses input and text format, disables storage, and reads output content', async () => {
  await endpoint((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: { total_tokens: 13 } }));
  }, async (base, requests) => {
    const result = await completeJson([{ role: 'user', content: 'Synthetic JSON check.' }], { ...credentials, LLM_API_URL: base, LLM_PROTOCOL: 'responses' });
    assert.equal(requests[0].path, '/');
    assert.ok(Array.isArray(requests[0].body.input));
    assert.equal(requests[0].body.messages, undefined);
    assert.equal(requests[0].body.store, false);
    assert.equal(requests[0].body.text.format.type, 'json_object');
    assert.equal(result.ok, true); assert.equal(result.usageTokens, 13);
  });
});

for (const protocol of ['responses', 'chat-completions']) {
 test(`${protocol} streams UTF-8 deltas before completion and records usage`, async () => {
  let finish, delivered = false;
  const ready = new Promise(resolve => { finish = resolve; });
  await endpoint(async (_req, res) => {
   res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders();
   const delta = '{"title":"中文纪要"';
   const frame = protocol === 'responses' ? {type:'response.output_text.delta',delta} : {choices:[{delta:{content:delta}}]};
   const bytes = Buffer.from(`data: ${JSON.stringify(frame)}\r\n\r\n`);
   for (let i = 0; i < bytes.length; i += 3) res.write(bytes.subarray(i, i + 3));
   await ready;
   const tail = protocol === 'responses' ? {type:'response.output_text.delta',delta:'}'} : {choices:[{delta:{content:'}'},finish_reason:'stop'}]};
   res.write(`data: ${JSON.stringify(tail)}\n\n`);
   res.write(`data: ${JSON.stringify(protocol === 'responses' ? {type:'response.completed',response:{status:'completed',usage:{total_tokens:9}}} : {usage:{total_tokens:9}})}\n\n`);
   res.end('data: [DONE]\n\n');
  }, async base => {
   const result = await completeJson([{role:'user',content:'fixture'}], {...credentials, LLM_API_URL:base,LLM_PROTOCOL:protocol}, {onDelta: async delta => { delivered = true; assert.ok(delta); finish(); }});
   assert.equal(delivered, true); assert.equal(result.title,'中文纪要'); assert.equal(result.usageTokens,9);
   assert.equal(result.runtime.streamed,true); assert.ok(result.runtime.firstTokenMs >= 0);
  });
 });
 test(`${protocol} rejects a truncated stream even with parseable JSON`, async () => {
  await endpoint(async (_req,res) => {
   res.setHeader('Content-Type','text/event-stream');
   res.end(`data: ${JSON.stringify(protocol === 'responses' ? {type:'response.output_text.delta',delta:'{"ok":true}'} : {choices:[{delta:{content:'{"ok":true}'}}]})}\n\n`);
  }, async base => assert.rejects(completeJson([], {...credentials, LLM_API_URL:base,LLM_PROTOCOL:protocol},{onDelta:()=>{}}),{code:'llm_stream_incomplete'}));
 });
}

test('protocol normalization preserves vendor prefixes and rejects unknown protocols', async () => {
 const {normalizeConfig,saveConfig}=await import('../services/records/src/config.mjs');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 assert.equal(normalizeConfig({LLM_API_URL:'https://example.test/api/v3',LLM_PROTOCOL:'responses'}).LLM_API_URL,'https://example.test/api/v3');
 assert.equal(normalizeConfig({LLM_API_URL:'https://example.test/v1/chat/completions',LLM_PROTOCOL:'responses'}).LLM_API_URL,'https://example.test/v1/chat/completions');
 assert.equal(normalizeConfig({LLM_API_URL:'https://example.test/v1/responses'}).LLM_PROTOCOL,'responses');
 const root=await mkdtemp(join(tmpdir(),'tts-protocol-'));try{await assert.rejects(saveConfig(root,{LLM_PROTOCOL:'unknown'},{}),{code:'invalid_llm_protocol'});}finally{await rm(root,{recursive:true,force:true});}
});


test('HTML model landing pages report a wrong endpoint and preserve the exact configured URL', async () => {
 for (const contentType of ['text/html; charset=utf-8', 'application/json']) {
  await endpoint((_req, res) => {
   res.setHeader('Content-Type', contentType);
   res.end('<!doctype html><html><body>Model gateway console</body></html>');
  }, async (base, requests) => {
   let deltas = 0;
   await assert.rejects(completeJson([{role:'user',content:'Synthetic diagnostic.'}], {...credentials,LLM_API_URL:base,LLM_PROTOCOL:'responses'}, {onDelta:()=>{deltas++;}}), {code:'llm_endpoint_not_api'});
   assert.equal(requests.length,1);
   assert.equal(requests[0].path,'/');
   assert.equal(deltas,0);
  });
 }
});


test('malformed model JSON remains an invalid response rather than a landing-page error', async () => {
 await endpoint((_req,res) => {
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({status:'completed',output_text:'{broken JSON'}));
 },async base => assert.rejects(completeJson([], {...credentials,LLM_API_URL:base,LLM_PROTOCOL:'responses'}),{code:'invalid_llm_response'}));
});


test('a timeout during model streaming is not misreported as invalid JSON', async () => {
 await endpoint((_req,res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.write(`data: ${JSON.stringify({type:'response.output_text.delta',delta:'{"title":"Pending"'})}\n\n`);
 },async base => {
  const controller=new AbortController();
  await assert.rejects(completeJson([], {...credentials,LLM_API_URL:base,LLM_PROTOCOL:'responses'}, {
   signal:controller.signal,
   onDelta:()=>controller.abort(new DOMException('Deadline exceeded','TimeoutError'))
  }),{code:'llm_timeout'});
 });
});
