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
  const until = async (check, budgetMs=16000, label='frontend') => { const origin=new Error().stack; const deadline=performance.now()+budgetMs; while(performance.now()<deadline) { const result=await check(); if(result)return result; await sleep(100); } throw new Error(`${label} probe timeout: ${origin}`); };
  try {
    await until(() => document.querySelector('#root')?.textContent?.length > 50,16000,'React mounted');
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
    const openSettings=async()=>{
      (await until(()=>document.querySelector('button[aria-label="设置与诊断"]'),16000,'settings opener')).click();
      const dialog=await until(()=>document.querySelector('dialog.modal[open]'),16000,'settings opened');
      if(['浏览器能力检测','删除清理','使用与诊断'].some(text=>dialog.textContent.includes(text)))throw new Error('unused settings modules remain');
      if(!dialog.querySelector('input,select,button'))throw new Error('settings controls missing');
      await until(()=>dialog.querySelector('input[name=LLM_REASONING_EFFORT]'),16000,'reasoning setting');
      dialog.querySelector('.modal-close').click();await until(()=>!document.querySelector('dialog.modal[open]'),16000,'settings closed');
    };
    await openSettings();await openSettings();
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
      await invoke('capture_ack', { id:stream.id,sequence,sampleOffset:offset,sampleCount:samples });
      pcm.push({ sequence, offset, samples, nonzero: new Int16Array(buffer).some(x => x !== 0) });
    };
    for (let n = 0; n < 2; n++) {
      await persist(await invoke('capture_read', { id: stream.id }));
    }
    await invoke('capture_stop', { id: stream.id, discard: false });
    for (;;) { const raw = await invoke('capture_read', { id: stream.id }); if (!raw.byteLength) break; await persist(raw); }
    await json(`/records/${record.id}/pause`, 'POST', { sources: [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: pcm.length - 1 }] }, csrf);
    // Exercise the real React controls, native adapter and persisted queue with uploads offline.
    const previousSelection=new URLSearchParams(location.search).get('record');
    await invoke('client_probe',{result:{widgetAction:'hold-ready'}});
    (await until(()=>document.querySelector('button.new-record:not(:disabled)'))).click();
    const healthyId=await until(()=>{const id=new URLSearchParams(location.search).get('record');return id&&id!==previousSelection?id:null;});
    await until(async()=>{const r=await json(`/records/${healthyId}`);return r.sources.length===2&&r.sources.every(source=>source.watermark>=1);},16000,'healthy capture');
    await until(async()=>(await invoke('client_probe',{result:{widgetAction:'snapshot'}})).widgetRecording);
    for(let i=0;i<3;i++){
      const s=await invoke('client_probe',{result:{widgetAction:'snapshot'}});
      if(s.ready||s.widgetVisible||!s.mainVisible)throw new Error('unready capsule became visible or hid main');
      await sleep(100);
    }
    const hoverButton=await until(()=>document.querySelector('.meeting-header .meeting-actions button[data-tooltip]'));
    // Number-label styles must not affect the shared hint.
    hoverButton.classList.add('player-jump');
    hoverButton.dispatchEvent(new PointerEvent('pointerenter'));
    const tooltip=await until(()=>{const t=document.getElementById(hoverButton.getAttribute('aria-describedby'));return t?.matches(':popover-open')?t:null;},16000,'toolbar tooltip shown');
    const tooltipRect=tooltip.getBoundingClientRect();
    if(parseFloat(getComputedStyle(tooltip).fontSize)<12)throw new Error('player styles shrank toolbar hint');
    if(tooltipRect.width<=0||tooltipRect.left<0||tooltipRect.top<0||tooltipRect.right>innerWidth||tooltipRect.bottom>innerHeight)throw new Error('toolbar tooltip clipped or outside viewport');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    if(tooltip.matches(':popover-open'))throw new Error('unfocused toolbar tooltip ignored Escape');
    hoverButton.dispatchEvent(new PointerEvent('pointerleave'));
    hoverButton.classList.remove('player-jump');
    await invoke('client_probe',{result:{widgetAction:'release-ready'}});
    const readyCapsule=await invoke('client_probe',{result:{widgetAction:'snapshot'}});
    if(!readyCapsule.widgetVisible||readyCapsule.mainVisible||Math.abs(readyCapsule.widgetLogicalHeight-42)>1)throw new Error('ready capsule handoff or compact height failed');
    if(!readyCapsule.placement||Math.abs(readyCapsule.placement.width-340)>1||Math.abs(readyCapsule.placement.topGap-16)>1||Math.abs(readyCapsule.placement.centerOffset)>1)throw new Error('capsule width or top-center placement failed');
    const displaced=(await invoke('client_probe',{result:{widgetAction:'displace'}})).placement;
    if(!displaced||(Math.abs(displaced.topGap-16)<=1&&Math.abs(displaced.centerOffset)<=1))throw new Error('capsule displacement did not take effect');
    await until(async()=>{const p=(await invoke('client_probe',{result:{widgetAction:'snapshot'}})).placement;return p&&Math.abs(p.topGap-16)<=1&&Math.abs(p.centerOffset)<=1;},16000,'capsule re-anchoring');
    await until(async()=>{const s=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return s.widgetVisible&&(!s.mainVisible||s.mainMinimized);});
    await invoke('client_probe',{result:{widgetAction:'pause'}});
    await until(async()=>{const r=await json(`/records/${healthyId}`);return r.capture==='paused'&&r.sources.every(source=>source.watermark===source.lastSequence);});
    await until(async()=>{const s=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return s.widgetVisible&&(!s.mainVisible||s.mainMinimized)&&s.canResume;},16000,'paused capsule retention');
    await invoke('client_probe',{result:{widgetAction:'pause'}});
    await until(async()=>{const r=await json(`/records/${healthyId}`);return r.capture==='recording'&&r.sources.length===4&&r.sources.slice(-2).every(source=>source.watermark>=1);},16000,'capsule resume');
    await invoke('client_probe',{result:{widgetAction:'pause'}});
    await until(async()=>{const r=await json(`/records/${healthyId}`);return r.capture==='paused'&&r.sources.every(source=>source.watermark===source.lastSequence);});
    await invoke('client_probe',{result:{widgetAction:'native-restore'}});
    await until(async()=>{const s=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return s.mainVisible&&!s.mainMinimized&&!s.widgetVisible;});
    await sleep(1200);
    if((await invoke('client_probe',{result:{widgetAction:'snapshot'}})).widgetVisible)throw new Error('capsule reappeared after native main restore');
    await invoke('client_probe',{result:{widgetAction:'hold-ready'}});
    await invoke('client_probe',{result:{widgetAction:'pause'}});
    await until(async()=>{const r=await json(`/records/${healthyId}`);return r.capture==='recording';});
    await until(async()=>(await invoke('client_probe',{result:{widgetAction:'snapshot'}})).widgetRecording);
    await invoke('client_probe',{result:{widgetAction:'native-minimize'}});
    await until(async()=>(await invoke('client_probe',{result:{widgetAction:'snapshot'}})).mainMinimized);
    await invoke('client_probe',{result:{widgetAction:'native-restore'}});
    await until(async()=>{const s=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return s.mainVisible&&!s.mainMinimized;});
    await sleep(200);
    await invoke('client_probe',{result:{widgetAction:'release-ready'}});
    const lateReady=await invoke('client_probe',{result:{widgetAction:'snapshot'}});
    if(!lateReady.mainVisible||lateReady.widgetVisible)throw new Error('late ready overrode native main restore');
    for(const action of ['native-minimize','native-close']) {
      await invoke('client_probe',{result:{widgetAction:action}});
      await until(async()=>{const s=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return s.widgetVisible&&(!s.mainVisible||s.mainMinimized);},16000,'repeated capsule '+action);
      await invoke('client_probe',{result:{widgetAction:'restore'}});
      await until(async()=>{const s=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return s.mainVisible&&!s.mainMinimized&&!s.widgetVisible;},16000,'repeated capsule restore');
    }

    await invoke('client_probe',{result:{widgetAction:'pause'}});
    await until(async()=>{const r=await json(`/records/${healthyId}`);return r.capture==='paused'&&r.sources.every(source=>source.watermark===source.lastSequence);});
    const actualFetch = window.fetch.bind(window);
    window.fetch = (resource, options) => /\/api\/records\/[^/]+\/audio$/.test(String(resource)) && options?.method === 'POST'
      ? Promise.reject(new TypeError('synthetic upload outage')) : actualFetch(resource, options);
    for(let attempt=0;attempt<2;attempt++) {
      const settings=await until(()=>document.querySelector('button[aria-label="设置与诊断"]:not(:disabled)'));settings.click();
      const dialog=await until(()=>document.querySelector('dialog.modal[open]'),16000,'settings opened');
      dialog.dispatchEvent(new Event('cancel',{cancelable:true}));
      await until(()=>!document.querySelector('dialog.modal[open]'));
    }
    const quick = await until(() => document.querySelector('button.new-record:not(:disabled)')); quick.click();
    const uiRecordId = await until(() => {const id=new URLSearchParams(location.search).get('record');return id&&id!==healthyId?id:null;},16000,'new offline record selection');
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
    await until(async()=>{const state=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return state.ready&&state.widgetVisible&&(!state.mainVisible||state.mainMinimized);});
    await invoke('client_probe',{result:{widgetAction:'restore'}});
    await until(async()=>{const state=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return state.mainVisible&&!state.mainMinimized&&!state.widgetVisible;});
    const recordingWidget={loadedPrivateSession:true,automaticallyMinimized:true,pause:true,resume:true,pausedCapsuleRetained:true,restoredMain:true,finishConfirmation:true,queuedAudioClock:true,coldReadyExclusive:true,nativeRestore:true,compactHeight:true,topCentered:true,compactWidth:true,reanchored:true,lateReadyCancelled:true};
    const widgetBefore=await invoke('client_probe',{result:{widgetAction:'snapshot'}});
    await invoke('client_probe', {result:{residentAction:'close'}});
    await until(async()=>{const state=await invoke('client_probe',{result:{residentAction:'snapshot'}});return !state.visible&&state.nativeActive;});
    await sleep(window.__nativeBackgroundMs||9000);
    const whileHidden = await pendingUi();
    for(const source of (await json(`/records/${uiRecordId}`)).sources){
      const before=beforeHidden.filter(entry=>entry.chunk.sourceId===source.id).length;
      const after=whileHidden.filter(entry=>entry.chunk.sourceId===source.id).length;
      if(after<before+4)throw new Error('hidden window did not continue native capture and durable queue');
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
    for(const source of uiPaused.sources){
      const samples=entries=>entries.filter(entry=>entry.chunk.sourceId===source.id).reduce((total,entry)=>total+entry.chunk.sampleCount,0);
      const seconds=(samples(queuedUi)-samples(beforeHidden))/16000;
      if(seconds < (window.__nativeBackgroundMs||9000)/1000*.9-2)throw new Error(`${source.kind} drained hidden sample coverage ${seconds}s fell behind configured ${(window.__nativeBackgroundMs||9000)/1000}s`);
    }
    await until(async()=>{const after=await invoke('client_probe',{result:{widgetAction:'snapshot'}});return after.widgetDurationMs-widgetBefore.widgetDurationMs >= (window.__nativeBackgroundMs||9000)*.9-2000;},16000,'queued capsule clock after stop drain');
    const uiLanes = await verifyNativeUiLanes(uiPaused, queuedUi), pendingUiPackets = queuedUi.length;
    localStorage.setItem('native-probe-ui-record', uiRecordId);
    const database = await new Promise((resolve, reject) => { const r = indexedDB.open('native-probe', 1); r.onupgradeneeded = () => r.result.createObjectStore('proof'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const retained = await new Promise((resolve, reject) => { const r = database.transaction('proof').objectStore('proof').get('retained'); r.onsuccess = () => resolve(Boolean(r.result?.native)); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const t = database.transaction('proof', 'readwrite'); t.objectStore('proof').put({ native: true }, 'retained'); t.oncomplete = resolve; t.onerror = () => reject(t.error); }); database.close();
    const sse = await new Promise((resolve, reject) => { const events = new EventSource(`/api/records/${record.id}/events`); const timer = setTimeout(() => { events.close(); reject(new Error('SSE timeout')); }, 5000); const ok = () => { clearTimeout(timer); events.close(); resolve(true); }; events.onopen = ok; events.onerror = () => {}; });
    const frame = document.createElement('iframe'); frame.src = '/index.html'; document.body.append(frame); await sleep(150);
    const iframeBlocked = !frame.contentDocument?.querySelector('#root'); frame.remove();
    localStorage.setItem('native-probe-retained', 'yes');
    await invoke('client_probe', { result: { ok: true, residentCapture, origin: location.origin, renderer: navigator.userAgent, reactMounted: true, settingsCancelReopen:true, settingsSimplified:true, toolbarTooltip:true, uiRecordId, uiLanes, recordingWidget, pendingUiPackets, priorUiQueueReplayed, actualQueueUsed: true, nativeIpc: true, authenticated: true, csrfRejected: true, recordId: record.id, pcm, sse, indexedDbWritten: true, indexedDbRetained: retained, reloginRequired: sessionStorage.getItem('native-probe-relogin') === 'yes', iframeBlocked, kind: 'synthetic-only' } });
  } catch (error) { await invoke('client_probe', { result: { ok: false, error: String(error), phase: sessionStorage.getItem('native-probe-phase') } }); }
})();
