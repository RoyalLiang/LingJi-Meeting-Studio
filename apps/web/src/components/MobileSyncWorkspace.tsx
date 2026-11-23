import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, messageOf } from '../api';
import { createVault, recoverVault, type Envelope, type Vault } from '../sync/vault';
import { authenticateAccount, openAccountVault, wrapAccountVault } from '../sync/account';
import { readDeviceVault, rememberDeviceVault, type DeviceVault } from '../sync/device';
import { annotateMeeting, clearJournalCache, loadMeetingCopy, meetingCopies, syncMeetings, type CopySummary, type MeetingAnnotations } from '../sync/journal';
import { pullLiveAudio, pushLiveAudio, pushMobileRecordings, queueLiveAudio, releaseHeldAudio } from '../sync/mobile';
import { appendMobileRecording, clearMobileLibraryCache, deleteMobileRecording, finishMobileRecording, hiddenMobileRecordings, mobilePlayback, mobileRecordings, type MobileRecording } from '../sync/mobile-library';
import { packLocalMobilePcm, packMobilePcm, type PackedLocalMobilePcm, type PackedMobilePcm } from '../sync/mobile-pcm';
import { ShieldCheck } from '@phosphor-icons/react';
import { Button } from './ui';
import { FeedbackNotice } from './FeedbackNotice';
import { MobileWorkspace, type MobilePage } from './MobileWorkspace';
import { QuickMobileRecording } from './QuickMobileRecording';
import { MobileSheet } from './MobileSheet';
import { MobileDirectSend } from './MobileDirectAudio';
import './PrivateSyncSettings.css';

function syncError(error: unknown) {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      sync_invalid_operations: '会议超过本次同步上限',
      sync_quota_exceeded: '云端资料库空间已满',
      sync_server_unavailable: '暂时无法连接同步服务，已排队的内容会保留在本机',
      sync_sign_in_required: '请重新登录同步账号',
      sync_vault_exists: '该账号已创建加密资料库，请刷新后解锁',
      invalid_credentials: '邮箱或密码有误',
      sync_pair_unavailable: '配对已过期或已被另一台设备领取',
      sync_challenge_expired: '通行密钥验证已过期，请重试',
      sync_webauthn_verification_failed: '通行密钥验证未通过',
    };
    if (messages[error.code]) return messages[error.code];
  }
  if (error instanceof DOMException && error.name === 'OperationError') return '解锁失败，请核对恢复密钥或通行密钥';
  if (error instanceof DOMException && error.name === 'NotAllowedError') return '通行密钥验证未完成，你也可以用恢复密钥或配对解锁';
  return messageOf(error);
}

