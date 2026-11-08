export function createWorkerWakeup(repo) {
  let revision = 0, closed = false;
  const waiters = new Set();
  const wake = () => { revision++; for (const settle of [...waiters]) settle(); };
  const unsubscribe = repo.subscribeChanges(wake, { all: true });
  return {
    cursor: () => revision,
    wait(cursor, delay) {
      if (closed || cursor !== revision) return Promise.resolve();
      return new Promise(resolve => {
        const settle = () => { clearTimeout(timer); waiters.delete(settle); resolve(); };
        const timer = setTimeout(settle, Math.max(1, Math.min(30000, delay)));
        waiters.add(settle);
        if (closed || cursor !== revision) settle();
      });
    },
    close() { if (closed) return; closed = true; unsubscribe(); wake(); },
  };
}
