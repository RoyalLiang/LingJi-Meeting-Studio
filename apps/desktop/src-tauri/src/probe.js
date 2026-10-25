// Compiled only with the explicit smoke-test feature. No real audio devices or providers.
async function verifyNativeUiLanes(record, queued) {
  if (record.sources.length !== 2 || [...record.sources.map(source => source.kind)].sort().join(',') !== 'display,microphone') throw new Error('native UI did not open both default audio lanes');
  const reports = [];
  for (const source of record.sources) {
    const packets = queued.filter(entry => entry.chunk.sourceId === source.id).map(entry => entry.chunk).sort((a, b) => a.sequence - b.sequence);
    if (!source.stopped || packets.length < 2 || source.lastSequence !== packets.length - 1) throw new Error('native UI final manifest differs from saved source queue');
    let offset = 0;
    for (const [sequence, packet] of packets.entries()) {
      if (packet.sessionId !== source.sessionId || packet.epoch !== source.epoch || packet.sequence !== sequence || packet.sampleOffset !== offset || packet.sampleRate !== 16000 || !Number.isInteger(packet.sampleCount) || packet.sampleCount < 1) throw new Error('native UI queued source identity or sample timeline mismatch');
      const bytes = Uint8Array.from(atob(packet.pcm), character => character.charCodeAt(0));
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== packet.sampleCount * 2 || digest !== packet.digest || !new Int16Array(bytes.buffer).some(sample => sample !== 0)) throw new Error('native UI queued source audio differs from its durable identity');
      offset += packet.sampleCount;
    }
    reports.push({ sourceId: source.id, kind: source.kind, sessionId: source.sessionId, epoch: source.epoch, packets: packets.length, samples: offset });
  }
  if (reports.reduce((count, source) => count + source.packets, 0) !== queued.length) throw new Error('unexpected queued audio source');
  return reports;
}

