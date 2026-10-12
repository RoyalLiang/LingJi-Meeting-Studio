import WebSocket from 'ws';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { createDoubaoAstCodec } from '../../session-gateway/src/providers/doubao-ast-codec.mjs';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';
import { doubaoRecognitionRequest } from './asr-terms.mjs';

let codecPromise;
// Durable chunks are independent bounded AST sessions. Only SessionFinished commits text.
export async function transcribeDoubao(bytes, language, config, options = {}) {
  requireThat(['zh', 'en', 'ja', 'id', 'es', 'pt', 'de', 'fr', 'zhen'].includes(language), 'unsupported_doubao_language', 422);
  const codec = options.codec || await (codecPromise ||= createDoubaoAstCodec());
  const sessionId = randomUUID(), connectionId = randomUUID();
  const meta = { Endpoint: config.DOUBAO_AST_ENDPOINT, AppKey: config.DOUBAO_AST_APP_KEY, AppID: config.DOUBAO_AST_APP_ID || undefined, ResourceID: config.DOUBAO_AST_RESOURCE_ID, ConnectionID: connectionId, SessionID: sessionId, Sequence: 0 };
  const socket = new WebSocket(config.DOUBAO_AST_BASE_URL, { headers: { 'X-Api-App-Key': config.DOUBAO_AST_APP_KEY, 'X-Api-Access-Key': config.DOUBAO_AST_ACCESS_KEY, 'X-Api-Resource-Id': config.DOUBAO_AST_RESOURCE_ID, 'X-Api-Connect-Id': connectionId, ...(config.DOUBAO_AST_APP_ID ? { 'X-Api-App-Id': config.DOUBAO_AST_APP_ID } : {}) }, handshakeTimeout: 10000, maxPayload: 2000000 });
  return new Promise((resolve, reject) => {
    let settled = false, started = false, partial = '';
    const finals = new Map();
    const finish = (error, text) => {
      if (settled) return; settled = true; clearTimeout(timer);
      socket.removeAllListeners(); socket.on('error', () => {});
      if (socket.readyState === WebSocket.OPEN) socket.close(); else socket.terminate();
      if (error) reject(error); else resolve(text);
    };
    const timer = setTimeout(() => finish(new DomainError('doubao_completion_timeout', 502)), options.timeout || 45000);
    socket.once('error', () => finish(new DomainError('doubao_connection_failed', 502)));
    socket.once('unexpected-response', (_request, response) => { response.resume(); finish(new DomainError(`doubao_http_${response.statusCode}`, 502)); });
    socket.once('close', () => finish(new DomainError('doubao_incomplete_session', 502)));
    socket.once('open', () => socket.send(codec.encodeStartSession({ requestMeta: meta, user: { uid: sessionId }, sourceAudio: { format: 'raw', rate: 16000, channel: 1, bits: 16 }, request: { mode: 's2t', sourceLanguage: language === 'zhen' ? 'zh' : language, targetLanguage: language === 'en' ? 'zh' : 'en', corpus: { correcting: true } } })));
    socket.on('message', frame => {
      try {
        const result = codec.decodeMessage(frame), event = Number(result.event);
        if (event === 153 || Number(result.responseMeta?.StatusCode || 0) !== 0) { finish(new DomainError('doubao_session_failed', 502)); return; }
        if (event === 150 && !started) {
          started = true;
          for (let offset = 0; offset < bytes.length; offset += 6400) {
            meta.Sequence++;
            socket.send(codec.encodeTaskRequest({ requestMeta: { ...meta }, sourceAudio: { format: 'raw', rate: 16000, channel: 1, bits: 16, binaryData: bytes.subarray(offset, offset + 6400) } }));
          }
          socket.send(codec.encodeFinishSession({ requestMeta: { ...meta } }));
        }
        if (event === 651) partial = result.text || '';
        if (event === 652) { finals.set(`${result.startTime || 0}:${result.endTime || 0}`, result.text || partial); partial = ''; }
        if (event === 152) finish(null, [...finals.values(), partial].filter(Boolean).join(''));
      } catch { finish(new DomainError('doubao_invalid_response', 502)); }
    });
  });
}

