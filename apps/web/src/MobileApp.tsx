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

  const rememberEmail = useCallback((value: string | null) => {
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
      setCsrf(direct.csrf);
      rememberEmail(direct.email);
      setError('');
      return Promise.resolve(true);
    }
    if (boot.current) return boot.current;
    const request = (async () => {
      try {
        if (!navigator.onLine) return false;
        type Session = { email: string; csrf: string };
        const session = await api<Session>('/private-sync/mobile-session').catch(failure => {
          if (failure instanceof ApiError && failure.status === 404) return api<Session>('/bootstrap');
          throw failure;
        });
        setCsrf(session.csrf);
        rememberEmail(session.email);
        setError('');
        return true;
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 401) {
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
      if (!recording) void open();
    };
    const disconnect = () => setOnline(false);
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', disconnect);
    return () => {
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', disconnect);
    };
  }, [open, recording]);
  useEffect(() => {
    const updateChrome = () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#171b19' : '#f5f7f4');
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
      <MobileSyncWorkspace email={email} accountLogin={login} signOut={signOut}
        mobileActive={setRecording} recording={recording} online={online}/>
    </MobileEntryBoundary>
  </main>;
}
