export function platformFor({userAgent = '', platform = '', maxTouchPoints = 0, userAgentData} = navigator) {
  const system = `${userAgentData?.platform || platform} ${userAgent}`;
  if (/Android|iPhone|iPad|iPod/i.test(system) || (/Mac/i.test(system) && maxTouchPoints > 1)) return null;
  if (/Windows|Win32|Win64/i.test(system)) return 'windows';
  if (/Mac/i.test(system)) return 'macos';
  if (/Linux/i.test(system)) return 'linux';
  return null;
}

const tabs = [...document.querySelectorAll('[data-download-platform]')];
const panels = [...document.querySelectorAll('[data-download-panel]')];
const status = document.querySelector('#download-status');
const system = platformFor();
function select(platform, focus = false) {
  for (const tab of tabs) {
    const selected = tab.dataset.downloadPlatform === platform;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const panel of panels) panel.hidden = panel.dataset.downloadPanel !== platform;
}
if (tabs.length) {
  select(system || 'windows');
  document.querySelector('#download-device').textContent = system ? '' : '请选择桌面系统；手机暂未提供安装包。';
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.downloadPlatform));
    tab.addEventListener('keydown', event => {
      const index = tabs.indexOf(tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); select(tabs[next].dataset.downloadPlatform, true);
    });
  }
  for (const action of document.querySelectorAll('[data-open-downloads]')) action.addEventListener('click', () => { if (system) select(system); });
  fetch('/api/downloads', {signal: AbortSignal.timeout(15000)}).then(async response => {
    if (!response.ok) throw new Error('unavailable');
    const manifest = await response.json();
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !Array.isArray(manifest.assets)) throw new Error('invalid');
    const files = panels.map(panel => {
      const platform = panel.dataset.downloadPanel, suffix = {macos: 'macos-arm64.dmg', windows: 'windows-x64-setup.exe', linux: 'linux-amd64.deb'}[platform];
      const name = `Lingji-${manifest.version}-${suffix}`, asset = manifest.assets.find(item => item.platform === platform && item.name === name);
      if (!asset || asset.href !== `/downloads/v${manifest.version}/${name}` || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('invalid');
      return {panel, asset};
    });
    document.querySelector('#download-version').textContent = `v${manifest.version} 测试版`;
    for (const {panel, asset} of files) {
      const link = panel.querySelector('a[data-installer]');
      link.href = asset.href; link.download = asset.name; link.removeAttribute('aria-disabled'); link.removeAttribute('tabindex');
      panel.querySelector('[data-file-size]').textContent = `${(asset.size / 1024 ** 2).toFixed(0)} MB`;
      panel.querySelector('[data-checksum]').textContent = asset.sha256;
    }
    status.textContent = '';
  }).catch(() => { status.textContent = '安装包暂不可用，请稍后刷新重试。'; });
}
