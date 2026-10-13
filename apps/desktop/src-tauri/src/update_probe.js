// Explicit smoke-test build only. The installer destination is restricted to the fixture directory in Rust.
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  // Test-only IPC controls activity; real React reporting stays out of these fixtures.
  const report = activity => invoke('client_probe', { result: { updateActivity: activity } });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const idle = { authenticated: true, recording: false, paused: false, busy: false, queueBusy: false, pendingBytes: 0, pendingCount: 0 };
  try {
    localStorage.setItem('meeting-client-updates-v1', JSON.stringify({ autoCheck: false, autoDownload: false, autoInstall: false }));
    const initial = await fetch('/api/bootstrap');
    const json = async (path, method = 'GET', body, csrf) => {
      const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body && JSON.stringify(body) });
      if (!response.ok) throw new Error(`${path}:${response.status}`); return response.json();
    };
    if (initial.status === 401) {
      try { await json('/auth/login', 'POST', { email: 'update-fixture@local.test', password: 'SyntheticOnly2026!' }); }
      catch { await json('/auth/register', 'POST', { email: 'update-fixture@local.test', password: 'SyntheticOnly2026!' }); }
      location.reload(); return;
    }
    const boot = await initial.json(), testCase = window.__updateCase;
    if (testCase === 'invalid') {
      let rejected = false; try { await invoke('update_check'); } catch { rejected = true; }
      if (!rejected || (await invoke('update_status')).phase !== 'error') throw new Error('invalid metadata accepted');
      await invoke('client_probe', { result: { ok: true, testCase, invalidMetadataRejected: true } }); return;
    }
    const checked = await invoke('update_check');
    if (testCase === 'none') {
      if (checked.phase !== 'current') throw new Error('204 not recognized');
      await invoke('client_probe', { result: { ok: true, testCase, noUpdate: true } }); return;
    }
    if (checked.phase !== 'available') throw new Error(`update unavailable:${checked.phase}`);
    if (testCase === 'bad-signature' || testCase === 'wrong-version') {
      let rejected = false; try { await invoke('update_download'); } catch { rejected = true; }
      if (!rejected || (await invoke('update_status')).phase === 'ready') throw new Error('invalid signature/version accepted');
      await invoke('client_probe', { result: { ok: true, testCase, signatureOrVersionRejected: true } }); return;
    }
    const ready = await invoke('update_download'); if (ready.phase !== 'ready') throw new Error('download not ready');
    let blocked = 0;
    const mustBlock = async activity => {
      await report(activity);
      try { await invoke('update_install'); } catch { blocked++; return; }
      throw new Error(`unsafe-install-v2:${JSON.stringify(activity)}`);
    };
    for (const activity of [{ ...idle, recording: true }, { ...idle, paused: true }, { ...idle, pendingBytes: 2 }, { ...idle, pendingCount: 1 }, { ...idle, queueBusy: true }]) await mustBlock(activity);
    const stream = await invoke('capture_start', { kind: 'display', deviceId: 'default' });
    await mustBlock(idle); await invoke('capture_stop', { id: stream.id, discard: true });
    await report(idle); await sleep(4500);
    try { await invoke('update_install'); throw new Error('stale status accepted'); } catch (error) { if (String(error).includes('stale status accepted')) throw error; blocked++; }
    const record = await json('/records', 'POST', {}, boot.csrf), source = await json(`/records/${record.id}/sources`, 'POST', { kind: 'display' }, boot.csrf);
    const manifest = { sources: [{ sourceId: source.id, epoch: source.epoch, lastSequence: -1 }] };
    await json(`/records/${record.id}/pause`, 'POST', manifest, boot.csrf); await mustBlock(idle);
    await json(`/records/${record.id}/seal`, 'POST', manifest, boot.csrf);
    await report(idle); await invoke('update_install');
    if ((await invoke('update_status')).phase !== 'installed') throw new Error('sandbox installer did not complete');
    await invoke('client_probe', { result: { ok: true, testCase, signedDownload: true, blockedInstalls: blocked, sandboxInstall: true } });
  } catch (error) { await invoke('client_probe', { result: { ok: false, testCase: window.__updateCase, error: String(error) } }); }
})();
