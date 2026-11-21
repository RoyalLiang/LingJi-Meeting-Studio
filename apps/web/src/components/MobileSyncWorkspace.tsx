import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, messageOf } from '../api';
import { createVault, recoverVault, type Envelope, type Vault } from '../sync/vault';
import { authenticateAccount, openAccountVault, wrapAccountVault } from '../sync/account';
import { readDeviceVault, rememberDeviceVault, type DeviceVault } from '../sync/device';
import { annotateMeeting, clearJournalCache, loadMeetingCopy, meetingCopies, syncMeetings, type CopySummary, type MeetingAnnotations } from '../sync/journal';
import { pullLiveAudio, pushLiveAudio, pushMobileRecordings, queueLiveAudio, queueMobileRecording } from '../sync/mobile';
import { clearMobileLibraryCache, deleteMobileRecording, mobilePlayback, mobileRecordings, rememberMobileRecording, type MobileRecording } from '../sync/mobile-library';
import { Button } from './ui';
import { FeedbackNotice } from './FeedbackNotice';
import { MobileWorkspace, type MobilePage } from './MobileWorkspace';
import { QuickMobileRecording } from './QuickMobileRecording';
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
  signOut: () => void;
}) {
  const [legacyAccount, setLegacyAccount] = useState(false);
  const [newLoginNeeded, setNewLoginNeeded] = useState(false);
  const [emptyUpgrade, setEmptyUpgrade] = useState(false);
  const [vault, setVault] = useState<Vault>();
  const [liveAudio, setLiveAudio] = useState(false);
  const [liveIssue, setLiveIssue] = useState('');
  const activeLive = useRef({ id: '', uploaded: false, received: false });
  const [liveStatus, setLiveStatus] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [copies, setCopies] = useState<CopySummary[]>([]);
  const profileEditor = useRef<HTMLDialogElement>(null);
  const [mobilePage, setMobilePage] = useState<MobilePage>('record');
  const [phoneCopies, setPhoneCopies] = useState<MobileRecording[]>([]);
  const [phoneMeetingSync, setPhoneMeetingSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [profile, setProfile] = useState('');
  const [name, setName] = useState('');
  const [mobileStatus, setMobileStatus] = useState('');
  const [backgroundIssue, setBackgroundIssue] = useState('');
  const [pairCode, setPairCode] = useState('');
  const secret = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const pending = useRef<AbortController | null>(null);
  const background = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (unlocked && liveAudio && vault) {
      try { localStorage.setItem('lingji:live-audio', vault.id); } catch {}
    }
  }, [unlocked, liveAudio, vault]);

  useEffect(() => {
    if (!vault || !unlocked || !secret.current) return;
    const root = secret.current.slice();
    let mounted = true;
    void mobileRecordings(vault, root).then(items => {
      if (mounted) setPhoneCopies(items);
    }).catch(() => {}).finally(() => root.fill(0));
    try { setPhoneMeetingSync(localStorage.getItem('lingji:phone-meetings:' + vault.id) !== '0'); } catch {}
    return () => { mounted = false; };
  }, [vault, unlocked]);

  useEffect(() => {
    if (!online || !email) return;
    const controller = new AbortController();
    void api<{ name: string }>('/private-sync/profile', 'GET', undefined, controller.signal)
      .then(({ name: nextName }) => { if (!controller.signal.aborted) { setProfile(nextName); setName(nextName); } })
      .catch(() => {});
    return () => controller.abort();
  }, [online, email]);

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
    if (!vault) return;
    await deleteMobileRecording(vault, id);
    setPhoneCopies(items => items.filter(item => item.id !== id));
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
        try { setLiveAudio(localStorage.getItem('lingji:live-audio') === local.vault.id); } catch {}
        await enter({ vault: local.vault, root: local.root.slice(), kit: local.kit }, signal);
      }
      if (!navigator.onLine) {
        setReady(true);
        return;
      }
      const getVault = () => api<{ vault: Vault | null; account?: Envelope; legacy: boolean; emptyUpgrade?: boolean; liveAudio?: boolean }>('/private-sync/vault', 'GET', undefined, signal);
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
          signOut();
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
      await background.current;
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
    if (!ready || !online || !unlocked || !vault) return;
    const localVault = vault;
    const controller = new AbortController(), signal = controller.signal;
    let active = false, failures = 0, retryAt = 0;
    async function cycle() {
      if (active || pending.current || !secret.current || signal.aborted || Date.now() < retryAt) return;
      if (document.hidden && !recording) return;
      active = true;
      const key = secret.current.slice();
      try {
        const result = await pushMobileRecordings(localVault, signal);
        signal.throwIfAborted();
        if (result.sent || result.pending) setMobileStatus(result.pending ? '正在同步到电脑…' : '已同步到云端');
        if (phoneMeetingSync) {
          const synced = await syncMeetings(localVault, key, signal);
          signal.throwIfAborted();
          if (synced.received) {
            const next = await meetingCopies(localVault, key);
            if (!signal.aborted) setCopies(next);
          }
        }
        if (!signal.aborted) setBackgroundIssue('');
        failures = 0;
      } catch (failure) {
        if (signal.aborted) return;
        retryAt = Date.now() + Math.min(120_000, 8_000 * 2 ** Math.min(++failures, 4));
        setMobileStatus('同步暂缓，将自动重试');
      } finally {
        key.fill(0);
        active = false;
      }
    }
    const runCycle = () => {
      if (background.current) return;
      const work = cycle();
      background.current = work;
      void work.finally(() => { if (background.current === work) background.current = null; });
    };
    const timer = setInterval(runCycle, 10_000);
    addEventListener('lingji:sync-wakeup', runCycle);
    const onVisible = () => { if (!document.hidden) runCycle(); };
    document.addEventListener('visibilitychange', onVisible);
    runCycle();
    return () => {
      clearInterval(timer);
      removeEventListener('lingji:sync-wakeup', runCycle);
      document.removeEventListener('visibilitychange', onVisible);
      controller.abort();
    };
  }, [ready, online, unlocked, vault, phoneMeetingSync, recording]);

  useEffect(() => {
    if (!ready || !online || !unlocked || !vault || !liveAudio) return;
    const controller = new AbortController();
    const { signal } = controller;
    const localVault = vault;
    let timer = 0, running = false, woken = false, failures = 0, retryAt = 0;
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
        const [pushed, pulled] = await Promise.allSettled([
          pushLiveAudio(localVault, 'phone', signal),
          capture.id && !capture.received
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
        more = pushed.value.length === 8;
        if (activeLive.current === capture && !capture.received && !capture.uploaded &&
          pushed.value.some(item => Array.isArray(item) && item[2] === capture.id)) {
          capture.uploaded = true;
          setLiveStatus('音频已上传');
        }
        if (pulled.status === 'rejected') throw pulled.reason;
        more ||= pulled.value;
        setLiveIssue('');
        failures = 0;
        retryAt = 0;
      } catch (failure) {
        if (signal.aborted) return;
        retryAt = Date.now() + (failure instanceof ApiError && failure.status === 429
          ? 15_000 : Math.min(8000, 1000 * 2 ** Math.min(failures++, 3)));
        setLiveIssue(failure instanceof ApiError && failure.status === 413
          ? '云空间已满，录音将保存在手机'
          : failure instanceof ApiError && failure.status === 401 ? '登录已过期，录音将保存在手机' : '音频待同步 · 自动重试');
      } finally {
        key.fill(0);
        running = false;
        const waitingReceipt = Boolean(activeLive.current.id && !activeLive.current.received);
        schedule(woken || more ? 0 : waitingReceipt ? 1500 : (recording ? 4000 : 12_000));
      }
    }
    addEventListener('lingji:live-audio-ready', wakeup);
    document.addEventListener('visibilitychange', wakeup);
    wakeup();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      removeEventListener('lingji:live-audio-ready', wakeup);
      document.removeEventListener('visibilitychange', wakeup);
    };
  }, [ready, online, unlocked, vault, liveAudio, recording]);

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

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sheet = event.currentTarget.closest('dialog');
    run(async signal => {
      const data = await api<{ name: string }>('/private-sync/profile', 'PATCH', { name }, signal);
      signal.throwIfAborted();
      setName(data.name);
      setProfile(data.name);
      sheet?.close();
      setNotice('个人设置已保存');
    });
  }

  const upgradingHere = legacyAccount && (unlocked || emptyUpgrade);
  const inlineErrorShown = !vault && mobilePage === 'record' && Boolean(!online || newLoginNeeded || error);
  const feedback = error && !inlineErrorShown
    ? <FeedbackNotice key={error} message={error} error/>
    : notice ? <FeedbackNotice key={notice} message={notice} warning={false}/> : null;

  const account = <section className="mobile-account-card" aria-label="账号资料">
    <div className="mobile-account-identity">
      <span className="account-avatar" aria-hidden="true">{(profile || email || '聆').slice(0, 1).toUpperCase()}</span>
      <div><strong>{profile || '个人账号'}</strong><small title={email}>{email}</small></div>
      <Button variant="ghost" onClick={() => profileEditor.current?.showModal()}>编辑资料</Button>
    </div>
    <dialog ref={profileEditor} className="mobile-source-sheet" aria-labelledby="mobile-profile-heading">
      <h2 id="mobile-profile-heading">编辑资料</h2>
      <form className="mobile-profile-form" onSubmit={saveProfile}>
        <label htmlFor="phone-profile-name">显示名称</label>
        <input id="phone-profile-name" placeholder="输入显示名称" autoComplete="nickname" maxLength={60}
          value={name} disabled={!online || busy} onChange={event => setName(event.target.value)}/>
        <Button variant="primary" type="submit" disabled={!online || busy || name.trim() === profile}>保存</Button>
      </form>
      <div className="mobile-sheet-actions mobile-profile-actions">
        <Button variant="ghost" disabled={!online || busy || recording} onClick={() => { forget(); signOut(); }}>退出账号</Button>
        <Button variant="ghost" onClick={() => profileEditor.current?.close()}>关闭</Button>
      </div>
    </dialog>
  </section>;

  const recorder = vault && unlocked && !legacyAccount ? <QuickMobileRecording
    visible={mobilePage === 'record'}
    showRecorder={() => { setMobilePage('record'); window.scrollTo(0, 0); }}
    status={!online ? '离线保存，回网自动同步' : liveIssue || liveStatus || mobileStatus}
    live={liveAudio ? async (id, title, frame) => {
      if (!secret.current) throw new Error('资料库未解锁');
      const key = secret.current.slice();
      try {
        await queueLiveAudio(vault, key, id, title, frame);
        dispatchEvent(new Event('lingji:live-audio-ready'));
      } finally { key.fill(0); }
    } : undefined}
    onLiveRecording={id => {
      activeLive.current = { id, uploaded: false, received: false };
      setLiveStatus(id ? '正在上传音频' : '');
      if (id) dispatchEvent(new Event('lingji:live-audio-ready'));
    }}
    onActive={mobileActive}
    archive={async (entry, blob) => {
      if (!secret.current) throw new Error('资料库未解锁');
      const key = secret.current.slice();
      try {
        await rememberMobileRecording(vault, key, entry, blob);
        setPhoneCopies(items => [entry, ...items.filter(item => item.id !== entry.id)]);
      } finally { key.fill(0); }
    }}
    save={async (id, blob, title) => {
      if (!secret.current) throw new Error('请先解锁会议同步');
      const key = secret.current.slice();
      try {
        await queueMobileRecording(vault, key, blob, title, id);
        setMobileStatus(online ? '已在本机保存，正在同步…' : '已在本机保存，联网后自动同步');
        dispatchEvent(new Event('lingji:sync-wakeup'));
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
        <p>{newLoginNeeded ? '退出账号再登录，即可解锁同步。' : '可使用恢复密钥或从已登录设备配对解锁。'}</p>
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
          <Button variant={newLoginNeeded ? 'primary' : 'ghost'} disabled={busy} onClick={() => { forget(); signOut(); }}>重新登录</Button>
        </div>}
      </div>}
    </div>);

  return <>
    <MobileWorkspace page={mobilePage} setPage={setMobilePage} online={online} unlocked={unlocked}
      automatic={phoneMeetingSync} setAutomatic={enabled => {
        if (!vault) return;
        try { localStorage.setItem('lingji:phone-meetings:' + vault.id, enabled ? '1' : '0'); }
        catch { setError('无法在本机保存同步设置'); return; }
        setPhoneMeetingSync(enabled);
      }}
      copies={copies} saved={phoneCopies} recorder={recorder} account={account}
      read={readMobileMeeting} saveAnnotations={saveMobileAnnotations} play={playMobileRecording}
      search={searchMobileMeetings} deleteLocal={deleteLocalRecording}/>
    {feedback}
    {backgroundIssue && <p className="account-feedback" role="status">{backgroundIssue}。将自动重试。</p>}
  </>;
}
