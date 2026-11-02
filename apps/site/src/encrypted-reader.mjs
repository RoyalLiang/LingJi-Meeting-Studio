import { decryptShare, SHARE_TOKEN } from '../../../packages/records/src/encrypted-share.mjs';
import { createShareDocument } from '../../web/src/share-content.ts';

const status = document.getElementById('encrypted-status'), frame = document.getElementById('encrypted-content');
const token = location.pathname.split('/').at(-1), key = location.hash.slice(1);
let expires = 0, timer, checking = false, stopped = false;
function clear(message) { stopped = true; clearInterval(timer); frame.srcdoc = ''; frame.hidden = true; status.textContent = message; }
async function check() {
  if (checking || stopped || !expires) return;
  if (Date.now() >= expires) { clear('链接已到期或已撤销。'); return; }
  checking = true;
  try {
    const response = await fetch(`/api/encrypted-shares/${token}/status`, { cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
    if ([404, 410].includes(response.status)) clear('链接已到期或已撤销。');
    else if (!response.ok) clear('暂时无法确认链接状态，请刷新后重试。');
  } catch { clear('连接中断，暂时停止显示内容。请刷新后重试。'); }
  finally { checking = false; }
}
try {
  if (!SHARE_TOKEN.test(token) || !SHARE_TOKEN.test(key)) throw new Error('missing_key');
  const response = await fetch(`/api/encrypted-shares/${token}`, { cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error([404, 410].includes(response.status) ? 'unavailable' : 'network');
  const value = await response.json(), content = await decryptShare(value.envelope, key, token);
  if (!Number.isFinite(value.expires) || value.expires <= Date.now()) throw new Error('unavailable');
  expires = value.expires;
  frame.srcdoc = createShareDocument({ id: content.sourceRecordId, title: content.title, capture: content.draft ? 'recording' : 'completed', minutes: content.minutes, segments: content.segments || [] }, content.scope, true).replaceAll('href="#', 'href="about:srcdoc#');
  frame.hidden = false;
  status.textContent = `已在本地解密 · 链接有效至 ${new Date(expires).toLocaleString('zh-CN')}`;
  timer = setInterval(() => void check(), 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
} catch (error) {
  clear(error.message === 'missing_key' ? '链接不完整，缺少解密密钥。请向分享者索取完整链接。' : error.message === 'unavailable' ? '链接已到期、已撤销或不存在。' : '无法解密这份内容。请核对完整链接，或稍后刷新重试。');
}
