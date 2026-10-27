import { useEffect, useRef } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { pendingCount } from './audio/queue';

type MenuState = { authenticated: boolean; recordTitle: string; capture: string; recording: boolean; busy: boolean; connection: string };
type Actions = { pause: () => void; resume: () => void; finish: () => void; settings: () => void; microphone: () => void };

export function useNativeMenuBar(state: MenuState, actions: Actions) {
  const latest = useRef({ state, actions }); latest.current = { state, actions };
  useEffect(() => {
    if (!isTauri()) return;
    let live = true, publishing = false, unlisten: (() => void) | undefined;
    const publish = async () => {
      if (!live || publishing) return;
      publishing = true;
      try {
        const pending = await pendingCount();
        if (live) await invoke('client_status', { report: { ...latest.current.state, pendingCount: pending } });
      } catch { /* The native menu marks missing or stale reports as unknown. */ }
      finally { publishing = false; }
    };
    void listen<string>('client-menu-action', event => {
      if (!live) return;
      const { state, actions } = latest.current;
      if (state.busy || !state.authenticated) return;
      if (event.payload === 'status-settings') { actions.settings(); return; }
      if (event.payload === 'status-microphone' && (state.recording || state.capture === 'paused')) actions.microphone();
      if (event.payload === 'status-pause' && state.recording) actions.pause();
      if (event.payload === 'status-resume' && !state.recording && state.capture === 'paused') actions.resume();
      if (event.payload === 'status-finish' && (state.recording || state.capture === 'paused')) actions.finish();
    }).then(stop => { if (live) unlisten = stop; else stop(); }).catch(() => { /* A failed listener leaves actions unavailable. */ });
    void publish();
    const timer = window.setInterval(() => void publish(), 1000);
    return () => { live = false; clearInterval(timer); unlisten?.(); };
  }, []);
}
