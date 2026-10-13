// Compiled only with the explicit smoke-test feature. No real audio devices or providers.
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async check => { for (let i = 0; i < 160; i++) { const result = await check(); if (result) return result; await sleep(100); } throw new Error('frontend probe timeout'); };
  try {
    await until(() => document.querySelector('#root')?.textContent?.length > 50);
    const json = async (path, method = 'GET', body, csrf) => {
      const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error(`${path}:${response.status}`); return response.json();
    };
    const initial = await fetch('/api/bootstrap');
    if (initial.status === 401) {
      const retained = localStorage.getItem('native-probe-retained') === 'yes';
      await json(retained ? '/auth/login' : '/auth/register', 'POST', { email: 'native-fixture@local.test', password: 'SyntheticOnly2026!' });
      if (retained) sessionStorage.setItem('native-probe-relogin', 'yes');
      sessionStorage.setItem('native-probe-phase', 'signed-in'); location.reload(); return;
    }
    if (!initial.ok) throw new Error(`bootstrap:${initial.status}`);
    const boot = await initial.json(); const csrf = boot.csrf;
    const priorUiId = localStorage.getItem('native-probe-ui-record');
    let priorUiQueueReplayed = false;
    if (priorUiId) {
      await until(async () => {
        const prior = await json(`/records/${priorUiId}`);
        return prior.sources.length && prior.sources.every(source => source.lastSequence >= 1 && source.watermark === source.lastSequence);
      });
      priorUiQueueReplayed = true;
    }
    const denied = await fetch('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (denied.status !== 403) throw new Error('csrf was not enforced');
    const record = await json('/records', 'POST', { title: '原生客户端合成验收' }, csrf);
    const source = await json(`/records/${record.id}/sources`, 'POST', { kind: 'display', label: '合成音源' }, csrf);
    const stream = await invoke('capture_start', { kind: 'display', deviceId: 'default' });
    const pcm = [];
    const persist = async raw => {
      const view = new DataView(raw), buffer = raw.slice(12), samples = view.getUint32(8, true);
      const sequence = view.getUint32(0, true), offset = view.getUint32(4, true);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), b => b.toString(16).padStart(2, '0')).join('');
      await json(`/records/${record.id}/audio`, 'POST', { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch,
        sequence, sampleOffset: offset, sampleCount: samples, sampleRate: 16000, digest, pcm: btoa(String.fromCharCode(...new Uint8Array(buffer))) }, csrf);
      pcm.push({ sequence, offset, samples, nonzero: new Int16Array(buffer).some(x => x !== 0) });
    };
    for (let n = 0; n < 2; n++) {
      await persist(await invoke('capture_read', { id: stream.id }));
    }
    await invoke('capture_stop', { id: stream.id, discard: false });
    for (;;) { const raw = await invoke('capture_read', { id: stream.id }); if (!raw.byteLength) break; await persist(raw); }
    await json(`/records/${record.id}/pause`, 'POST', { sources: [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: pcm.length - 1 }] }, csrf);
    // Exercise the real React controls, native adapter and persisted queue with uploads offline.
    const actualFetch = window.fetch.bind(window);
    window.fetch = (resource, options) => /\/api\/records\/[^/]+\/audio$/.test(String(resource)) && options?.method === 'POST'
      ? Promise.reject(new TypeError('synthetic upload outage')) : actualFetch(resource, options);
    const quick = await until(() => document.querySelector('button.new-record:not(:disabled)')); quick.click();
    const uiRecordId = await until(() => new URLSearchParams(location.search).get('record'));
    const queueDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open('meeting-studio-audio', 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const pendingUi = () => new Promise((resolve, reject) => {
      const request = queueDatabase.transaction('chunks').objectStore('chunks').index('recordId').count(uiRecordId);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await until(async () => await pendingUi() >= 2);
    const finish = await until(() => document.querySelector('button[aria-label="暂停或结束会议"]:not(:disabled)')); finish.click();
    const pause = await until(() => [...document.querySelectorAll('button')].find(button => !button.disabled && button.textContent.includes('暂停，稍后继续'))); pause.click();
    const uiPaused = await until(async () => { const current = await json(`/records/${uiRecordId}`); return current.capture === 'paused' && current; });
    if (uiPaused.sources.length !== 1 || uiPaused.sources[0].kind !== 'display') throw new Error('native UI opened an implicit microphone');
    const pendingUiPackets = await pendingUi(); queueDatabase.close();
    if (pendingUiPackets < 2 || uiPaused.sources[0].lastSequence !== pendingUiPackets - 1) throw new Error('native UI final manifest differs from saved queue');
    localStorage.setItem('native-probe-ui-record', uiRecordId);
    const database = await new Promise((resolve, reject) => { const r = indexedDB.open('native-probe', 1); r.onupgradeneeded = () => r.result.createObjectStore('proof'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const retained = await new Promise((resolve, reject) => { const r = database.transaction('proof').objectStore('proof').get('retained'); r.onsuccess = () => resolve(Boolean(r.result?.native)); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const t = database.transaction('proof', 'readwrite'); t.objectStore('proof').put({ native: true }, 'retained'); t.oncomplete = resolve; t.onerror = () => reject(t.error); }); database.close();
    const sse = await new Promise((resolve, reject) => { const events = new EventSource(`/api/records/${record.id}/events`); const timer = setTimeout(() => { events.close(); reject(new Error('SSE timeout')); }, 5000); const ok = () => { clearTimeout(timer); events.close(); resolve(true); }; events.onopen = ok; events.onerror = () => {}; });
    const frame = document.createElement('iframe'); frame.src = '/index.html'; document.body.append(frame); await sleep(150);
    const iframeBlocked = !frame.contentDocument?.querySelector('#root'); frame.remove();
    localStorage.setItem('native-probe-retained', 'yes');
    await invoke('client_probe', { result: { ok: true, origin: location.origin, renderer: navigator.userAgent, reactMounted: true, uiRecordId, pendingUiPackets, priorUiQueueReplayed, actualQueueUsed: true, nativeIpc: true, authenticated: true, csrfRejected: true, recordId: record.id, pcm, sse, indexedDbWritten: true, indexedDbRetained: retained, reloginRequired: sessionStorage.getItem('native-probe-relogin') === 'yes', iframeBlocked, kind: 'synthetic-only' } });
  } catch (error) { await invoke('client_probe', { result: { ok: false, error: String(error), phase: sessionStorage.getItem('native-probe-phase') } }); }
})();
