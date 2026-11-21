export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'unavailable' | 'inaccessible';

interface SubscriptionOptions<T extends { cursor: string }> {
  recordId: string;
  localBackend?: boolean;
  loadRecord: (signal: AbortSignal) => Promise<T>;
  onRecord: (record: T) => void;
  onState: (state: ConnectionState) => void;
  onFatal: (error: unknown) => void;
  applyDelta?: (record: T, delta: unknown) => T | null;
}

// Own retries rather than relying on native EventSource: HTTP 502 can close it permanently.
export function subscribeToRecord<T extends { cursor: string }>(options: SubscriptionOptions<T>) {
  let disposed = false, generation = 0, retries = 0;
  let source: EventSource | undefined, controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = (version: number) => !disposed && generation === version;

  function dispose() {
    disposed = true; generation++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined; source?.close(); source = undefined; controller?.abort();
  }
  function retry(state: ConnectionState = 'reconnecting') {
    if (disposed || timer !== undefined) return;
    generation++; source?.close(); source = undefined; controller?.abort();
    if (!navigator.onLine && !options.localBackend) { options.onState('offline'); return; }
    options.onState(state);
    const delay = Math.min(15000, 1000 * 2 ** Math.min(retries++, 4));
    timer = setTimeout(() => { timer = undefined; void connect(); }, delay);
  }
  function failed(error: unknown, version: number) {
    if (!current(version)) return;
    const status = (error as { status?: number } | null)?.status;
    if (status && [401, 403, 404, 410].includes(status)) {
      dispose(); options.onState('inaccessible'); options.onFatal(error);
    } else retry('unavailable');
  }
  async function connect() {
    if (disposed) return;
    if (!navigator.onLine && !options.localBackend) { options.onState('offline'); return; }
    const version = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    options.onState(retries ? 'reconnecting' : 'connecting');
    try {
      // A fresh snapshot validates access and includes updates missed during the outage.
      let record = await options.loadRecord(signal);
      if (!current(version)) return;
      options.onRecord(record);
      const stream = new EventSource(`/api/records/${encodeURIComponent(options.recordId)}/events?after=${encodeURIComponent(record.cursor)}`);
      source = stream;
      stream.onopen = () => { if (current(version)) { retries = 0; options.onState('connected'); } };
      stream.onerror = () => { if (current(version)) retry(); };
      // Revalidate a revoked stream: permanent access failures stop, transient API errors retry.
      stream.addEventListener('revoked', () => { if (current(version)) retry(); });
      let refreshing = false, dirty = false;
      const queued: unknown[] = [];
      async function refresh(delta?: unknown) {
        if (!current(version)) return;
        if (delta !== undefined) {
          if (queued.length === 64) { queued.length = 0; dirty = true; }
          queued.push(delta);
        } else if (refreshing) dirty = true;
        if (refreshing) return;
        refreshing = true;
        try {
          do {
            dirty = false;
            record = await options.loadRecord(signal);
            if (!current(version)) return;
            for (const pending of queued.splice(0)) {
              const next = options.applyDelta?.(record, pending);
              if (!next) { dirty = true; break; }
              record = next;
            }
            options.onRecord(record);
          } while (dirty);
        } catch (error) { failed(error, version); }
        finally { refreshing = false; }
      }
      stream.onmessage = event => {
        if (!current(version)) return;
        try {
          const message = JSON.parse(event.data);
          if (message.delta && options.applyDelta) {
            const next = refreshing ? null : options.applyDelta(record, message.delta);
            if (next) { record = next; options.onRecord(record); }
            else void refresh(message.delta);
            return;
          }
          if (message.projection && !message.delta) return;
        } catch { /* Malformed or incompatible event requires fresh snapshot. */ }
        void refresh();
      };
      stream.addEventListener('reset', () => { void refresh(); });
    } catch (error) { failed(error, version); }
  }
  void connect();
  return dispose;
}


export function applyRecordDelta<T extends {cursor:string;segments:{id:string}[]}>(record:T,input:unknown):T|null {
  const delta=input as {baseCursor:string;cursor:string;set:Partial<T>;remove:string[];segments:{upsert:T['segments'];remove:string[];order?:string[]}};
  if(!delta || !/^\d{1,20}$/.test(delta.cursor))return null;
  if(BigInt(delta.cursor)<=BigInt(record.cursor))return record;
  if(delta.baseCursor!==record.cursor || !delta.set || !delta.segments)return null;
  let nextSegments=record.segments;
  if(delta.segments.remove.length || delta.segments.upsert.length || delta.segments.order !== undefined){
    const segments=new Map(record.segments.map(segment=>[segment.id,segment]));
    for(const id of delta.segments.remove)segments.delete(id);
    for(const segment of delta.segments.upsert)segments.set(segment.id,segment);
    nextSegments=(delta.segments.order ? delta.segments.order.map(id=>segments.get(id)) : [...segments.values()]) as T['segments'];
  }
  const next={...record,...delta.set,cursor:delta.cursor,segments:nextSegments};
  for(const key of delta.remove)delete (next as Record<string,unknown>)[key];
  return next as T;
}
