import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { gunzipSync, gzipSync } from 'node:zlib';
import { normalizeConfig, readConfig, saveConfig } from '../services/records/src/config.mjs';
import { completeJson } from '../services/records/src/providers.mjs';
import { createDoubaoSpeakerStream, transcribeDoubaoAsr } from '../services/records/src/doubao.mjs';

test('model addresses remain exactly configured across save, read and protocol changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'settings-quality-'));
  try {
    for (const url of ['https://models.example/v1', 'https://models.example/', 'https://models.example/custom/?region=cn', 'https://models.example/v1/chat/completions']) {
      for (const protocol of ['responses', 'chat-completions']) {
        const values = await saveConfig(root, { LLM_API_URL: url, LLM_PROTOCOL: protocol }, {});
        assert.equal(values.LLM_API_URL, url);
        assert.equal((await readConfig(root, {})).LLM_API_URL, url);
        assert.equal(normalizeConfig({ LLM_API_URL: url, LLM_PROTOCOL: protocol }).LLM_API_URL, url);
      }
    }
    assert.equal(normalizeConfig({ LLM_API_URL: '' }).LLM_API_URL, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model requests use the configured URL without rewriting the path', async () => {
  const original = globalThis.fetch;
  let requested;
  globalThis.fetch = async url => {
    requested = url;
    return new Response(JSON.stringify({ output_text: '{"ok":true}' }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const url = 'https://models.example/v1?route=custom';
    await completeJson([], { LLM_API_URL: url, LLM_PROTOCOL: 'responses', LLM_MODEL: 'fixture', LLM_API_KEY: 'fixture-key' });
    assert.equal(requested, url);
  } finally { globalThis.fetch = original; }
});

function finalFrame() {
  const body = gzipSync(Buffer.from(JSON.stringify({ result: { text: '聆记使用 Redis Sentinel。', utterances: [{ text: '聆记使用 Redis Sentinel。', start_time: 0, end_time: 200, definite: true }] } })));
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from([0x11, 0x92, 0x11, 0]), size, body]);
}
test('batch and speaker recognition send the same bounded terminology with second-pass recognition', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  const requests = [];
  server.on('connection', socket => socket.on('message', bytes => {
    if (bytes[1] >> 4 === 1) requests.push(JSON.parse(gunzipSync(bytes.subarray(8)).toString()));
    else if (bytes[1] & 2) socket.send(finalFrame());
  }));
  const config = { DOUBAO_ASR_URL: `ws://127.0.0.1:${server.address().port}/api/v3/sauc/bigmodel_async`, DOUBAO_ASR_RESOURCE_ID: 'fixture', DOUBAO_API_KEY: 'fixture', DOUBAO_ASR_HOTWORDS: '聆记, Redis Sentinel，聆记;FMS' };
  let client;
  try {
    await transcribeDoubaoAsr(Buffer.alloc(6400), 'zh', config, { interval: 0 });
    client = createDoubaoSpeakerStream('zh', config);
    await client.ready; await client.write(Buffer.alloc(6400)); client.end();
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('fixture timeout')), 2000);
      const timer = setInterval(() => { if (client.state.complete || client.state.error) { clearInterval(timer); clearTimeout(deadline); client.state.error ? reject(client.state.error) : resolve(); } }, 5);
    });
    assert.equal(requests.length, 2);
    for (const { request } of requests) {
      assert.equal(request.enable_nonstream, true);
      assert.equal(request.enable_itn, true);
      assert.deepEqual(JSON.parse(request.corpus.context).hotwords, [{ word: '聆记' }, { word: 'Redis Sentinel' }, { word: 'FMS' }]);
    }
    await transcribeDoubaoAsr(Buffer.alloc(6400), 'ja', config, { interval: 0 });
    await transcribeDoubaoAsr(Buffer.alloc(6400), 'zh', { ...config, DOUBAO_ASR_URL: config.DOUBAO_ASR_URL.replace('bigmodel_async', 'bigmodel') }, { interval: 0 });
    assert.equal(requests[2].request.enable_nonstream, undefined);
    assert.equal(requests[3].request.enable_nonstream, undefined);
  } finally { client?.close(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); }
});

test('terminology settings validate limits and can be cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asr-terms-'));
  try {
    assert.equal((await saveConfig(root, { DOUBAO_ASR_HOTWORDS: '聆记, FMS' }, {})).DOUBAO_ASR_HOTWORDS, '聆记, FMS');
    assert.equal((await readConfig(root, {})).DOUBAO_ASR_HOTWORDS, '聆记, FMS');
    await assert.rejects(saveConfig(root, { DOUBAO_ASR_HOTWORDS: Array.from({ length: 101 }, (_, i) => `term${i}`).join(',') }, {}), { code: 'invalid_asr_hotwords' });
    await assert.rejects(saveConfig(root, { DOUBAO_ASR_HOTWORDS: ['甲'.repeat(40), '乙'.repeat(40), '丙'.repeat(40)].join(',') }, {}), { code: 'invalid_asr_hotwords' });
    await assert.rejects(transcribeDoubaoAsr(Buffer.alloc(0), 'zh', { DOUBAO_ASR_URL: 'ws://localhost/api/v3/sauc/bigmodel_async', DOUBAO_ASR_HOTWORDS: '甲'.repeat(51) }), { code: 'invalid_asr_hotwords' });
    await saveConfig(root, { DOUBAO_ASR_HOTWORDS: '' }, {});
    assert.equal((await readConfig(root, {})).DOUBAO_ASR_HOTWORDS, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
