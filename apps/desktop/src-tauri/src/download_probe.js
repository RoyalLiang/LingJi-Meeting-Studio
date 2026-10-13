// Compiled only with smoke-test. Uses a synthetic, isolated meeting and download directory.
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const until = async check => { for (let index = 0; index < 300; index++) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('download probe timeout'); };
  try {
    await until(() => document.querySelector('#root')?.textContent?.length > 30);
    if (sessionStorage.getItem('download-probe-signed-in') !== 'yes') {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'download-fixture@example.invalid', password: 'SyntheticDownload2026!' }) });
      if (!response.ok) throw new Error(`fixture login:${response.status}`);
      sessionStorage.setItem('download-probe-signed-in', 'yes');
      location.href = `/?record=${encodeURIComponent(window.__downloadRecordId)}`; return;
    }
    const share = await until(() => [...document.querySelectorAll('button')].find(button => !button.disabled && button.textContent.trim() === '分享')); share.click();
    const exportButton = await until(() => [...document.querySelectorAll('dialog[open] button')].find(button => !button.disabled && button.textContent.includes('导出分享文件'))); exportButton.click();
    await until(() => document.body.textContent.includes('分享文件已保存至下载文件夹。'));
    await invoke('client_probe', { result: { ok: true, renderer: navigator.userAgent, actualShareDialog: true, blobDownload: true, nativeCompletionFeedback: true, realAudioDevicesOpened: false, realProvidersInvoked: false } });
  } catch (error) { await invoke('client_probe', { result: { ok: false, error: String(error) } }); }
})();
