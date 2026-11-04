import { speakerLabels } from '../../../packages/records/src/minutes-speakers.mjs';
import { minutesItemText, minutesActionText } from '../../../packages/records/src/minutes-quality.mjs';
import { requireThat } from '../../../packages/records/src/record.mjs';
import { minutesReadingLayout, uniqueMinutesItems } from '../../../packages/records/src/minutes-reading.mjs';

const inline = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/([`*_{}[\]#|])/g, '\\$1').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ');
export function minutesForExport(record) {
  return record.minutes?.edited ? record.minutes : record.capture === 'completed' ? record.minutes || record.liveMinutes : record.liveMinutes || record.minutes;
}
export function exportMinutesMarkdown(record, {includeNotes = true, includeEvidence = true, includeTitle = true, referenceMap} = {}) {
  const minutes = minutesForExport(record);
  requireThat(minutes, 'minutes_unavailable', 409);
  const draft = minutes !== record.minutes || record.capture !== 'completed';
  const lines = includeTitle ? [`# ${inline(minutes.title)}`, ''] : [];
  if(record.title && record.title !== minutes.title)lines.push(`会议：${inline(record.title)}`, '');
  if(draft)lines.push('> 会中草稿', '');
  const speakers=speakerLabels(minutes.evidenceSnapshot||[],record.speakers||[],record.segments||[]);
  const speakerName=evidence=>[...new Set((evidence||[]).map(ref=>speakers.get(`${ref.segmentId}:${ref.revision}`)).filter(Boolean))].join('、')||'未区分说话人';
  const references = referenceMap instanceof Map ? referenceMap : new Map(), sourceByRevision = new Map();
  for(const segment of minutes.evidenceSnapshot||[]){const key=`${segment.id}@${segment.revision}`;if(!sourceByRevision.has(key))sourceByRevision.set(key,segment);}
  const cite = evidence => (includeEvidence ? evidence || [] : []).map(ref => {
    const key = `${ref.segmentId}@${ref.revision}`;
    if (!references.has(key)) references.set(key, { ...ref, number: references.size + 1 });
    return `[^${references.get(key).number}]`;
  }).join('');
  const items = (heading, values) => {
    if (!values?.length) return;
    lines.push(`## ${inline(heading)}`, '');
    for (const item of values) lines.push(`- ${inline(minutesItemText(item))}${cite(item.evidence)}`);
    lines.push('');
  };
  items('重点速览', minutes.highlights);
  items('关键决策', uniqueMinutesItems(minutes.decisions));
  const visualBlock = (visual,level=2) => {
    lines.push(`${'#'.repeat(level)} ${inline(visual.title)}`, '');
    if (visual.kind === 'timeline') {
      lines.push('按会议提及顺序排列，时间保留原话。', '');
      for (const entry of visual.entries) lines.push(`- **${inline(entry.label)}**：${inline(entry.text)}${cite(entry.evidence)}`);
    } else {
      lines.push(`单位：${inline(visual.unit)}`, '', '| 对象 | 数值 | 来源 |', '| --- | --- | --- |');
      for (const entry of visual.entries) lines.push(`| ${inline(entry.label)} | ${inline(entry.valueText)} | ${cite(entry.evidence)} |`);
    }
    lines.push('');
  };
  const tableBlock = (table,level=2) => {
    lines.push(`${'#'.repeat(level)} ${inline(table.title)}`, '', `| ${table.columns.map(inline).join(' | ')} | 来源 |`,
      `| ${table.columns.map(() => '---').join(' | ')} | --- |`);
    for (const row of table.rows) lines.push(`| ${row.cells.map(inline).join(' | ')} | ${cite(row.evidence)} |`);
    lines.push('');
  };
  const layout=minutesReadingLayout(minutes);
  if(minutes.topics?.length)lines.push('## 讨论主题','');
  for(const branch of layout.branches){
    lines.push(`${minutes.topics?.length?'###':'##'} ${inline(branch.title)}`,'');
    if(branch.summary)lines.push(`${inline(branch.summary)}${cite(branch.evidence)}`,'');
    for(const item of branch.items)lines.push(`- ${inline(minutesItemText(item))}${cite(item.evidence)}`);
    if(branch.items.length)lines.push('');
    for(const visual of branch.visuals)visualBlock(visual,minutes.topics?.length?4:3);
    for(const table of branch.tables)tableBlock(table,minutes.topics?.length?4:3);
  }
  for(const visual of layout.unassigned.visuals)visualBlock(visual);
  for(const table of layout.unassigned.tables)tableBlock(table);

  if (minutes.speakerSummaries?.length) {
    lines.push('## 发言人总结', '');
    for (const speaker of minutes.speakerSummaries) lines.push(`### ${inline(speakerName(speaker.evidence))}`, '', `${inline(speaker.summary)}${cite(speaker.evidence)}`, '');
  }
  const actions=minutes.edited?minutes.actions||[]:uniqueMinutesItems(minutes.actions);
  if(actions.length){
    lines.push('## 行动候选', '', '| 事项 | 负责人 | 时间 |', '| --- | --- | --- |');
    for(const action of actions)lines.push(`| ${inline(minutesActionText(action,minutes.topics))}${cite(action.evidence)} | ${inline(action.owner || '待确认')} | ${inline(action.due || '待确认')} |`);
    lines.push('');
  }
  if (includeNotes && record.notes) lines.push('## 人工笔记', '', ...record.notes.split(/\r?\n/).map(inline), '');
  lines.push('---', '', `转录版本 ${minutes.transcriptRevision} · ${draft ? '会中草稿' : `纪要版本 ${minutes.revision}`}${minutes.edited ? ' · 人工修订' : ''}`, '');
  if (references.size) {
    lines.push('## 引用原文', '');
    for (const ref of references.values()) {
      const segment = sourceByRevision.get(`${ref.segmentId}@${ref.revision}`);
      const time = Number.isFinite(segment?.startMs) ? `${Math.floor(segment.startMs / 60000).toString().padStart(2, '0')}:${Math.floor(segment.startMs / 1000 % 60).toString().padStart(2, '0')}` : '';
      lines.push(`[^${ref.number}]: ${inline(ref.segmentId)}@${ref.revision} ${time}${segment ? ` ${inline(speakerName([ref]))}` : ''} — ${segment ? inline(segment.text) : '该修订原文快照不可用'}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
export function attachmentHeader(title, extension) {
  const name = Array.from(String(title || 'meeting').toWellFormed().replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')).slice(0, 120).join('');
  return `attachment; filename="meeting.${extension}"; filename*=UTF-8''${encodeURIComponent(`${name}.${extension}`).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}`;
}
