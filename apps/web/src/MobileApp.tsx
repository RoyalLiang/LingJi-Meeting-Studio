import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, messageOf, setCsrf } from './api';
import { Auth, type AccountLogin, type AuthSession } from './components/AccountLogin';
import { MobileEntryBoundary } from './components/MobileEntry';
import { FeedbackNotice } from './components/FeedbackNotice';
import { MobileSyncWorkspace } from './components/MobileSyncWorkspace';

const savedEmailKey = 'lingji:mobile-email';

export function MobileApp() {
  const [email, setEmail] = useState<string | null>(() => {
    try { return localStorage.getItem(savedEmailKey); } catch { return null; }
  });
  const [error, setError] = useState('');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [recording, setRecording] = useState(false);
  const [login, setLogin] = useState<AccountLogin>();
  const boot = useRef<Promise<boolean> | null>(null);
  const captureActive = useRef(false);
  const loginExpired = useRef(false);

  const rememberEmail = useCallback((value: string | null) => {
    if (!value) setCsrf('');
    setEmail(value);
    try {
      if (value) localStorage.setItem(savedEmailKey, value);
      else localStorage.removeItem(savedEmailKey);
    } catch {}
  }, []);
  const storeLogin = useCallback((value?: AccountLogin) => {
    setLogin(previous => { previous?.material.fill(0); return value; });
  }, []);

  const open = useCallback((direct?: AuthSession) => {
    // Skip redundant /mobile-session round-trip when login already returned email + csrf.
    if (direct?.email && direct.csrf) {
      loginExpired.current = false;
      setCsrf(direct.csrf);
      rememberEmail(direct.email);
      setError('');
      return Promise.resolve(true);
    }
    if (boot.current) return boot.current;
    const request = (async () => {
      try {
        if (!navigator.onLine) return false;
        type Session = { email: string; csrf: string; expiresAt?: number | null };
        const session = await api<Session>('/private-sync/mobile-session').catch(failure => {
          if (failure instanceof ApiError && failure.status === 404) return api<Session>('/bootstrap');
          throw failure;
        });
        setCsrf(session.csrf);
        rememberEmail(session.email);
        loginExpired.current = false;
        if (session.expiresAt && session.expiresAt - Date.now() < 2 * 24 * 60 * 60_000) {
          await api<Session>('/private-sync/mobile-session', 'POST');
        }
        setError('');
        return true;
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 401) {
          if (captureActive.current) { loginExpired.current = true; return false; }
          rememberEmail(null);
          storeLogin();
        } else if (navigator.onLine) {
          setError(messageOf(failure));
        }
        return false;
      }
    })();
    boot.current = request;
    void request.then(() => { if (boot.current === request) boot.current = null; });
    return request;
  }, [rememberEmail, storeLogin]);

  useEffect(() => { void open(); }, [open]);
  useEffect(() => {
    const reconnect = () => {
      setOnline(navigator.onLine);
      void open();
    };
    const disconnect = () => setOnline(false);
    const onVisible = () => { if (!document.hidden) void open(); };
    const refresh = window.setInterval(() => { if (!document.hidden) void open(); }, 6 * 60 * 60_000);
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', disconnect);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', disconnect);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(refresh);
    };
  }, [open]);
  const mobileActive = useCallback((active: boolean) => {
    captureActive.current = active;
    setRecording(active);
    if (!active && loginExpired.current) void open();
  }, [open]);
  useEffect(() => {
    const updateChrome = () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#1a1a1c' : '#f4f4f5');
      document.title = dark ? '聆记 · 快记（深色）' : '聆记 · 快记';
    };
    updateChrome();
    document.addEventListener('meeting:theme', updateChrome);
    return () => document.removeEventListener('meeting:theme', updateChrome);
  }, []);

  const signOut = useCallback(() => {
    void api('/auth/logout', 'POST').catch(() => {}).finally(() => {
      rememberEmail(null);
      storeLogin();
    });
  }, [rememberEmail, storeLogin]);

  if (!email) return <Auth mobile ready={session => open(session)} accountLogin={storeLogin}/>;
  return <main className="sync-companion quick-mobile-app">
    {error && <FeedbackNotice message={error} error/>}
    <MobileEntryBoundary>
      <MobileSyncWorkspace key={email} email={email} accountLogin={login} signOut={signOut}
        mobileActive={mobileActive} recording={recording} online={online}/>
    </MobileEntryBoundary>
  </main>;
}
