import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const fields = new Set(['traceId', 'recordId', 'sourceId', 'sequence', 'jobId', 'revision', 'bytes', 'tokens', 'queueMs', 'firstTextMs', 'backend','errorClass','attempts']);
export function createTelemetry({ enabled = false, limit = 512, sink = () => {} } = {}) {
  const events = [], counts = new Map();
  const lag = enabled ? monitorEventLoopDelay({ resolution: 20 }) : null;
  lag?.enable();
  function event(stage, input = {}) {
    if (!enabled) return;
    const row = { stage, at: new Date().toISOString(), monoMs: performance.now() };
    for (const [key, value] of Object.entries(input)) if (fields.has(key) && (typeof value === 'string' || Number.isFinite(value))) row[key] = typeof value === 'string' ? value.slice(0, 100) : value;
    if (Number.isFinite(input.durationMs)) row.durationMs = input.durationMs;
    if (['ok', 'error'].includes(input.outcome)) row.outcome = input.outcome;
    events.push(row); if (events.length > limit) events.shift();
    counts.set(stage, (counts.get(stage) || 0) + 1);
    try { sink(row); } catch { /* Observability must not fail a durable command. */ }
  }
  async function measure(stage, input, operation) {
    if (!enabled) return operation();
    const started = performance.now();
    try { const value = await operation(); event(stage, { ...input, durationMs: performance.now() - started, outcome: 'ok' }); return value; }
    catch (error) { event(stage, { ...input, durationMs: performance.now() - started, outcome: 'error', errorClass:/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.code||'') ? error.code : 'operation_failed' }); throw error; }
  }
  return { enabled, event, measure, snapshot() {
    const timings = {};
    for (const stage of counts.keys()) {
      const values = events.filter(e => e.stage === stage && e.durationMs !== undefined).map(e => e.durationMs).sort((a,b) => a-b);
      timings[stage] = { count: counts.get(stage), retained: values.length, ...Object.fromEntries([50,95,99].map(p => [`p${p}Ms`, values.length ? values[Math.ceil(values.length*p/100)-1] : null])) };
    }
    return { versions:{traceSchema:1,protocol:'record/v1',minutesPolicy:1,node:process.version,buildId:process.env.RECORD_BUILD_ID||null},enabled, sampleLimit: limit, events: structuredClone(events), timings, memory: process.memoryUsage(), eventLoopP95Ms: lag ? lag.percentile(95)/1e6 : null };
  }, close() { lag?.disable(); } };
}
export const telemetry = createTelemetry({ enabled: process.env.RECORD_TRACE_ENABLED === 'true', sink: row => console.log(JSON.stringify({ recordTrace: row })) });
