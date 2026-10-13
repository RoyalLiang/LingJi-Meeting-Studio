import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ClientUpdates, defaultUpdatePreferences, type UpdateActivity, type UpdatePreferences, type UpdateStatus } from './client-updates';
import { updateQueueState } from './audio/queue';

const preferenceKey = 'meeting-client-updates-v1';
function preferences(): UpdatePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
    return { autoCheck: value.autoCheck !== false, autoDownload: value.autoDownload === true, autoInstall: value.autoInstall === true };
  } catch { return defaultUpdatePreferences; }
}
export function useClientUpdates(activity: Omit<UpdateActivity, 'queueBusy' | 'pendingBytes' | 'pendingCount'>) {
  const latest = useRef(activity); latest.current = activity;
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle', currentVersion: '', downloaded: 0 });
  const [settings, setSettings] = useState(preferences), settingsRef = useRef(settings); settingsRef.current = settings;
  const controller = useRef<ClientUpdates | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true, unlisten: (() => void) | undefined;
    const engine = new ClientUpdates({ invoke, activity: () => latest.current, queue: updateQueueState,
      preferences: () => settingsRef.current, changed: state => { if (live) setStatus(state); },
      freeze: frozen => { document.getElementById('root')?.toggleAttribute('inert', frozen); } });
    controller.current = engine;
    void listen<UpdateStatus>('client-update-state', event => engine.apply(event.payload)).then(stop => { if (live) unlisten = stop; else stop(); });
    void engine.initialize().catch(error => engine.apply({ ...engine.status, phase: 'error', error: String(error) }));
    const initial = window.setTimeout(() => { void engine.tick(Date.now()); }, 10_000);
    const timer = window.setInterval(() => { void engine.tick(Date.now()); }, 30_000);
    const online = () => { void engine.tick(Date.now()); }; addEventListener('online', online);
    return () => { live = false; unlisten?.(); clearTimeout(initial); clearInterval(timer); removeEventListener('online', online); controller.current = null; document.getElementById('root')?.removeAttribute('inert'); };
  }, []);
  useEffect(() => { void controller.current?.activityChanged().catch(() => {}); }, [activity.authenticated, activity.recording, activity.paused, activity.busy]);
  function saveSettings(next: UpdatePreferences) { setSettings(next); try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Preferences still apply to this window. */ } }
  return { native: isTauri(), status, settings, saveSettings, check: () => controller.current?.check(), download: () => controller.current?.download(), install: () => controller.current?.install() };
}