(async () => {
  if(window.__nativeProbeStarted)return;window.__nativeProbeStarted=true;
 const invoke = window.__TAURI_INTERNALS__.invoke;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, budgetMs=16000, label='frontend') => { const deadline=performance.now()+budgetMs; while(performance.now()<deadline) { const result=await check(); if(result)return result; await sleep(100); } throw new Error(`${label} probe timeout`); };
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
      let replayState=[];
      try { await until(async () => {
        const prior = await json(`/records/${priorUiId}`);
        replayState=prior.sources.map(({kind,lastSequence,watermark,stopped})=>({kind,lastSequence,watermark,stopped}));
        return prior.sources.length === 2 && prior.sources.map(source => source.kind).sort().join(',') === 'display,microphone' && prior.sources.every(source => source.lastSequence >= 1 && source.watermark === source.lastSequence && source.stopped);
      },120000,'restart queue replay'); } catch(error) { throw new Error(`${error}: ${JSON.stringify(replayState)}`); }
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
    for(let attempt=0;attempt<2;attempt++) {
      const settings=await until(()=>document.querySelector('button[aria-label="设置与诊断"]:not(:disabled)'));settings.click();
      const dialog=await until(()=>document.querySelector('dialog.modal[open]'));
      dialog.dispatchEvent(new Event('cancel',{cancelable:true}));
      await until(()=>!document.querySelector('dialog.modal[open]'));
    }
    const quick = await until(() => document.querySelector('button.new-record:not(:disabled)')); quick.click();
    const uiRecordId = await until(() => new URLSearchParams(location.search).get('record'));
    const queueDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open('meeting-studio-audio', 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const pendingUi = () => new Promise((resolve, reject) => {
      const request = queueDatabase.transaction('chunks').objectStore('chunks').index('recordId').getAll(uiRecordId);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await until(async () => { const queued = await pendingUi(), counts = new Map(); for (const entry of queued) counts.set(entry.chunk.sourceId, (counts.get(entry.chunk.sourceId) || 0) + 1); return counts.size === 2 && [...counts.values()].every(count => count >= 2); });
    const beforeHidden = await pendingUi();
    await until(async()=>{const state=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return state.ready&&state.widgetVisible&&state.mainMinimized;});
    await invoke('client_probe',{result:{widgetAction:'restore'}});
    await until(async()=>{const state=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return state.mainVisible&&!state.mainMinimized&&!state.widgetVisible;});
    const recordingWidget={loadedPrivateSession:true,automaticallyMinimized:true,pause:true,restoredMain:true,finishConfirmation:true};
    await invoke('client_probe', {result:{residentAction:'close'}});
    await until(async()=>{const state=await invoke('client_probe',{result:{residentAction:'snapshot'}});return !state.visible&&state.nativeActive;});
    await sleep(window.__nativeBackgroundMs||9000);
    const whileHidden = await pendingUi();
    for(const source of (await json(`/records/${uiRecordId}`)).sources){
      const before=beforeHidden.filter(entry=>entry.chunk.sourceId===source.id).length;
      const after=whileHidden.filter(entry=>entry.chunk.sourceId===source.id).length;
      if(after<before+4)throw new Error('hidden window did not continue native capture and durable queue');
      const samples=entries=>entries.filter(entry=>entry.chunk.sourceId===source.id).reduce((total,entry)=>total+entry.chunk.sampleCount,0);
      if((samples(whileHidden)-samples(beforeHidden))/16000 < (window.__nativeBackgroundMs||9000)/1000*.9-2)throw new Error('hidden recording sample coverage fell behind its wall clock');
    }
    if((await json(`/records/${uiRecordId}`)).capture!=='recording')throw new Error('window close paused recording');
    await invoke('client_probe',{result:{residentAction:'restore'}});
    await until(async()=>(await invoke('client_probe',{result:{residentAction:'snapshot'}})).visible);
    const residentCapture={hiddenWindow:true,continuedNativeCapture:true,continuedDurableQueue:true,recordingNotPaused:true,restoredWindow:true,hiddenMs:window.__nativeBackgroundMs||9000,sampleCoverageVerified:true};
    await invoke('client_probe',{result:{widgetAction:'finish'}});
    await until(()=>document.querySelector('dialog.modal[open]'));
    document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}));
    await until(()=>!document.querySelector('dialog.modal[open]'));
    await invoke('client_probe',{result:{widgetAction:'pause'}});
    const uiPaused = await until(async () => { const current = await json(`/records/${uiRecordId}`); return current.capture === 'paused' && current; });
    const queuedUi = await pendingUi(); queueDatabase.close();
    const uiLanes = await verifyNativeUiLanes(uiPaused, queuedUi), pendingUiPackets = queuedUi.length;
    localStorage.setItem('native-probe-ui-record', uiRecordId);
    const database = await new Promise((resolve, reject) => { const r = indexedDB.open('native-probe', 1); r.onupgradeneeded = () => r.result.createObjectStore('proof'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const retained = await new Promise((resolve, reject) => { const r = database.transaction('proof').objectStore('proof').get('retained'); r.onsuccess = () => resolve(Boolean(r.result?.native)); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const t = database.transaction('proof', 'readwrite'); t.objectStore('proof').put({ native: true }, 'retained'); t.oncomplete = resolve; t.onerror = () => reject(t.error); }); database.close();
    const sse = await new Promise((resolve, reject) => { const events = new EventSource(`/api/records/${record.id}/events`); const timer = setTimeout(() => { events.close(); reject(new Error('SSE timeout')); }, 5000); const ok = () => { clearTimeout(timer); events.close(); resolve(true); }; events.onopen = ok; events.onerror = () => {}; });
    const frame = document.createElement('iframe'); frame.src = '/index.html'; document.body.append(frame); await sleep(150);
    const iframeBlocked = !frame.contentDocument?.querySelector('#root'); frame.remove();
    localStorage.setItem('native-probe-retained', 'yes');
    await invoke('client_probe', { result: { ok: true, residentCapture, origin: location.origin, renderer: navigator.userAgent, reactMounted: true, settingsCancelReopen:true, uiRecordId, uiLanes, recordingWidget, pendingUiPackets, priorUiQueueReplayed, actualQueueUsed: true, nativeIpc: true, authenticated: true, csrfRejected: true, recordId: record.id, pcm, sse, indexedDbWritten: true, indexedDbRetained: retained, reloginRequired: sessionStorage.getItem('native-probe-relogin') === 'yes', iframeBlocked, kind: 'synthetic-only' } });
  } catch (error) { await invoke('client_probe', { result: { ok: false, error: String(error), phase: sessionStorage.getItem('native-probe-phase') } }); }
})();
