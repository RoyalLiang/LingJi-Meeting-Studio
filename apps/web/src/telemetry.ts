// Local, opt-in diagnostics. Never stores PCM, transcript text, credentials or request bodies.
type Row = { stage: string; monoMs: number; durationMs?: number; recordId?: string; sourceId?: string; sequence?: number; bytes?: number; traceId?: string };
const events: Row[] = [];
export function trace(stage: string, fields: Omit<Row, 'stage' | 'monoMs'> = {}) {
  try {
    if (sessionStorage.getItem('meeting-trace') !== '1') return;
    events.push({ stage, monoMs: performance.now(), ...fields });
    if (events.length > 512) events.shift();
  } catch { /* Diagnostics cannot interrupt capture. */ }
}
export const traceSnapshot = () => events.map(e => ({ ...e }));
