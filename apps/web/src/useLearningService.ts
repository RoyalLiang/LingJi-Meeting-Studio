import { useEffect, useState } from 'react';
import { api } from './api';
export type LearningService = { available: boolean; status: string; checkedAt?: number | null };
export function useLearningService(enabled: boolean) {
  const [service, setService] = useState<LearningService>({ available:false, status:'checking' });
  useEffect(() => {
    if (!enabled) { setService({ available:false, status:'disabled' }); return; }
    const controller = new AbortController(); let timer: number | undefined, pending = false;
    const load = async () => {
      if (pending || controller.signal.aborted) return;
      clearTimeout(timer); pending = true; let delay = 30000;
      try {
        const next = await api<LearningService>('/learning/status', 'GET', undefined, controller.signal);
        if (!controller.signal.aborted) { setService(next); if (next.status === 'checking') delay = 1500; }
      } catch { if (!controller.signal.aborted) setService({ available:false, status:'unavailable' }); }
      finally { pending = false; if (!controller.signal.aborted) timer = window.setTimeout(() => { if (document.hidden) timer=window.setTimeout(load,30000); else void load(); }, delay); }
    };
    void load(); const focus = () => { void load(); }; window.addEventListener('focus', focus);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('focus', focus); };
  }, [enabled]);
  return service;
}
