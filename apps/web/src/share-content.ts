import { truncateText } from '../../../packages/records/src/text.mjs';
import type { Evidence, Minutes, RecordDetail, Segment, SummaryTable } from './model';
import { sharedMinutes } from '../../../packages/records/src/shared-content.mjs';

export type ShareScope = 'minutes' | 'full';
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const refId = (ref: Evidence) => `source-${encodeURIComponent(ref.segmentId)}-${ref.revision}`;
const clock = (milliseconds: number) => `${Math.floor(milliseconds / 60000).toString().padStart(2, '0')}:${Math.floor(milliseconds / 1000 % 60).toString().padStart(2, '0')}`;

export function canCreateShareLinks(localAccount: boolean, origin: string) {
  if (localAccount) return false;
  try {
    const url = new URL(origin), host = url.hostname.toLowerCase();
    return ['http:', 'https:'].includes(url.protocol) && !['localhost', '[::1]', '::1', '0.0.0.0', '[::]', '::'].includes(host) && !host.endsWith('.localhost') && !/^127(?:\.\d{1,3}){1,3}$/.test(host);
  } catch { return false; }
}

export function minutesForShare(record: Pick<RecordDetail, 'capture' | 'minutes' | 'liveMinutes'>): Minutes | null {
  return (record.capture === 'completed' ? record.minutes || record.liveMinutes : record.liveMinutes || record.minutes) || null;
}

export function shareFilename(title: string) {
  return `${truncateText(title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim(), 80) || '会议纪要'}.html`;
}

