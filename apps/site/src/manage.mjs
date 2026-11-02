const byId = id => document.getElementById(id);
async function load() {
  const status = byId('manage-status'), list = byId('manage-list');
  status.textContent = '正在读取…'; list.replaceChildren();
  try {
    const response = await fetch('/api/published', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(response.status === 401 ? '请使用原发布账户登录后管理旧分享。' : '旧分享管理暂不可用，请稍后重试。');
    const { shares } = await response.json();
    byId('manage-login').hidden = true; byId('manage-logout').hidden = false;
    status.textContent = shares.length ? '可以在这里撤销旧版链接。' : '没有已发布的旧链接。';
    for (const share of shares) {
      const row = document.createElement('div'), label = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p');
      row.className = 'history-row'; title.textContent = share.title;
      const active = !share.revoked_at && share.expires_at > Date.now();
      detail.textContent = share.revoked_at ? '已撤销' : active ? '有效至 ' + new Date(share.expires_at).toLocaleString('zh-CN') : '已到期';
      label.append(title, detail); row.append(label);
      if (active) {
        const button = document.createElement('button'); button.className = 'ghost'; button.textContent = '撤销';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { const result = await fetch(`/api/published/${share.id}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) }); if (!result.ok || !(await result.json()).revoked) throw Error(); await load(); status.textContent = '旧链接已撤销。'; }
          catch { status.textContent = '撤销结果未确认，请刷新核对后重试。'; button.disabled = false; }
        }); row.append(button);
      }
      list.append(row);
    }
  } catch (error) { status.textContent = error.message; }
}
byId('manage-refresh').addEventListener('click', () => void load());
await load();
