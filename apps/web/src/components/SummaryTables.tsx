import { useCallback, useState } from 'react';
import { Copy, Check } from '@phosphor-icons/react';
import type { Evidence, Minutes, SummaryTable } from '../model';
import { summaryTables } from '../minutes-views';
import { Button } from './ui';
import { CitationSources } from './CitationSources';
import { Toast } from './Toast';

function Table({ table, cite }: { table: SummaryTable; cite: (evidence: Evidence) => void }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const [copyKey, setCopyKey] = useState(0);
  const dismiss = useCallback(() => setCopied(false), []);
  async function copy() {
    const clean = (cell: string) => cell.replace(/[\t\r\n]/g, ' ');
    try { await navigator.clipboard.writeText([table.columns, ...table.rows.map(row => row.cells)].map(row => row.map(clean).join('\t')).join('\n')); setCopied(true); setCopyKey(key => key + 1); setError(''); }
    catch { setError('无法自动复制，可选中表格内容手动复制。'); }
  }
  return <figure className="summary-table"><figcaption><h4>{table.title}</h4><Button variant="ghost" aria-label={`复制${table.title}`} onClick={() => void copy()}>{copied ? <Check size={16}/> : <Copy size={16}/>}</Button></figcaption><p className="summary-table-hint">横向滑动查看完整表格</p><div className="summary-table-scroll" tabIndex={0} role="region" aria-label={`${table.title}表格`}><table style={{minWidth:Math.max(480,(table.columns.length+1)*140)}}><thead><tr>{table.columns.map((column, i) => <th scope="col" key={i}>{column}</th>)}<th scope="col">来源</th></tr></thead><tbody>{table.rows.map((row, i) => <tr key={i}>{row.cells.map((cell, j) => <td key={j}>{cell || '—'}</td>)}<td><CitationSources compact evidence={row.evidence} cite={cite} label={j => `${table.title}第${i + 1}行来源${j + 1}`}/></td></tr>)}</tbody></table></div><Toast message={copied ? '表格已复制' : ''} messageKey={copyKey} dismiss={dismiss}/>{error && <p className="inline-error" role="alert">{error}</p>}</figure>;
}

export function SummaryTables({ minutes, tables: selected, cite }: { minutes: Minutes; tables?: SummaryTable[]; cite: (evidence: Evidence) => void }) {
  const tables = selected || summaryTables(minutes);
  return tables.length ? <section className="summary-tables" aria-label="总结表格">{tables.map((table, i) => <Table key={`${table.title}:${i}`} table={table} cite={cite}/>)}</section> : <p className="fine-print">本版尚无适合对照的内容；后续整理将按讨论生成表格，已有行动候选会自动汇总。</p>;
}
