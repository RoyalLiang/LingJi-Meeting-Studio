export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'unavailable';

interface SubscriptionOptions<T extends { cursor: string }> {
  recordId: string;
  loadRecord: (signal: AbortSignal) => Promise<T>;
  onRecord: (record: T) => void;
  onState: (state: ConnectionState) => void;
  onFatal: (error: unknown) => void;
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
  function retry() {
    if (disposed || timer !== undefined) return;
    generation++; source?.close(); source = undefined; controller?.abort();
    if (!navigator.onLine) { options.onState('offline'); return; }
    options.onState('reconnecting');
    const delay = Math.min(15000, 1000 * 2 ** Math.min(retries++, 4));
    timer = setTimeout(() => { timer = undefined; void connect(); }, delay);
  }
  function failed(error: unknown, version: number) {
    if (!current(version)) return;
    const status = (error as { status?: number } | null)?.status;
    if (status && [401, 403, 404, 410].includes(status)) {
      dispose(); options.onState('unavailable'); options.onFatal(error);
    } else retry();
  }
  async function connect() {
    if (disposed) return;
    if (!navigator.onLine) { options.onState('offline'); return; }
    const version = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    options.onState(retries ? 'reconnecting' : 'connecting');
    try {
      // A fresh snapshot validates access and includes updates missed during the outage.
      const record = await options.loadRecord(signal);
      if (!current(version)) return;
      options.onRecord(record);
      const stream = new EventSource(`/api/records/${encodeURIComponent(options.recordId)}/events?after=${encodeURIComponent(record.cursor)}`);
      source = stream;
      stream.onopen = () => { if (current(version)) { retries = 0; options.onState('connected'); } };
      stream.onerror = () => { if (current(version)) retry(); };
      // Revalidate a revoked stream: permanent access failures stop, transient API errors retry.
      stream.addEventListener('revoked', () => { if (current(version)) retry(); });
      let refreshing = false, dirty = false;
      async function refresh() {
        if (!current(version)) return;
        dirty = true;
        if (refreshing) return;
        refreshing = true;
        try {
          do {
            dirty = false;
            const latest = await options.loadRecord(signal);
            if (!current(version)) return;
            options.onRecord(latest);
          } while (dirty);
        } catch (error) { failed(error, version); }
        finally { refreshing = false; }
      }
      stream.onmessage = () => { void refresh(); };
      stream.addEventListener('reset', () => { void refresh(); });
    } catch (error) { failed(error, version); }
  }
  void connect();
  return dispose;
}