// OpenSpeech ASR v3 framing: header, optional sequence, length, gzip payload.
export function encodeAsrFrame(type, flags, payload, json = false) {
  const body = gzipSync(json ? Buffer.from(JSON.stringify(payload)) : payload);
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from([0x11, type << 4 | flags, (json ? 0x10 : 0) | 1, 0]), size, body]);
}
export function decodeAsrFrame(frame) {
  requireThat(frame.length >= 8 && frame[0] >> 4 === 1, 'doubao_invalid_frame', 502);
  const type = frame[1] >> 4, flags = frame[1] & 15;
  let offset = (frame[0] & 15) * 4, sequence;
  if (flags & 1) { sequence = frame.readInt32BE(offset); offset += 4; }
  if (type === 15) throw new DomainError(`doubao_asr_${frame.readUInt32BE(offset)}`, 502);
  requireThat(type === 9 && offset + 4 <= frame.length, 'doubao_invalid_frame', 502);
  const size = frame.readUInt32BE(offset); offset += 4;
  requireThat(size <= 2000000 && offset + size === frame.length, 'doubao_invalid_frame', 502);
  let payload = frame.subarray(offset);
  if ((frame[2] & 15) === 1) payload = gunzipSync(payload, { maxOutputLength: 2000000 });
  const result = JSON.parse(payload.toString());
  return { final: Boolean(flags & 2) || sequence < 0, result };
}
export async function transcribeDoubaoAsr(bytes, language, config, options = {}) {
  const secondPass = ['zh', 'en', 'zhen'].includes(language) && new URL(config.DOUBAO_ASR_URL).pathname.endsWith('/bigmodel_async');
  const recognition = doubaoRecognitionRequest(config, { secondPass });
  const socket = new WebSocket(config.DOUBAO_ASR_URL, { headers: { 'X-Api-Key': config.DOUBAO_API_KEY, 'X-Api-Resource-Id': config.DOUBAO_ASR_RESOURCE_ID, 'X-Api-Connect-Id': randomUUID() }, handshakeTimeout: 10000, maxPayload: 2000000 });
  return new Promise((resolve, reject) => {
    let settled = false, sendTimer;
    const done = (error, text) => {
      if (settled) return; settled = true; clearTimeout(timer); clearInterval(sendTimer);
      socket.removeAllListeners(); socket.on('error', () => {});
      if (socket.readyState === WebSocket.OPEN) socket.close(); else socket.terminate();
      if (error) reject(error); else resolve(text);
    };
    const timer = setTimeout(() => done(new DomainError('doubao_completion_timeout', 502)), options.timeout || 45000);
    socket.once('error', () => done(new DomainError('doubao_connection_failed', 502)));
    socket.once('unexpected-response', (_req, response) => { response.resume(); done(new DomainError(`doubao_http_${response.statusCode}`, 502)); });
    socket.once('close', () => done(new DomainError('doubao_incomplete_session', 502)));
    socket.once('open', () => {
      socket.send(encodeAsrFrame(1, 0, { user: { uid: 'meeting-studio' }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1, language: { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' }[language] || language }, request: recognition }, true));
      let offset = 0;
      const send = () => {
        if (settled || socket.readyState !== WebSocket.OPEN) return;
        const last = offset + 6400 >= bytes.length;
        socket.send(encodeAsrFrame(2, last ? 2 : 0, bytes.subarray(offset, offset + 6400)));
        offset += 6400;
        if (last) clearInterval(sendTimer);
      };
      sendTimer = setInterval(send, options.interval ?? 100); send();
    });
    socket.on('message', frame => {
      try {
        const {final, result} = decodeAsrFrame(frame);
        if (result.code && result.code !== 1000 && result.code !== 20000000) { done(new DomainError(`doubao_asr_${Number(result.code) || 'failed'}`, 502)); return; }
        if (final) { requireThat(result.result?.text === undefined || typeof result.result.text === 'string', 'doubao_missing_transcript', 502); done(null, result.result?.text || ''); }
      } catch (error) { done(error instanceof DomainError ? error : new DomainError('doubao_invalid_response', 502)); }
    });
  });
}

// One source owns one connection; definite utterances can arrive before the negative tail packet.
export function createDoubaoSpeakerStream(language, config, options={}) {
  const recognition = doubaoRecognitionRequest(config);
  const socket=new WebSocket(config.DOUBAO_ASR_URL,{headers:{'X-Api-Key':config.DOUBAO_API_KEY,'X-Api-Resource-Id':config.DOUBAO_ASR_RESOURCE_ID,'X-Api-Request-Id':randomUUID(),'X-Api-Connect-Id':randomUUID()},handshakeTimeout:10000,maxPayload:2000000});
  const state={latest:null,preview:null,error:null,complete:false,runtime:{}};
  const createdAt=Date.now();let audioStartedAt;
  const elapsed=()=>audioStartedAt==null ? undefined : Date.now()-audioStartedAt;
  let drainTimer,rejectReady,closed=false,receivedText=false,receivedTurns=false;
  const fail=error=>{if(!closed && !state.complete)state.error=error instanceof DomainError ? error : new DomainError('doubao_connection_failed',502);};
  const ready=new Promise((resolve,reject)=>{rejectReady=reject;
    socket.once('open',()=>{
      state.runtime.connectionMs=Date.now()-createdAt;
      socket.send(encodeAsrFrame(1,0,{user:{uid:'meeting-studio'},audio:{format:'pcm',codec:'raw',rate:16000,bits:16,channel:1,language:['en','zhen'].includes(language) ? 'zh-CN' : ({zh:'zh-CN',ja:'ja-JP'}[language]||language)},request:{...recognition,enable_speaker_info:true,ssd_version:'200'}},true)); resolve();
    });
    socket.once('error',error=>{fail(error);reject(state.error);});
    socket.once('unexpected-response',(_request,response)=>{response.resume();fail(new DomainError(`doubao_http_${response.statusCode}`,502));reject(state.error);socket.terminate();});
  });
  // A close before 'open' must settle ready, too.
  socket.on('close',()=>{clearTimeout(drainTimer);fail(new DomainError('doubao_incomplete_session',502));if(state.error)rejectReady(state.error);});
  socket.on('message',frame=>{
    try {
      const {final,result}=decodeAsrFrame(frame);
      if(result.code && ![1000,20000000].includes(result.code))throw new DomainError(`doubao_asr_${Number(result.code)||'failed'}`,502);
      const data=result.result || {}; receivedText ||= Boolean(data.text?.trim());
      if(data.text?.trim() && state.runtime.firstTextMs==null)state.runtime.firstTextMs=elapsed();
      const drafts=(data.utterances||[]).filter(u=>u.definite!==true && u.text?.trim());
      state.preview=final ? null : drafts.length ? {text:drafts.map(u=>u.text).join(''),startMs:Number(drafts[0].start_time??0)} : !data.utterances?.length && data.text?.trim() ? {text:data.text,startMs:0} : null;
      const turns=(data.utterances||[]).filter(u=>final || u.definite===true).map(u=>({text:u.text,startMs:Number(u.start_time ?? 0),endMs:Number(u.end_time),speakerId:u.additions?.speaker_id ?? u.speaker_id ?? u.additions?.speaker ?? u.speaker ?? null}));
      receivedTurns ||= turns.some(t=>t.text?.trim());
      if(turns.some(t=>t.text?.trim()) && state.runtime.firstConfirmedMs==null)state.runtime.firstConfirmedMs=elapsed();
      // Responses are cumulative; keep the newest snapshot until the worker persists it.
      if(turns.length){const pending=new Map([...(state.latest||[]),...turns].map(t=>[`${t.startMs}:${t.endMs}`,t]));requireThat(pending.size<=10000,'doubao_pending_turn_limit',502);state.latest=[...pending.values()];}
      if(final){if(receivedText && !receivedTurns)throw new DomainError('doubao_utterances_missing',502);state.complete=true;state.runtime.totalMs=elapsed();clearTimeout(drainTimer);socket.close();}
      options.onUpdate?.(state);
    }catch(error){fail(error);socket.close();}
  });
  return {
    state,ready,
    async write(bytes){await ready;audioStartedAt??=Date.now();for(let i=0;i<bytes.length;i+=6400){if(state.error)throw state.error;await new Promise((resolve,reject)=>socket.send(encodeAsrFrame(2,0,bytes.subarray(i,i+6400)),error=>error?reject(error):resolve()));if(i+6400<bytes.length)await new Promise(resolve=>setTimeout(resolve,options.interval??100));}},
    end(){if(state.error || state.complete)return;socket.send(encodeAsrFrame(2,2,Buffer.alloc(0)));drainTimer=setTimeout(()=>{fail(new DomainError('doubao_completion_timeout',502));socket.terminate();},options.timeout??45000);drainTimer.unref?.();},
    close(){closed=true;clearTimeout(drainTimer);rejectReady(new DomainError('doubao_stream_cancelled',502));socket.on('error',()=>{});socket.terminate();},
  };
}
