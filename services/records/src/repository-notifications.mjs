import { watch } from 'node:fs';
import { telemetry } from './telemetry.mjs';

export async function createRepositoryNotifications({ root, db, pool }) {
  const listeners = new Set();
  let closed = false, client, reconnect, watcher, fallback, observed;
  const deliver = (ids, completed = []) => {
    for (const entry of listeners) {
      const selected = entry.all ? ids : completed;
      if (selected && (selected.length || entry.all && !ids.length)) queueMicrotask(() => {
        if (!closed && listeners.has(entry)) Promise.resolve().then(() => entry.listener(selected)).catch(() => {});
      });
    }
  };
  const report = error => telemetry.event('db.notifications.failed', { backend: pool ? 'postgres' : 'sqlite', code: error.code || error.name });
  const revision = () => db.prepare('PRAGMA data_version').get().data_version;
  const check = () => {
    if (closed || ![...listeners].some(entry => entry.all)) return;
    try {
      const current = revision();
      if (current !== observed) { observed = current; deliver([]); }
    } catch (error) { report(error); }
  };
  async function listen(initial = false) {
    const connection = await pool.connect();
    if (closed) { connection.release(true); return; }
    const disconnected = error => {
      if (client !== connection || closed) return;
      client = undefined; connection.release(true); report(error);
      reconnect = setTimeout(() => listen().catch(error => { report(error); disconnectedRetry(); }), 500);
      reconnect.unref?.();
    };
    connection.on('error', disconnected);
    connection.on('end', () => disconnected(Object.assign(new Error('notification_connection_closed'), { code: 'connection_closed' })));
    try {
      if (initial) {
        await connection.query('BEGIN');
        await connection.query("SELECT pg_advisory_xact_lock(hashtext('lingji_record_notifications_v1'))");
        await connection.query(`CREATE OR REPLACE FUNCTION lingji_record_notify_v1() RETURNS trigger LANGUAGE plpgsql AS $$
          DECLARE changed_id text;
          BEGIN
            IF TG_OP='UPDATE' AND NEW.data IS NOT DISTINCT FROM OLD.data THEN RETURN NEW; END IF;
            IF TG_OP='DELETE' THEN changed_id=OLD.id;
            ELSE
              changed_id=NEW.id;
            END IF;
            PERFORM pg_notify('lingji_record_changes_v1',json_build_object('ids',json_build_array(changed_id))::text);
            RETURN NULL;
          END $$`);
        await connection.query(`DO $$ BEGIN
          IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='lingji_record_changed_v1' AND tgrelid='record_aggregates'::regclass) THEN
            CREATE TRIGGER lingji_record_changed_v1 AFTER INSERT OR UPDATE OR DELETE ON record_aggregates FOR EACH ROW EXECUTE FUNCTION lingji_record_notify_v1();
          END IF;
        END $$`);
        await connection.query('COMMIT');
      }
      await connection.query('LISTEN lingji_record_changes_v1');
      if (closed) { connection.release(true); return; }
      client = connection;
      connection.on('notification', message => {
        if (closed || message.channel !== 'lingji_record_changes_v1' || !message.payload || message.payload.length > 8000) return;
        try {
          const { ids } = JSON.parse(message.payload);
          if (!Array.isArray(ids) || !ids.length || ids.length > 64 || !ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)) return;
          deliver(ids);
        } catch { /* Ignore malformed notifications from other database clients. */ }
      });
      deliver([]);
    } catch (error) {
      try { await connection.query('ROLLBACK'); } catch { /* The connection may already be gone. */ }
      connection.release(true); throw error;
    }
  }
  function disconnectedRetry() {
    if (closed) return;
    reconnect = setTimeout(() => listen().catch(error => { report(error); disconnectedRetry(); }), 1000);
    reconnect.unref?.();
  }
  if (pool) await listen(true);
  return {
    subscribe(listener, { all = false } = {}) {
      if (closed) throw new Error('repository_notifications_closed');
      const entry = { listener, all }; listeners.add(entry);
      if (db && all && !fallback) {
        observed = revision();
        try { watcher = watch(root, { persistent: false }, (_event, name) => {
          const file = String(name || '');
          if (file.startsWith('records.sqlite')) check();
          else if (file === 'providers.json' || file === 'model-facts.json') deliver([]);
        }); watcher.on('error', report); } catch (error) { report(error); }
        // One scalar recovery check replaces per-lane scans when a filesystem event is lost.
        fallback = setInterval(check, 500); fallback.unref?.();
      }
      return () => {
        listeners.delete(entry);
        if (db && ![...listeners].some(entry => entry.all)) {
          watcher?.close(); watcher = undefined; clearInterval(fallback); fallback = undefined;
        }
      };
    },
    committed(values, result) {
      if (closed || !values.length) return;
      const reported = [result, ...(Array.isArray(result) ? result : [])];
      const completed = reported.filter(value => value?.kind === 'record' && value.capture === 'completed').map(value => value.id);
      if (pool) { deliver(null, completed); return; }
      try { observed = revision(); } catch (error) { report(error); }
      deliver(values.map(value => value.id), completed);
    },
    close() {
      if (closed) return;
      closed = true; listeners.clear(); watcher?.close(); clearInterval(fallback); clearTimeout(reconnect);
      if (client) { client.release(true); client = undefined; }
    },
  };
}