export function MobileSyncWorkspace({ email, accountLogin, mobileActive, signOut, online = true, recording = false }: {
  email: string;
  accountLogin?: { email: string; material: Uint8Array<ArrayBuffer> };
  mobileActive?: (active: boolean) => void;
  online?: boolean;
  recording?: boolean;
  signOut: () => Promise<void>;
}) {
  const [legacyAccount, setLegacyAccount] = useState(false);
  const [newLoginNeeded, setNewLoginNeeded] = useState(false);
  const [emptyUpgrade, setEmptyUpgrade] = useState(false);
  const [vault, setVault] = useState<Vault>();
  const [liveAudio, setLiveAudio] = useState(false);
  const [liveAudioV2, setLiveAudioV2] = useState(false);
  const [liveIssue, setLiveIssue] = useState('');
  const activeLive = useRef({ id: '', uploaded: false, received: false });
  const [liveStatus, setLiveStatus] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [copies, setCopies] = useState<CopySummary[]>([]);
  const [profileEditor, setProfileEditor] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [mobilePage, setMobilePage] = useState<MobilePage>('record');
  const meetingPage = useRef(false);
  const [phoneCopies, setPhoneCopies] = useState<MobileRecording[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [phoneMeetingSync, setPhoneMeetingSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const profileKey = 'lingji:phone-profile:' + email;
  const [profile, setProfile] = useState(() => { try { return localStorage.getItem(profileKey) || ''; } catch { return ''; } });
  const [name, setName] = useState<string | null>(null);
  const [mobileStatus, setMobileStatus] = useState('');
  const [backgroundIssue, setBackgroundIssue] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [preferDirect, setPreferDirect] = useState(false);
  const secret = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const pending = useRef<AbortController | null>(null);
  const background = useRef<Promise<void> | null>(null);
  const archivePush = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (unlocked && liveAudio && vault) {
      try {
        localStorage.setItem('lingji:live-audio', vault.id);
        localStorage.setItem('lingji:live-audio-v2', liveAudioV2 ? vault.id : '');
      } catch {}
    }
  }, [unlocked, liveAudio, liveAudioV2, vault]);

  useEffect(() => {
    if (!vault || !unlocked || !secret.current) return;
    const root = secret.current.slice();
    let mounted = true;
    void Promise.all([mobileRecordings(vault, root), hiddenMobileRecordings(vault)]).then(([items, removed]) => {
      if (mounted) { setPhoneCopies(items); setHidden(removed); }
    }).catch(() => {}).finally(() => root.fill(0));
    try {
      setPhoneMeetingSync(localStorage.getItem('lingji:phone-meetings:' + vault.id) !== '0');
      setPreferDirect(localStorage.getItem('lingji:phone-direct:' + vault.id) === '1');
    } catch {}
    return () => { mounted = false; };
  }, [vault, unlocked]);

  useEffect(() => {
    if (!online || !email) return;
    const controller = new AbortController();
    void api<{ name: string }>('/private-sync/profile', 'GET', undefined, controller.signal)
      .then(({ name: nextName }) => {
        if (controller.signal.aborted) return;
        setProfile(nextName);
        try { localStorage.setItem(profileKey, nextName); } catch {}
      })
      .catch(() => {});
    return () => controller.abort();
  }, [online, email, profileKey]);

  const readMobileMeeting = useCallback(async (id: string) => {
    if (!vault || !secret.current) return null;
    const root = secret.current.slice();
    try { return await loadMeetingCopy(vault, root, id); }
    finally { root.fill(0); }
  }, [vault]);

  const saveMobileAnnotations = useCallback(async (parent: string, changes: MeetingAnnotations) => {
    if (!vault || !secret.current) throw new Error('请先解锁资料库');
    const root = secret.current.slice();
    try {
      const id = await annotateMeeting(vault, root, parent, changes);
      setCopies(await meetingCopies(vault, root));
      window.dispatchEvent(new Event('lingji:sync-wakeup'));
      return id;
    } finally { root.fill(0); }
  }, [vault]);

  const playMobileRecording = useCallback(async (id: string) => {
    if (!vault || !secret.current) return null;
    const root = secret.current.slice();
    try { return await mobilePlayback(vault, root, id); }
    finally { root.fill(0); }
  }, [vault]);

  const deleteLocalRecording = useCallback(async (id: string) => {
    if (!vault) throw new Error('资料库未解锁');
    await deleteMobileRecording(vault, id);
    await releaseHeldAudio(vault, id, false);
    setPhoneCopies(items => items.filter(item => item.id !== id));
    setHidden(items => new Set([...items, id]));
  }, [vault]);

  const searchMobileMeetings = useCallback(async (query: string) => {
    if (!vault || !secret.current) return [];
    const root = secret.current.slice();
    try { return await meetingCopies(vault, root, query); }
    finally { root.fill(0); }
  }, [vault]);

  function forget() {
    pending.current?.abort();
    pending.current = null;
    secret.current?.fill(0);
    secret.current = null;
    clearJournalCache();
    clearMobileLibraryCache();
  }

  async function enter(device: DeviceVault, signal: AbortSignal, remember = false) {
    const { vault: localVault, root: key } = device;
    try {
      signal.throwIfAborted();
      if (remember && email) {
        let kit = device.kit;
        if (!kit) {
          const previous = await readDeviceVault(email, localVault).catch(() => null);
          kit = previous?.kit;
          previous?.root.fill(0);
        }
        signal.throwIfAborted();
        await rememberDeviceVault(email, { ...device, kit });
      }
      signal.throwIfAborted();
      secret.current?.fill(0);
      secret.current = key;
      setUnlocked(true);
      setVault(localVault);
      setPairCode('');
      setReady(true);
      // Load local summaries asynchronously so the record screen paints immediately with zero blank frame.
      const copyKey = key.slice();
      void meetingCopies(localVault, copyKey).then(local => {
        if (!signal.aborted) setCopies(local);
      }).catch(() => {}).finally(() => copyKey.fill(0));
    } finally {
      if (secret.current !== key) key.fill(0);
    }
  }

  async function connectAccount(account: string, signal: AbortSignal, material?: Uint8Array<ArrayBuffer>) {
    let local: DeviceVault | null = null;
    setLiveIssue('');
    try {
      // Unlock locally from IndexedDB first so returning launches reach the record screen in ~5ms (0 RTTs).
      local = await readDeviceVault(account).catch(() => null);
      signal.throwIfAborted();
      if (local) {
        try {
          setLiveAudio(localStorage.getItem('lingji:live-audio') === local.vault.id);
          setLiveAudioV2(localStorage.getItem('lingji:live-audio-v2') === local.vault.id);
        } catch {}
        await enter({ vault: local.vault, root: local.root.slice(), kit: local.kit }, signal);
      }
      if (!navigator.onLine) {
        setReady(true);
        return;
      }
      const getVault = () => api<{ vault: Vault | null; account?: Envelope; legacy: boolean; emptyUpgrade?: boolean; liveAudio?: boolean; liveAudioV2?: boolean }>('/private-sync/vault', 'GET', undefined, signal);
      let remote = await getVault();
      let cloud = remote.vault;
      signal.throwIfAborted();
      setNewLoginNeeded(false);

      if (local && cloud && (local.vault.id !== cloud.id || local.vault.salt !== cloud.salt)) {
        local.root.fill(0);
        local = null;
      }
      if (!cloud && !local) {
        if (!remote.legacy && !material) { setNewLoginNeeded(true); return; }
        local = await createVault();
        if (material) local.vault.account = await wrapAccountVault(material, local.vault, local.root);
        signal.throwIfAborted();
        if (!await rememberDeviceVault(account, local, true)) {
          local.root.fill(0);
          local = await readDeviceVault(account);
        }
      }
      signal.throwIfAborted();
      if (!cloud && local) {
        try {
          await api('/private-sync/vault', 'PUT', local.vault, signal);
          cloud = local.vault;
        } catch (failure) {
          if (!(failure instanceof ApiError) || failure.code !== 'sync_vault_exists') throw failure;
          remote = await getVault();
          cloud = remote.vault;
          if (!cloud) throw failure;
        }
      }
      if (!cloud) return;
      signal.throwIfAborted();
      setLiveAudio(remote.liveAudio === true);
      setLiveAudioV2(remote.liveAudioV2 === true);
      try { localStorage.setItem('lingji:live-audio', remote.liveAudio && cloud ? cloud.id : ''); } catch {}
      setLegacyAccount(remote.legacy);
      setEmptyUpgrade(remote.emptyUpgrade === true);
      setVault(cloud);
      if (local?.vault.id === cloud.id && local.vault.salt === cloud.salt) {
        if (!secret.current) await enter({ ...local, vault: cloud }, signal);
      } else if (material && remote.account) {
        local?.root.fill(0);
        local = { vault: cloud, root: await openAccountVault(material, cloud, remote.account) };
        signal.throwIfAborted();
        await rememberDeviceVault(account, local);
        await enter(local, signal);
      } else {
        forget();
        setUnlocked(false);
        setNewLoginNeeded(!remote.legacy);
      }
    } finally {
      if (local && local.root !== secret.current) local.root.fill(0);
      material?.fill(0);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const material = accountLogin?.email === email ? accountLogin.material : undefined;
    void connectAccount(email, controller.signal, material)
      .then(() => { if (!controller.signal.aborted) { setError(''); setReady(true); } })
      .catch(failure => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401 && !secret.current) {
          void signOut().catch(error => setError(syncError(error)));
          return;
        }
        setError(syncError(failure));
        setReady(true);
      });
    return () => { controller.abort(); forget(); };
  }, [email, accountLogin]);

  function run(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setError(''); setNotice('');
    const start = async () => {
      await Promise.all([background.current, archivePush.current]);
      controller.signal.throwIfAborted();
      await action(controller.signal);
    };
    void start().catch(failure => {
      if (!controller.signal.aborted) setError(syncError(failure));
    }).finally(() => {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    });
  }

  useEffect(() => {
    if (!ready || !online || !unlocked || !vault || !phoneMeetingSync) return;
    const localVault = vault;
    const controller = new AbortController(), signal = controller.signal;
    let failures = 0, retryAt = 0, timer: number;
    let networkFailure = false;
    async function cycle() {
      if (pending.current || !secret.current || signal.aborted || Date.now() < retryAt) return;
      if (document.hidden) return;
      const key = secret.current.slice();
      try {
        const synced = await syncMeetings(localVault, key, signal);
        signal.throwIfAborted();
        if (synced.received) {
          const next = await meetingCopies(localVault, key);
          if (!signal.aborted) setCopies(next);
        }
        if (!signal.aborted) setBackgroundIssue('');
        failures = 0;
        networkFailure = false;
      } catch (failure) {
        if (signal.aborted) return;
        networkFailure = failure instanceof ApiError && failure.status === 0;
        retryAt = Date.now() + Math.min(120_000, 8_000 * 2 ** Math.min(++failures, 4));
        setBackgroundIssue(syncError(failure));
      } finally {
        key.fill(0);
      }
    }
    function runCycle() {
      window.clearTimeout(timer);
      if (signal.aborted) return;
      timer = window.setTimeout(runCycle, meetingPage.current ? 2000 : 12_000);
      if (background.current) return;
      const work = cycle();
      background.current = work;
      void work.finally(() => { if (background.current === work) background.current = null; });
    }
    addEventListener('lingji:sync-wakeup', runCycle);
    const onNetworkChange = () => {
      if (networkFailure) retryAt = 0;
      runCycle();
    };
    addEventListener('lingji:network-changed', onNetworkChange);
    const onVisible = () => { if (!document.hidden) runCycle(); };
    document.addEventListener('visibilitychange', onVisible);
    runCycle();
    return () => {
      window.clearTimeout(timer);
      removeEventListener('lingji:sync-wakeup', runCycle);
      removeEventListener('lingji:network-changed', onNetworkChange);
      document.removeEventListener('visibilitychange', onVisible);
      controller.abort();
    };
  }, [ready, online, unlocked, vault, phoneMeetingSync]);

  useEffect(() => {
    meetingPage.current = mobilePage === 'meetings';
    if (meetingPage.current) dispatchEvent(new Event('lingji:sync-wakeup'));
  }, [mobilePage]);
  useEffect(() => {
    if (!ready || !online || !unlocked || !vault) return;
    const localVault = vault;
    const controller = new AbortController(), signal = controller.signal;
    let failures = 0, retryAt = 0;
    let networkFailure = false;
    async function cycle() {
      if (pending.current || !secret.current || signal.aborted || Date.now() < retryAt) return;
      if (document.hidden && !recording) return;
      try {
        const result = await pushMobileRecordings(localVault, signal);
        signal.throwIfAborted();
        if (result.sent || result.pending) setMobileStatus(result.pending ? '正在同步到电脑…' : '已同步到云端');
        failures = 0;
        networkFailure = false;
      } catch (failure) {
        if (signal.aborted) return;
        networkFailure = failure instanceof ApiError && failure.status === 0;
        retryAt = Date.now() + Math.min(120_000, 8_000 * 2 ** Math.min(++failures, 4));
        setMobileStatus('同步暂缓，将自动重试');
      }
    }
    const runCycle = () => {
      if (archivePush.current) return;
      const work = cycle();
      archivePush.current = work;
      void work.finally(() => { if (archivePush.current === work) archivePush.current = null; });
    };
    const timer = setInterval(runCycle, 10_000);
    const onNetworkChange = () => {
      if (networkFailure) retryAt = 0;
      runCycle();
    };
    addEventListener('lingji:network-changed', onNetworkChange);
    const onVisible = () => { if (!document.hidden) runCycle(); };
    document.addEventListener('visibilitychange', onVisible);
    runCycle();
    return () => {
      clearInterval(timer);
      removeEventListener('lingji:network-changed', onNetworkChange);
      document.removeEventListener('visibilitychange', onVisible);
      controller.abort();
    };
  }, [ready, online, unlocked, vault, recording]);

  useEffect(() => {
    if ((liveAudio && liveAudioV2) || !online || !vault || !unlocked) return;
    const controller = new AbortController();
    const probe = () => {
      void api<{ vault: Vault | null; liveAudio?: boolean; liveAudioV2?: boolean }>('/private-sync/vault', 'GET', undefined, controller.signal)
        .then(remote => {
          if (!controller.signal.aborted && remote.vault?.id === vault.id) {
            setLiveAudio(remote.liveAudio === true || remote.liveAudioV2 === true);
            if (remote.liveAudioV2) setLiveAudioV2(true);
          }
        }).catch(() => {});
    };
    const timer = window.setInterval(probe, 60_000);
    if (recording) probe();
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [liveAudio, liveAudioV2, online, vault, unlocked, recording]);

  useEffect(() => {
    if (!ready || !online || !unlocked || !vault || !liveAudio) return;
    const controller = new AbortController();
    const { signal } = controller;
    const localVault = vault;
    let timer = 0, running = false, woken = false, failures = 0, retryAt = 0;
    let networkFailure = false;
    function schedule(delay: number) {
      window.clearTimeout(timer);
      if (!signal.aborted) timer = window.setTimeout(() => void cycle(), Math.max(delay, retryAt - Date.now()));
    }
    function wakeup() {
      if (running) woken = true;
      else schedule(0);
    }
    async function cycle() {
      if (signal.aborted || !secret.current) return;
      const capture = activeLive.current;
      if (document.hidden && !capture.id && !recording) {
        schedule(15_000);
        return;
      }
      running = true;
      woken = false;
      let more = false;
      const key = secret.current.slice();
      try {
        const [legacy, pushed, pulled] = await Promise.allSettled([
          pushLiveAudio(localVault, 'phone', signal),
          liveAudioV2 ? pushLiveAudio(localVault, 'phone-v2', signal) : [],
          liveAudioV2 && capture.id && !capture.received
            ? pullLiveAudio(localVault, key, 'phone', signal, frame => {
              if (frame.id === activeLive.current.id && !signal.aborted) {
                activeLive.current.received = true;
                setLiveStatus('电脑已接收');
              }
            })
            : false,
        ]);
        signal.throwIfAborted();
        if (pushed.status === 'rejected') throw pushed.reason;
        more = pushed.value.length === 8 || (legacy.status === 'fulfilled' && legacy.value.length === 8);
        if (activeLive.current === capture && !capture.received && !capture.uploaded &&
          [...pushed.value, ...(legacy.status === 'fulfilled' ? legacy.value : [])]
            .some(item => Array.isArray(item) && item[2] === capture.id)) {
          capture.uploaded = true;
          setLiveStatus('音频已上传');
        }
        if (pulled.status === 'rejected') throw pulled.reason;
        if (!liveAudioV2 && legacy.status === 'rejected') throw legacy.reason;
        more ||= pulled.value;
        setLiveIssue('');
        failures = 0;
        retryAt = 0;
        networkFailure = false;
      } catch (failure) {
        if (signal.aborted) return;
        networkFailure = failure instanceof ApiError && failure.status === 0;
        retryAt = Date.now() + (failure instanceof ApiError && failure.status === 429
          ? 15_000 : Math.min(8000, 1000 * 2 ** Math.min(failures++, 3)));
        setLiveIssue(failure instanceof ApiError && failure.status === 413
          ? '云空间已满，录音将保存在手机'
          : failure instanceof ApiError && failure.status === 401 ? '登录已过期，录音将保存在手机' : '音频待同步 · 自动重试');
      } finally {
        key.fill(0);
        running = false;
        const waitingReceipt = Boolean(liveAudioV2 && activeLive.current.id && !activeLive.current.received);
        schedule(woken || more ? 0 : waitingReceipt ? 1000 : (recording ? 4000 : 12_000));
      }
    }
    addEventListener('lingji:live-audio-ready', wakeup);
    const onNetworkChange = () => {
      if (networkFailure) retryAt = 0;
      wakeup();
    };
    addEventListener('lingji:network-changed', onNetworkChange);
    document.addEventListener('visibilitychange', wakeup);
    wakeup();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      removeEventListener('lingji:live-audio-ready', wakeup);
      removeEventListener('lingji:network-changed', onNetworkChange);
      document.removeEventListener('visibilitychange', wakeup);
    };
  }, [ready, online, unlocked, vault, liveAudio, liveAudioV2, recording]);

  function upgradeAccount(event: FormEvent<HTMLFormElement>, replaceEmpty = false) {
    event.preventDefault();
    if (!vault || (!secret.current && !(replaceEmpty && emptyUpgrade))) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    run(async signal => {
      const draft = replaceEmpty ? await createVault() : undefined;
      const root = draft?.root ?? secret.current;
      if (!root) return;
      let material: Uint8Array<ArrayBuffer> | undefined;
      try {
        ({ material } = await authenticateAccount({
          email, password: String(fields.get('newPassword')), desktop: false, signal,
          upgrade: { currentPassword: String(fields.get('currentPassword')), vault: draft?.vault ?? vault, root, replaceEmpty },
        }));
        signal.throwIfAborted();
        if (draft) {
          await rememberDeviceVault(email, draft);
          await connectAccount(email, signal, material);
        }
        form.reset();
        setLegacyAccount(false);
        setEmptyUpgrade(false);
        setNotice('账号已升级，新设备登录后会自动解锁');
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === 'sync_legacy_history') setEmptyUpgrade(false);
        throw failure;
      } finally {
        material?.fill(0);
        draft?.root.fill(0);
      }
    });
  }

  function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const code = String(new FormData(form).get('kit'));
    form.reset();
    if (vault) run(async signal => enter({ vault, root: await recoverVault(vault, code), kit: code.trim() }, signal, true));
  }

  function useInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (vault) run(async signal => {
      const { joinInvite } = await import('../sync/pairing');
      await enter({ vault, root: await joinInvite(vault, pairCode, location.origin, signal) }, signal, true);
    });
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (profileSaving || !online || name === null) return;
    setProfileSaving(true);
    setProfileError('');
    try {
      const data = await api<{ name: string }>('/private-sync/profile', 'PATCH', { name });
      setProfile(data.name);
      try { localStorage.setItem(profileKey, data.name); } catch {}
      setProfileEditor(false);
      setNotice('个人设置已保存');
    } catch (failure) { setProfileError(syncError(failure)); }
    finally { setProfileSaving(false); }
  }

  const upgradingHere = legacyAccount && (unlocked || emptyUpgrade);
  const inlineErrorShown = !vault && mobilePage === 'record' && Boolean(!online || newLoginNeeded || error);
  const feedback = error && !inlineErrorShown
    ? <FeedbackNotice key={error} message={error} error/>
    : notice ? <FeedbackNotice key={notice} message={notice} warning={false}/> : null;

  const account = (logout: ReactNode) => <section className="mobile-account-card" aria-label="账号资料">
    <div className="mobile-account-identity">
      <span className="account-avatar" aria-hidden="true">{(profile || email || '聆').slice(0, 1).toUpperCase()}</span>
      <div><strong>{profile || '个人账号'}</strong><small title={email}>{email}</small>
        <span className="mobile-encryption-pill" data-unlocked={unlocked}>
          <ShieldCheck size={13} aria-hidden="true"/>{unlocked ? '端到端加密' : '资料库未解锁'}
        </span>
      </div>
      <div className="mobile-profile-actions">
        <Button variant="ghost" onClick={() => { setName(null); setProfileError(''); setProfileEditor(true); }}>编辑资料</Button>
        {logout}
      </div>
    </div>
    {profileEditor && <MobileSheet title="编辑资料" close={() => { if (!profileSaving) setProfileEditor(false); }}>
      <form className="mobile-profile-form" onSubmit={saveProfile}>
        <label htmlFor="phone-profile-name">显示名称</label>
        <input id="phone-profile-name" placeholder="输入显示名称" autoComplete="nickname" maxLength={60}
          value={name ?? profile} disabled={profileSaving} onChange={event => setName(event.target.value)}/>
        {profileError && <p role="alert">{profileError}</p>}
        <Button variant="primary" type="submit" disabled={!online || profileSaving || (name ?? profile).trim() === profile}>{profileSaving ? '正在保存…' : '保存'}</Button>
      </form>
    </MobileSheet>}
  </section>;

  // Each recording keeps the protocol selected when capture started.
  const legacyLive = liveAudio && !liveAudioV2;
  const directSupported = /\bLingJi-Android\b/.test(navigator.userAgent) && typeof RTCPeerConnection === 'function';
  const holdForDirect = directSupported && preferDirect;
  const recorder = vault && unlocked && !legacyAccount ? <QuickMobileRecording
    visible={mobilePage === 'record'}
    showRecorder={() => { setMobilePage('record'); window.scrollTo(0, 0); }}
    status={holdForDirect ? '结束后可选择发送到 Mac' : !online ? '离线保存，回网自动同步' : !liveAudio ? '录音保存在本机' : liveIssue || liveStatus || mobileStatus}
    append={async (entry, sequence, offset, bytes) => {
      if (!secret.current) throw new Error('资料库未解锁');
      const key = secret.current.slice();
      let pcm: PackedMobilePcm | undefined;
      let localPcm: PackedLocalMobilePcm | undefined;
      try {
        const wire = await packMobilePcm(bytes);
        pcm = wire;
        localPcm = await packLocalMobilePcm(bytes, wire).catch(() => wire);
        await appendMobileRecording(vault, key, entry, sequence, localPcm);
        await queueLiveAudio(vault, key, entry.id, entry.title, {
          kind: 'pcm', sequence, offset, pcm: wire, recordedAt: sequence === 0 ? entry.at : undefined,
        }, legacyLive, holdForDirect);
        dispatchEvent(new Event('lingji:live-audio-ready'));
      } finally {
        key.fill(0);
        if (localPcm && localPcm.bytes !== pcm?.bytes) localPcm.bytes.fill(0);
        if (pcm && pcm.bytes !== bytes) pcm.bytes.fill(0);
      }
    }}
    onLiveRecording={id => {
      if (holdForDirect) return;
      activeLive.current = { id, uploaded: false, received: false };
      setLiveStatus(id ? '正在上传音频' : '');
      if (id) dispatchEvent(new Event('lingji:live-audio-ready'));
    }}
    onActive={mobileActive}
    commit={async (entry, sequence) => {
      if (!secret.current) throw new Error('资料库未解锁');
      const key = secret.current.slice();
      try {
        const saved = holdForDirect ? { ...entry, directReady: true as const } : entry;
        await queueLiveAudio(vault, key, entry.id, entry.title, { kind: 'finish', sequence }, legacyLive, holdForDirect);
        await finishMobileRecording(vault, key, saved);
        setPhoneCopies(items => [saved, ...items.filter(item => item.id !== entry.id)]);
        dispatchEvent(new Event('lingji:live-audio-ready'));
      } finally { key.fill(0); }
    }}/> : mobilePage === 'record' && (!ready ? <section className="quick-mobile-recording" aria-label="正在连接">
      <div className="mobile-connecting-state" role="status"><span className="mobile-connecting-dot" aria-hidden="true"/><span>正在解锁资料库…</span></div>
    </section> : <div className="quick-mobile-setup sync-settings">
      {upgradingHere && <section className="account-section"><header><h2>升级账号</h2></header><div className="account-panel">
        <p>{unlocked ? '设置新密码，保留历史会议。' : '暂无云端会议或录音，可在此设备设置新密码。'}</p>
        <form className="sync-form" onSubmit={event => upgradeAccount(event, !unlocked)}>
          <label>当前密码<input type="password" name="currentPassword" required minLength={10} maxLength={128} autoComplete="current-password"/></label>
          <label>新密码<input type="password" name="newPassword" required minLength={10} maxLength={128} autoComplete="new-password"/></label>
          <Button type="submit" variant="primary" disabled={busy || !online}>升级账号</Button>
        </form>
      </div></section>}
      {!upgradingHere && vault && !unlocked && <section className="account-section"><header><h2>恢复访问</h2></header><div className="account-panel">
        {newLoginNeeded
          ? <Button variant="primary" disabled={busy || !online} onClick={() => { void signOut().catch(error => setError(syncError(error))); }}>重新登录以解锁</Button>
          : <p>可使用恢复密钥或从已登录设备配对解锁。</p>}
        <details className="sync-options">
          <summary>其他恢复方式</summary>
          <details className="sync-options">
            <summary>从旧设备配对</summary>
            <form className="sync-form" onSubmit={useInvitation}>
              <label>配对码<input value={pairCode} onChange={event => setPairCode(event.target.value)} required autoComplete="off" spellCheck={false}/></label>
              <Button type="submit" disabled={busy}>连接设备</Button>
            </form>
          </details>
          <details className="sync-options">
            <summary>恢复资料库</summary>
            <form className="sync-form" onSubmit={recover}>
              <label>恢复密钥<input type="password" name="kit" required autoComplete="off" spellCheck={false}/></label>
              <Button type="submit" disabled={busy}>恢复资料库</Button>
            </form>
          </details>
        </details>
      </div></section>}
      {!vault && (!online || newLoginNeeded || error) && <div className="phone-unlock-state">
        <h2>{!online ? '等待网络连接' : newLoginNeeded ? '请重新登录' : '同步暂未连接'}</h2>
        {error && <p role="alert">{error}</p>}
        {online && (newLoginNeeded || error) && <div className="phone-unlock-actions">
          {!newLoginNeeded && <Button variant="primary" disabled={busy} onClick={() => run(signal => connectAccount(email, signal))}>重试</Button>}
          <Button variant={newLoginNeeded ? 'primary' : 'ghost'} disabled={busy} onClick={() => { void signOut().catch(error => setError(syncError(error))); }}>重新登录</Button>
        </div>}
      </div>}
    </div>);

  return <>
    <MobileWorkspace email={email} legacyAccount={legacyAccount} signOut={signOut} recording={recording} page={mobilePage} setPage={setMobilePage} online={online} unlocked={unlocked}
      automatic={phoneMeetingSync} setAutomatic={enabled => {
        if (!vault) return;
        try { localStorage.setItem('lingji:phone-meetings:' + vault.id, enabled ? '1' : '0'); }
        catch { setError('无法在本机保存同步设置'); return; }
        setPhoneMeetingSync(enabled);
      }}
      direct={directSupported && vault && unlocked ? {
        enabled: preferDirect,
        change: enabled => {
          try { localStorage.setItem('lingji:phone-direct:' + vault.id, enabled ? '1' : '0'); } catch { return; }
          setPreferDirect(enabled);
        },
        send: entry => <MobileDirectSend vault={vault} secret={secret} entry={entry} online={online}/>,
      } : undefined} copies={copies} saved={phoneCopies} hidden={hidden} recorder={recorder} account={account}
      read={readMobileMeeting} saveAnnotations={saveMobileAnnotations} play={playMobileRecording}
      search={searchMobileMeetings} deleteLocal={deleteLocalRecording}/>
    {feedback}
    {backgroundIssue && <p className="account-feedback" role="status">{backgroundIssue}。将自动重试。</p>}
  </>;
}