export function createShareDocument(record: RecordDetail, scope: ShareScope = 'minutes', includeSources = false) {
  const minutes = sharedMinutes(minutesForShare(record), { includeEvidence: includeSources });
  const citations = (refs: Evidence[] = []) => refs.length ? `<span class="sources">${refs.map((ref, index) => `<a href="#${escapeHtml(refId(ref))}">来源 ${index + 1}</a>`).join(' ')}</span>` : '';
  const item = (value: { text: string; evidence: Evidence[] }) => `<li><p>${escapeHtml(value.text)}</p>${citations(value.evidence)}</li>`;
  const table = (value: SummaryTable) => `<section class="table"><h3>${escapeHtml(value.title)}</h3><div class="table-scroll"><table><thead><tr>${value.columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}${includeSources ? '<th>来源</th>' : ''}</tr></thead><tbody>${value.rows.map(row => `<tr>${row.cells.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}${includeSources ? `<td class="table-sources">${citations(row.evidence)}</td>` : ''}</tr>`).join('')}</tbody></table></div></section>`;
  const source = (segment: Segment, frozen: boolean) => `<li${frozen ? ` id="${escapeHtml(refId({segmentId: segment.id, revision: segment.revision}))}"` : ''}><div class="source-meta"><b>${escapeHtml(segment.speaker || '未标注说话人')}</b><time>${clock(segment.startMs)}–${clock(segment.endMs)}</time>${frozen ? `<small>片段 v${segment.revision}</small>` : ''}</div><p>${escapeHtml(segment.text)}</p></li>`;
  const body: string[] = [];
  if (minutes) {
    if (minutes.highlights?.length) body.push(`<section><h2>重点速览</h2><ul>${minutes.highlights.map(item).join('')}</ul></section>`);
    for (const visual of minutes.visuals || []) body.push(`<section><h2>${escapeHtml(visual.title)}</h2>${visual.kind === 'timeline' ? `<p>按会议提及顺序排列，时间保留原话</p><ul>${visual.entries.map(entry => item({text:`${entry.label}：${entry.text}`,evidence:entry.evidence})).join('')}</ul>` : `<p>单位：${escapeHtml(visual.unit)}</p><ul>${visual.entries.map(entry => item({text:`${entry.label}：${entry.valueText} ${visual.unit}`,evidence:entry.evidence})).join('')}</ul>`}</section>`);
    const assigned = new Set<SummaryTable>();
    for (const topic of minutes.topics || []) {
      const tables = (minutes.tables || []).filter(value => topic.id && value.topicId === topic.id);
      tables.forEach(value => assigned.add(value));
      body.push(`<section><h2>${escapeHtml(topic.title)}</h2><p>${escapeHtml(topic.summary)}</p>${citations(topic.evidence)}${tables.map(table).join('')}</section>`);
    }
    for (const section of minutes.sections) body.push(`<section><h2>${escapeHtml(section.heading)}</h2><ul>${section.items.map(item).join('')}</ul></section>`);
    if (minutes.currentDiscussion?.length) body.push(`<section><h2>当前讨论</h2><ul>${minutes.currentDiscussion.map(item).join('')}</ul></section>`);
    for (const value of minutes.tables || []) if (!assigned.has(value)) body.push(table(value));
    if (minutes.decisions?.length) body.push(`<section><h2>关键决策</h2><ul>${minutes.decisions.map(item).join('')}</ul></section>`);
    if (minutes.actions.length) body.push(`<section><h2>行动事项</h2><ul>${minutes.actions.map(value => item({ ...value, text: `${value.text}${value.owner ? ` · ${value.owner}` : ''}${value.due ? ` · ${value.due}` : ''}` })).join('')}</ul></section>`);
    if (minutes.speakerSummaries?.length) body.push(`<section><h2>发言人总结</h2>${minutes.speakerSummaries.map(value => `<h3>${escapeHtml(value.speaker)}</h3><p>${escapeHtml(value.summary)}</p>${citations(value.evidence)}`).join('')}</section>`);
    if (includeSources && minutes.evidenceSnapshot.length) body.push(`<section><h2>纪要引用原文</h2><ol class="transcript">${minutes.evidenceSnapshot.map(segment => source(segment, true)).join('')}</ol></section>`);
  }
  if (includeSources && scope === 'full' && record.segments.length) body.push(`<section><h2>全部转录</h2><ol class="transcript">${record.segments.map(segment => source(segment, false)).join('')}</ol></section>`);
  const draft = includeSources && (!record.minutes || record.capture !== 'completed');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(record.title)} · 聆记</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f7f5;color:#203e32;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:900px;margin:32px auto;padding:40px;background:#fff;border:1px solid #dce7e0;border-radius:20px}header{border-bottom:1px solid #dce7e0;padding-bottom:24px}header small,.source-meta,.sources{color:#64796d;font-size:13px}h1{font-size:30px;line-height:1.3;margin:10px 0}h2{font-size:21px;margin:0 0 14px}h3{font-size:17px;margin:0 0 10px}section{margin-top:32px}p{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}ul{padding-left:24px}li{margin:12px 0}.sources{display:flex;gap:10px;flex-wrap:wrap}.sources a{color:#2b7457;text-decoration:underline;text-underline-offset:3px}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #dce7e0;vertical-align:top;overflow-wrap:anywhere}th{background:#edf4ef}.transcript{list-style:none;padding:0}.transcript li{padding:14px 16px;background:#f4f7f5;border-radius:12px;scroll-margin-top:20px}.transcript li:target{outline:2px solid #2b7457}.source-meta{display:flex;gap:12px;flex-wrap:wrap}.source-meta b{font-weight:600}footer{margin-top:40px;color:#64796d;font-size:12px}@media(max-width:600px){body{font-size:15px}main{margin:0;padding:24px 18px;border-radius:0;border:0}h1{font-size:25px}}@media(prefers-color-scheme:dark){body{background:#15221c;color:#e0ebe4}main{background:#1d2e25;border-color:#354a3d}header,th,td{border-color:#354a3d}th,.transcript li{background:#263b30}.source-meta,.sources,header small,footer{color:#a1b8a9}.sources a{color:#9ed8b9}}@media print{body,main{background:white;color:black}main{padding:0;margin:0;border:0;max-width:none}section{break-inside:avoid}a{color:inherit}}
</style></head><body><main><header><small>聆记 · ${draft ? '纪要草稿' : '智能会议纪要'} · 内容快照</small><h1>${escapeHtml(record.title)}</h1><small>${includeSources ? (scope === 'full' ? '纪要与全部转录' : '仅纪要及引用原文') : '会议纪要'}</small></header>${body.join('')}<footer>由聆记导出</footer></main></body></html>`;
}
