import { telemetry } from './telemetry.mjs';
import { performance } from 'node:perf_hooks';
import { setTranslationTarget } from '../../../packages/records/src/translation.mjs';
import { workspaceRoutes, requireWorkspace } from './workspace-routes.mjs';
import { belongsToScope, meetingSeconds } from '../../../packages/records/src/workspaces.mjs';
import { setAutomation } from '../../../packages/records/src/automation.mjs';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRecord, addSource, acknowledge, seal, pause, publicRecord, editSegment, requestMinutes, validateMinutes,
  digest, DomainError, requireThat, emit } from '../../../packages/records/src/record.mjs';
import { createRepository } from './repository.mjs';
import { createAuth } from './auth.mjs';
import { readConfig, saveConfig, publicConfig, canConfigure } from './config.mjs';
import { providerStatus, transcribe, completeJson, waveHeader } from './providers.mjs';

async function readBody(request, max = 600000) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; requireThat(size <= max, 'body_too_large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new DomainError('invalid_json', 400); }
}
const escapeIcs = text => String(text).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, '\\$&');
export function exportRecord(record, format = 'markdown') {
  if (format === 'json') return JSON.stringify(publicRecord(record), null, 2);
  if (format === 'issues') return JSON.stringify({ recordId: record.id, minutesRevision: record.minutesRevision,
    candidates: (record.minutes?.actions || []).map(action => ({ title: action.text,
      body: `${action.text}\n\n负责人：${action.owner || '待确认'}\n日期：${action.due || '待确认'}\n来源：${action.evidence.map(e => `${e.segmentId}@${e.revision}`).join(', ')}`,
      evidence: action.evidence })) }, null, 2);
  if (format === 'ics') return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meeting Studio//Actions//ZH',
    ...(record.minutes?.actions || []).flatMap((a, i) => ['BEGIN:VTODO', `UID:${record.id}-${i}@meeting.local`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`, `SUMMARY:${escapeIcs(a.text)}`,
      ...(/^\d{4}-\d{2}-\d{2}$/.test(a.due || '') ? [`DUE;VALUE=DATE:${a.due.replace(/-/g, '')}`] : []), 'STATUS:NEEDS-ACTION', 'END:VTODO']), 'END:VCALENDAR', ''].join('\r\n');
  const lines = [`# ${record.title}`, '', `转录版本 ${record.transcriptRevision} · 纪要版本 ${record.minutesRevision}`, ''];
  if (record.minutes) for (const section of record.minutes.sections) {
    lines.push(`## ${section.heading}`, ''); for (const item of section.items) lines.push(`- ${item.text} [${item.evidence.map(e => `${e.segmentId}@${e.revision}`).join(', ')}]`); lines.push('');
  }
  lines.push('## 转录', ''); for (const s of record.segments) lines.push(`[${Math.floor(s.startMs / 1000)}s] ${s.speaker ? `${s.speaker}：` : ''}${s.text}`, '');
  if (record.notes) lines.push('## 人工笔记', '', record.notes); return lines.join('\n');
}
export async function createRecordServer(options = {}) {
  const repo = options.repo || await createRepository(options); const auth = await createAuth(repo, { seedDevelopment: !options.repo, ...options });
  const streams = new Set(); const attempts = new Map();
  const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(JSON.stringify(data)); };
  async function owned(id, user) { const r = await repo.get(id); requireThat(r && r.kind === 'record' && r.owner === user.id, 'not_found', 404); requireThat(!r.deleted && Date.parse(r.deleteAt) > Date.now(), 'record_deleted', 410); return r; }
  const changeOwned = (id, user, mutate) => repo.change(id, r => {
    requireThat(r.owner === user.id && !r.deleted && Date.parse(r.deleteAt) > Date.now(), 'record_deleted', 410);
    return mutate(r);
  });
  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    const traceId = /^[A-Za-z0-9-]{16,80}$/.test(req.headers['x-record-trace'] || '') ? req.headers['x-record-trace'] : randomUUID();
    res.setHeader('X-Record-Trace', traceId);
    res.once('finish', () => telemetry.event('http.complete', { traceId, durationMs:performance.now()-started, outcome:res.statusCode<400?'ok':'error', bytes:Number(res.getHeader('Content-Length'))||0 }));
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      if (path === '/api/health') { await repo.list('health-probe'); send(res, 200, { ok: true, service: 'records', storage: repo.backend, audioStorage: repo.audioBackend }); return; }
      requireThat(path.startsWith('/api/'), 'not_found', 404);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
        const allowed = options.origin || process.env.RECORD_PUBLIC_ORIGIN;
        const host = req.headers.host;
        requireThat(allowed ? req.headers.origin === allowed : new URL(req.headers.origin).host === host, 'origin_rejected', 403);
      }
      if (/^\/api\/auth\/(register|login)$/.test(path) && req.method === 'POST') {
        const key = req.socket.remoteAddress; const now = Date.now();
        const entry = attempts.get(key) || { count: 0, reset: now + 60000 };
        if (entry.reset < now) { entry.count = 0; entry.reset = now + 60000; }
        requireThat(entry.count++ < 20, 'login_rate_limited', 429); attempts.set(key, entry);
        if (attempts.size > 10000) for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
        const body = await readBody(req, 4000); const user = path.endsWith('register') ? await auth.register(body) : await auth.login(body);
        send(res, 200, { email: user.email, csrf: auth.csrf(user) }, { 'Set-Cookie': auth.issue(user) }); return;
      }
      const shared = path.match(/^\/api\/shared\/([A-Za-z0-9_-]{40,100})$/);
      if (shared && req.method === 'GET') {
        const tokenHash = digest(shared[1]); const r = (await repo.list()).find(r => !r.deleted && Date.parse(r.deleteAt) > Date.now() && r.shares.some(s => s.hash === tokenHash && !s.revoked && s.expires > Date.now()));
        requireThat(r, 'share_expired_or_revoked', 404); const share = r.shares.find(s => s.hash === tokenHash);
        send(res, 200, share.scope === 'full' ? { title: r.title, segments: r.segments, minutes: r.minutes } : { title: r.title, minutes: r.minutes ? { ...r.minutes, evidenceSnapshot: r.minutes.evidenceSnapshot.filter(s => [...r.minutes.sections.flatMap(section => section.items), ...(r.minutes.actions || [])].some(item => item.evidence.some(ref => ref.segmentId === s.id && ref.revision === s.revision))) } : null }); return;
      }
      if (path === '/api/development-account' && req.method === 'GET') {
        requireThat(process.env.NODE_ENV !== 'production' && process.env.RECORD_DEV_ACCOUNT !== 'off', 'not_found', 404);
        send(res, 200, { email: process.env.RECORD_DEV_EMAIL || 'dev@local.test', password: process.env.RECORD_DEV_PASSWORD ? null : 'LocalMeeting2026!' }); return;
      }
      const user = await auth.user(req);
      if (!['GET', 'HEAD'].includes(req.method)) auth.checkCsrf(req, user);
      if (path === '/api/auth/logout' && req.method === 'POST') {
        await repo.change(user.id, u => { u.authVersion++; }); send(res, 200, { ok: true }, { 'Set-Cookie': auth.clear() }); return;
      }
      if (path === '/api/diagnostics/traces' && req.method === 'GET') { requireThat(canConfigure(user), 'configuration_admin_required', 403); send(res,200,telemetry.snapshot()); return; }
      if (path === '/api/bootstrap' && req.method === 'GET') {
        send(res, 200, { email: user.email, csrf: auth.csrf(user), providers: providerStatus(await readConfig(repo.root)), limits: { maxMinutes: 120, maxRecords: 200, maxChunkSeconds: 15 }, storage: repo.backend, canConfigure: canConfigure(user) }); return;
      }
      if (path === '/api/settings/providers/test' && req.method === 'POST') {
        requireThat(canConfigure(user), 'configuration_admin_required', 403);
        const {kind} = await readBody(req, 1000), config = await readConfig(repo.root);
        requireThat(['asr', 'minutes'].includes(kind), 'invalid_provider_test', 400);
        if (kind === 'asr') await transcribe(Buffer.alloc(6400), {language:'zh'}, {}, config);
        else await completeJson([{role:'system', content:'Return JSON {ok:true}.'},{role:'user',content:'Synthetic connectivity check.'}], config);
        send(res, 200, {message: '连接测试通过。真实会议识别质量仍需试录核对。'}); return;
      }
      if (path === '/api/settings/providers') {
        requireThat(canConfigure(user), 'configuration_admin_required', 403);
        if (req.method === 'GET') { send(res, 200, { values: publicConfig(await readConfig(repo.root)) }); return; }
        if (req.method === 'PUT') { send(res, 200, { values: await saveConfig(repo.root, await readBody(req, 20000)) }); return; }
      }
      if (path === '/api/deletions' && req.method === 'GET') {
        send(res, 200, { deletions: (await repo.list()).filter(r => r.owner === user.id && r.deleted).map(r => ({ id: r.id, cleanup: r.cleanup || 'pending' })) }); return;
      }
      if (await workspaceRoutes({ req, res, path, repo, user, readBody, send })) return;
      if (path === '/api/records' && req.method === 'POST') {
        const all = (await repo.list()).filter(r => r.owner === user.id && !r.deleted);
        requireThat(all.length < 200, 'record_limit', 429); const input = await readBody(req, 4000);
        if (input.workspaceId) { requireThat(!['all', 'inbox'].includes(input.workspaceId), 'invalid_workspace', 400); await requireWorkspace(repo, user.id, input.workspaceId); }
        requireThat(!input.autoMinutes || providerStatus(await readConfig(repo.root)).minutes, 'minutes_not_configured', 503);
        const r = await repo.insert(createRecord(user.id, input));
        send(res, 201, publicRecord(r)); return;
      }
      if (path === '/api/records' && req.method === 'GET') {
        const query = (url.searchParams.get('q') || '').toLowerCase().slice(0, 200);
        const scope = url.searchParams.get('workspace') || 'all'; await requireWorkspace(repo, user.id, scope);
        const all = (await repo.list()).filter(r => r.owner === user.id && !r.deleted && Date.parse(r.deleteAt) > Date.now());
        const records = all.filter(r => belongsToScope(r, scope)).filter(r => !query || `${r.title} ${r.segments.map(s => s.text).join(' ')} ${JSON.stringify(r.minutes || '')}`.toLowerCase().includes(query))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(r => ({ id: r.id, title: r.title, workspaceId: r.workspaceId || null, createdAt: r.createdAt, updatedAt: r.updatedAt,
            capture: r.capture, transcription: r.transcription, segments: r.segments.length, hasMinutes: Boolean(r.minutes), seconds: meetingSeconds(r) }));
        send(res, 200, { records }); return;
      }
      const route = path.match(/^\/api\/records\/([a-f0-9-]{36})(?:\/(.*))?$/);
      requireThat(route, 'not_found', 404); const id = route[1], action = route[2] || ''; const record = await owned(id, user);
      if (action === 'automation' && req.method === 'PATCH') {
        const body = await readBody(req, 4000);
        requireThat(!body.enabled || providerStatus(await readConfig(repo.root)).minutes, 'minutes_not_configured', 503);
        const result = await changeOwned(id, user, r => { setAutomation(r, body); return publicRecord(r); });
        send(res, 200, result); return;
      }
      if (action === 'insights' && req.method === 'POST') {
        requireThat(providerStatus(await readConfig(repo.root)).minutes, 'minutes_not_configured', 503);
        await changeOwned(id, user, r => { r.analysisConsent = true; r.insights = null; delete r.intentRetryAt; emit(r, 'intents.requested'); });
        send(res, 202, {queued:true}); return;
      }
      if (action === '' && req.method === 'GET') { send(res, 200, publicRecord(record)); return; }
      if (action.startsWith('minutes/versions/') && req.method === 'GET') {
        const revision = Number(action.slice('minutes/versions/'.length));
        const minutes = [...(record.minutesHistory || []), record.minutes].find(m => m?.revision === revision);
        requireThat(minutes, 'version_not_found', 404); send(res, 200, minutes); return;
      }
      if (action.startsWith('audio/') && req.method === 'GET') {
        requireThat(record.retainAudio && !record.audioPurged && record.capture === 'completed', 'audio_unavailable', 404);
        const chunks = record.chunks.filter(c => c.sourceId === action.slice(6)).sort((a, b) => a.sequence - b.sequence);
        requireThat(chunks.length, 'audio_unavailable', 404);
        const length = chunks.reduce((n, c) => n + c.sampleCount * 2, 0), total = length + 44;
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
        requireThat(start <= end && start < total, 'range_not_satisfiable', 416);
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
          'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}) });
        let offset = 0;
        for (let i = -1; i < chunks.length; i++) {
          if (res.destroyed) break;
          const bytes = i < 0 ? waveHeader(length) : await repo.readAudio(chunks[i].object);
          if (offset <= end && offset + bytes.length > start) {
            const slice = bytes.subarray(Math.max(0, start - offset), Math.min(bytes.length, end - offset + 1));
            if (!res.write(slice)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
          }
          offset += bytes.length; if (offset > end) break;
        }
        res.end(); return;
      }
      if (action === 'events' && req.method === 'GET') {
        let cursor = String(req.headers['last-event-id'] || url.searchParams.get('after') || record.cursor);
        requireThat(/^\d{1,20}$/.test(cursor), 'invalid_cursor', 400);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n'); let busy = false;
        const timer = setInterval(async () => {
          if (busy) return; busy = true;
          try {
            await auth.user(req); const r = await owned(id, user); const first = BigInt(r.events[0]?.cursor || r.cursor);
            if (BigInt(cursor) < first - 1n || BigInt(cursor) > BigInt(r.cursor)) {
              res.write(`event: reset\ndata: ${JSON.stringify({ cursor: r.cursor })}\n\n`); cursor = r.cursor;
            }
            for (const event of r.events.filter(e => BigInt(e.cursor) > BigInt(cursor))) {
              if (!res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)) { res.end(); break; }
              cursor = event.cursor;
            }
            res.write(': heartbeat\n\n');
          } catch { res.write('event: revoked\ndata: {}\n\n'); res.end(); } finally { busy = false; }
        }, 250);
        streams.add(res); req.on('close', () => { clearInterval(timer); streams.delete(res); }); return;
      }
      if (action === 'export' && req.method === 'GET') {
        const format = url.searchParams.get('format') || 'markdown'; requireThat(['markdown', 'json', 'ics', 'issues'].includes(format), 'invalid_format', 400);
        res.writeHead(200, { 'Content-Type': ['json', 'issues'].includes(format) ? 'application/json' : format === 'ics' ? 'text/calendar; charset=utf-8' : 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="meeting.${format === 'markdown' ? 'md' : format === 'issues' ? 'issues.json' : format}"`, 'Cache-Control': 'no-store' }); res.end(exportRecord(record, format)); return;
      }
      if (action === 'audio' && req.method === 'POST') {
        const body = await readBody(req); requireThat(typeof body.pcm === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(body.pcm), 'invalid_pcm', 400);
        const bytes = Buffer.from(body.pcm, 'base64'); requireThat(bytes.length === body.sampleCount * 2 && bytes.length > 0 && bytes.length <= 480000, 'audio_size_mismatch', 400);
        requireThat(digest(bytes) === body.digest, 'audio_digest_mismatch', 400);
        const preflight = acknowledge(structuredClone(record), { sessionId: body.sessionId, sourceId: body.sourceId, epoch: body.epoch, sequence: body.sequence, sampleOffset: body.sampleOffset, sampleCount: body.sampleCount, sampleRate: body.sampleRate, digest: body.digest, object: 'preflight' });
        if (record.chunks.some(c => c.sourceId === body.sourceId && c.epoch === body.epoch && c.sequence === body.sequence)) { send(res, 200, preflight); return; }
        const object = await repo.putAudio(id, bytes);
        const ack = await changeOwned(id, user, r => { requireThat(r.owner === user.id, 'not_found', 404); return acknowledge(r, {
          sessionId: body.sessionId, sourceId: body.sourceId, epoch: body.epoch, sequence: body.sequence, sampleOffset: body.sampleOffset, sampleCount: body.sampleCount, sampleRate: body.sampleRate, traceId, ...object }); });
        telemetry.event('audio.ack', {traceId, recordId:id, sourceId:body.sourceId, sequence:body.sequence, bytes:bytes.length, durationMs:performance.now()-started});
        send(res, 200, ack); return;
      }
      if (action === 'shares' && req.method === 'GET') { send(res, 200, { shares: record.shares.map(({ hash, ...s }) => s) }); return; }
      const body = await readBody(req, 600000);
      let result;
      if (action === 'sources' && req.method === 'POST') result = await changeOwned(id, user, r => addSource(r, body));
      else if (action === 'seal' && req.method === 'POST') result = await changeOwned(id, user, r => { seal(r, body.sources); return publicRecord(r); });
      else if (action === 'pause' && req.method === 'POST') result = await changeOwned(id, user, r => { pause(r, body.sources); return publicRecord(r); });
      else if (action === 'retry' && req.method === 'POST') result = await changeOwned(id, user, r => {
        requireThat(!r.chunks.some(c => c.expired), 'temporary_audio_expired', 410);
        for (const c of r.chunks) if (c.state !== 'done') { c.attempts = 0; c.retryAt = 0; }
        for (const source of r.sources) if (source.asr?.state==='failed') { source.asr.attempts=0;source.asr.retryAt=0; }
        r.transcription = 'queued'; emit(r, 'transcription.retry'); return publicRecord(r);
      });
      else if (action === 'import-text' && req.method === 'POST') result = await changeOwned(id, user, r => {
        requireThat(r.capture !== 'recording' && r.capture !== 'sealed', 'capture_active');
        requireThat(typeof body.text === 'string' && body.text.trim() && body.text.length <= 100000, 'invalid_import', 400);
        const parts = body.text.split(/\n+/).filter(Boolean); requireThat(parts.length <= 1000, 'import_segment_limit', 400);
        for (const text of parts) r.segments.push({ id: randomUUID(), revision: 1, sourceId: 'text-import', startMs: 0, endMs: 0, text, speaker: '', edited: false });
        r.transcriptRevision++; r.capture = 'completed'; r.transcription = 'ready'; emit(r, 'transcript.imported'); return publicRecord(r);
      });
      else if (action.startsWith('segments/') && req.method === 'PATCH') result = await changeOwned(id, user, r => { editSegment(r, action.slice(9), body); return publicRecord(r); });
      else if (action === 'minutes' && req.method === 'POST') {
        const config = await readConfig(repo.root), mode = body.mode || 'model';
        requireThat(['model', 'extractive'].includes(mode), 'invalid_minutes_mode', 400);
        requireThat(mode === 'extractive' || providerStatus(config).minutes || providerStatus(config).fixture, 'minutes_not_configured', 503);
        result = await changeOwned(id, user, r => requestMinutes(r, { ...body, mode, modelVersion: mode === 'extractive' ? 'local-extractive-v1' : config.LLM_MODEL || 'default' }));
      }
      else if (action === 'minutes' && req.method === 'PATCH') result = await changeOwned(id, user, r => {
        requireThat(r.minutes && body.revision === r.minutesRevision, 'minutes_revision_conflict');
        validateMinutes(body.minutes, r.minutes.evidenceSnapshot);
        r.minutesHistory = [...(r.minutesHistory || []), r.minutes].slice(-10);
        r.minutesRevision++; r.minutes = { ...r.minutes, title: body.minutes.title, sections: body.minutes.sections, actions: body.minutes.actions || [], revision: r.minutesRevision, edited: true }; emit(r, 'minutes.edited'); return publicRecord(r);
      });
      else if (action === '' && req.method === 'PATCH') result = await changeOwned(id, user, r => {
        if (body.title !== undefined) { requireThat(typeof body.title === 'string' && body.title.trim(), 'invalid_title', 400); r.title = body.title.trim().slice(0, 160); }
        if (body.notes !== undefined) { requireThat(body.notesRevision === r.notesRevision, 'notes_revision_conflict'); requireThat(typeof body.notes === 'string' && body.notes.length < 20000, 'invalid_notes', 400); r.notes = body.notes; r.notesRevision++; }
        if (body.translationTarget !== undefined) setTranslationTarget(r, body.translationTarget, requireThat);
        emit(r, 'record.updated'); return publicRecord(r);
      });
      else if (action === '' && req.method === 'DELETE') result = await changeOwned(id, user, r => {
        r.deleted = true; r.generation++; r.title = '已删除'; r.segments = []; r.notes = ''; r.minutes = null; r.liveMinutes = null; r.minutesHistory = []; r.insights = null; r.jobs = []; r.shares = []; r.cleanup = 'pending';
        emit(r, 'record.deleted'); return { deleted: true, cleanup: r.cleanup };
      });
      else if (action === 'shares' && req.method === 'POST') {
        requireThat(record.minutes, 'minutes_required'); const token = randomBytes(32).toString('base64url');
        const scope = body.scope || 'minutes'; requireThat(['minutes', 'full'].includes(scope), 'invalid_share_scope', 400);
        const share = { id: randomUUID(), hash: digest(token), scope, expires: Date.now() + 86400000, revoked: false };
        await changeOwned(id, user, r => { r.shares.push(share); emit(r, 'share.created'); }); result = { token, id: share.id, scope, expires: share.expires };
      }
      else if (action.startsWith('shares/') && req.method === 'DELETE') result = await changeOwned(id, user, r => {
        const share = r.shares.find(s => s.id === action.slice(7)); requireThat(share, 'not_found', 404); share.revoked = true; emit(r, 'share.revoked'); return { revoked: true };
      });
      else throw new DomainError('not_found', 404);
      send(res, 200, result);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (!(error instanceof DomainError)) console.error('[record-api]', error.code || error.name);
      send(res, error.status || 500, { error: error.code || 'internal_error' });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return { repo, server, start: () => new Promise(resolve => server.listen(options.port ?? Number(process.env.RECORD_API_PORT || 3030), options.host || '127.0.0.1', () => resolve(server.address()))),
    stop: async () => { for (const stream of streams) stream.end(); await new Promise(resolve => server.close(resolve)); await repo.close(); } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createRecordServer(); console.log('[record-api]', await app.start());
  const stop = async () => { await app.stop(); process.exit(0); }; process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
