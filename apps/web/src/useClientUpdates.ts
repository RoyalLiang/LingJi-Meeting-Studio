import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ClientUpdates, defaultUpdatePreferences, normalizeUpdatePreferences, type UpdateActivity, type UpdatePreferences, type UpdateStatus } from './client-updates';
import { updateQueueState } from './audio/queue';

const preferenceKey = 'meeting-client-updates-v1';
function preferences(): UpdatePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
    return normalizeUpdatePreferences(value);
  } catch { return defaultUpdatePreferences; }
}
export function useClientUpdates(activity: Omit<UpdateActivity, 'queueBusy' | 'pendingBytes' | 'pendingCount'>) {
  const latest = useRef(activity); latest.current = activity;
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle', currentVersion: '', downloaded: 0 });
  const [installReason, setInstallReason] = useState('正在确认录音与补传状态…');
  const [settings, setSettings] = useState(preferences), settingsRef = useRef(settings); settingsRef.current = settings;
  const controller = useRef<ClientUpdates | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true, reporting = false; const listeners: (() => void)[] = [];
    const engine = new ClientUpdates({ invoke, activity: () => latest.current, queue: updateQueueState,
      preferences: () => settingsRef.current, preferencesChanged: saveSettings, changed: state => { if (live) setStatus(state); },
      freeze: frozen => { document.getElementById('root')?.toggleAttribute('inert', frozen); } });
    controller.current = engine;
    const attach = (stop: () => void) => { if (live) listeners.push(stop); else stop(); };
    void listen<UpdateStatus>('client-update-state', event => { if (live) engine.apply(event.payload); }).then(attach);
    void listen<string>('client-menu-action', event => { if (live) void engine.menuAction(event.payload).catch(error => engine.apply({ ...engine.status, error: String(error) })); }).then(attach);
    void engine.initialize().catch(error => engine.apply({ ...engine.status, phase: 'error', error: String(error) }));
    const report = async () => {
      if (!live || reporting) return;
      reporting = true;
      try { const reason = await engine.activityChanged(); if (live) setInstallReason(reason); }
      catch { if (live) setInstallReason('无法确认录音与补传状态，请稍后重试'); }
      finally { reporting = false; }
    };
    void report();
    const activityTimer = window.setInterval(() => { void report(); }, 1000);
    const initial = window.setTimeout(() => { void engine.tick(Date.now()); }, 10_000);
    const timer = window.setInterval(() => { void engine.tick(Date.now()); }, 30_000);
    const online = () => { void engine.preferencesChanged(Date.now()); }; addEventListener('online', online);
    return () => { live = false; listeners.forEach(stop => stop()); clearInterval(activityTimer); clearTimeout(initial); clearInterval(timer); removeEventListener('online', online); controller.current = null; document.getElementById('root')?.removeAttribute('inert'); };
  }, []);
  useEffect(() => { void controller.current?.activityChanged().then(setInstallReason).catch(() => setInstallReason('无法确认录音与补传状态，请稍后重试')); }, [activity.authenticated, activity.recording, activity.paused, activity.busy, settings]);
  function saveSettings(next: UpdatePreferences) { const normalized = normalizeUpdatePreferences(next); settingsRef.current = normalized; setSettings(normalized); void controller.current?.preferencesChanged(Date.now()); try { localStorage.setItem(preferenceKey, JSON.stringify(normalized)); } catch { /* Preferences still apply to this window. */ } }
  return { native: isTauri(), status, settings, installReason, saveSettings, check: () => controller.current?.check(), download: () => controller.current?.download(), install: () => controller.current?.install(), update: () => controller.current?.downloadAndInstall() };
}
