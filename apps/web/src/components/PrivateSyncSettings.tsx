import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, messageOf } from '../api';
import type { RecordDetail, RecordListItem } from '../model';
import { createVault, recoverVault, type Envelope, type Vault } from '../sync/vault';
import { authenticateAccount, openAccountVault, wrapAccountVault } from '../sync/account';
import { readDeviceVault, rememberDeviceVault, type DeviceVault } from '../sync/device';
import { loadMeetingCopy, meetingCopies, queueMeeting, syncMeetings, type CopySummary } from '../sync/journal';
import { enrollPasskey, unlockPasskey } from '../sync/passkey';
import { acknowledgeMobileRecording, nextMobileRecording, pushMobileRecordings, queueMobileRecording, receiveMobileRecordings } from '../sync/mobile';
import { Button } from './ui';
import { ExternalLink } from './ExternalLink';
import { FeedbackNotice } from './FeedbackNotice';
import { ThemeToggle } from './ThemeToggle';
import { QuickMobileRecording } from './QuickMobileRecording';
import './PrivateSyncSettings.css';

type Session = { email: string | null; companion: string };
type Invitation = Awaited<ReturnType<typeof import('../sync/pairing').createInvitation>>;

function downloadKit(text: string) {
  const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'LingJi-Recovery-Kit.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function syncError(error: unknown) {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      sync_invalid_operations: '会议超过本次同步上限',
      sync_quota_exceeded: '云端资料库空间已满',
      sync_server_unavailable: '暂时无法连接同步服务，已排队的内容会保留在本机',
      sync_sign_in_required: '请重新登录同步账号',
      sync_vault_exists: '该账号已创建加密资料库，请刷新后解锁',
      invalid_credentials: '邮箱或密码有误',
      already_exists: '该邮箱已注册，请登录',
      sync_pair_unavailable: '配对已过期或已被另一台设备领取',
      sync_no_passkey: '此账号尚未添加通行密钥',
      sync_challenge_expired: '通行密钥验证已过期，请重试',
      sync_webauthn_verification_failed: '通行密钥验证未通过',
      sync_restore_conflict: '先前恢复的副本已删除或过期',
    };
    if (messages[error.code]) return messages[error.code];
  }
  if (error instanceof DOMException && error.name === 'OperationError') return '解锁失败，请核对恢复密钥或通行密钥';
  if (error instanceof DOMException && error.name === 'NotAllowedError') return '通行密钥验证未完成，你也可以用恢复密钥或配对解锁';
  return messageOf(error);
}

export function PrivateSyncSettings({ desktop, email, accountLogin, accountChanged, record, restored, imported, mobileActive, online = true, visible = true, recording = false, mobile = false }: {
  desktop: boolean;
  email?: string;
  accountLogin?: { email: string; material: Uint8Array<ArrayBuffer> };
  accountChanged?: (email: string | null) => void;
  record?: RecordDetail | null;
  restored?: (id: string) => void;
  imported?: () => void;
  mobileActive?: (active: boolean) => void;
  online?: boolean;
  visible?: boolean;
  recording?: boolean;
  mobile?: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [register, setRegister] = useState(false);
  const [legacyPrompt, setLegacyPrompt] = useState(false);
  const [legacyAccount, setLegacyAccount] = useState(false);
  const [newLoginNeeded, setNewLoginNeeded] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [vault, setVault] = useState<Vault>();
  const [backup, setBackup] = useState<string>();
  const [unlocked, setUnlocked] = useState(false);
  const [copies, setCopies] = useState<CopySummary[]>([]);
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [profile, setProfile] = useState(''), [name, setName] = useState('');
  const [automatic, setAutomatic] = useState(false);
  const seen = useRef(new Map<string, string>());
  const importedCallback = useRef(imported);
  importedCallback.current = imported;
  const [mobileStatus, setMobileStatus] = useState('');
  const [backgroundIssue, setBackgroundIssue] = useState('');
  const [invitation, setInvitation] = useState<Invitation | null>(null), [qr, setQr] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [approve, setApprove] = useState<(() => void) | null>(null);
  const secret = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const pending = useRef<AbortController | null>(null);
  const background = useRef<Promise<void> | null>(null);
  const accountEmail = desktop ? session?.email : email;
  const automationKey = vault ? 'lingji:auto-sync:' + vault.id : undefined;

  useEffect(() => {
    seen.current.clear();
    try { setAutomatic(Boolean(automationKey && localStorage.getItem(automationKey) === '1')); }
    catch { setAutomatic(false); }
  }, [automationKey]);

  useEffect(() => {
    if (!visible || !online || !accountEmail) return;
    const controller = new AbortController();
    void api<{ name: string }>('/private-sync/profile', 'GET', undefined, controller.signal)
      .then(({ name }) => { if (!controller.signal.aborted) { setProfile(name); setName(name); } })
      .catch(() => {});
    return () => controller.abort();
  }, [visible, online, accountEmail]);
  function forget() {
    pending.current?.abort();
    pending.current = null;
    secret.current?.fill(0);
    secret.current = null;
  }

  async function connectAccount(account: string, signal: AbortSignal, material?: Uint8Array<ArrayBuffer>) {
    let local: DeviceVault | null = null;
    try {
      if (mobile && !navigator.onLine) {
        local = await readDeviceVault(account);
        signal.throwIfAborted();
        if (local) await enter(local, signal);
        return;
      }
      const getVault = () => api<{ vault: Vault | null; account?: Envelope; legacy: boolean }>('/private-sync/vault', 'GET', undefined, signal);
      let remote = await getVault();
      let cloud = remote.vault;
      signal.throwIfAborted();
      setLegacyAccount(remote.legacy);
      setNewLoginNeeded(false);
      if (cloud) setVault(cloud);
      local = await readDeviceVault(account, cloud ?? undefined);

      if (!cloud && !local) {
        if (!remote.legacy && !material) { setNewLoginNeeded(true); return; }
        local = await createVault();
        if (material) local.vault.account = await wrapAccountVault(material, local.vault, local.root);
        signal.throwIfAborted();
        // Save before publishing so a lost response cannot strand the initial vault.
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
      setVault(cloud);
      if (local?.vault.id === cloud.id && local.vault.salt === cloud.salt) {
        await enter({ ...local, vault: cloud }, signal);
      } else if (material && remote.account) {
        local?.root.fill(0);
        local = { vault: cloud, root: await openAccountVault(material, cloud, remote.account) };
        signal.throwIfAborted();
        await rememberDeviceVault(account, local);
        await enter(local, signal);
      } else {
        setNewLoginNeeded(!remote.legacy);
      }
    } finally {
      if (local && local.root !== secret.current) local.root.fill(0);
      material?.fill(0);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const account = desktop ? await api<Session>('/private-sync/session', 'GET', undefined, controller.signal) : null;
      controller.signal.throwIfAborted();
      if (account) { setSession(account); accountChanged?.(account.email); }
      const owner = desktop ? account?.email : email;
      if (owner) {
        const material = accountLogin?.email === owner ? accountLogin.material : undefined;
        await connectAccount(owner, controller.signal, material);
      }
      setError('');
      setReady(true);
    }
    void load().catch(failure => { if (!controller.signal.aborted) { setError(syncError(failure)); setReady(true); } });
    return () => { controller.abort(); forget(); };
  }, [desktop, email, accountChanged, accountLogin]);

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

  async function update(localVault: Vault, key: Uint8Array<ArrayBuffer>, signal: AbortSignal, explicit = true) {
    const result = await syncMeetings(localVault, key, signal);
    signal.throwIfAborted();
    if (result.received || explicit) {
      const next = await meetingCopies(localVault, key);
      signal.throwIfAborted();
      setCopies(next);
    }
    if (explicit) setNotice(result.pending ? '仍有会议待传，可继续同步' : '同步完成');
  }

  useEffect(() => {
    if (!ready || !online || !unlocked || !vault || !accountEmail || recording) return;
    if (!desktop && !mobile) return;
    const localVault = vault, owner = accountEmail;
    const controller = new AbortController(), signal = controller.signal;
    let active = false, failures = 0, retryAt = 0;
    async function cycle() {
      if (active || pending.current || !secret.current || signal.aborted || Date.now() < retryAt) return;
      active = true;
      const key = secret.current.slice();
      try {
        if (mobile) {
          const result = await pushMobileRecordings(localVault, signal);
          signal.throwIfAborted();
          if (result.sent || result.pending) setMobileStatus(result.pending ? '正在同步到电脑…' : '已同步到云端');
        } else {
          if (automatic) {
            const { records } = await api<{ records: RecordListItem[] }>('/records', 'GET', undefined, signal);
            const liveIds = new Set(records.map(item => item.id));
            for (const id of seen.current.keys()) if (!liveIds.has(id)) seen.current.delete(id);
            const changed = records.filter(item => item.capture === 'completed' && seen.current.get(item.id) !== item.updatedAt).slice(0, 6);
            for (const item of changed) {
              const detail = await api<RecordDetail>('/records/' + item.id, 'GET', undefined, signal);
              signal.throwIfAborted();
              await queueMeeting(localVault, key, detail).catch(error => {
                if (!(error instanceof Error) || error.message !== '会议超过同步大小上限') throw error;
                setNotice('有会议超过同步大小上限');
              });
              seen.current.set(item.id, item.updatedAt);
            }
          }
          await update(localVault, key, signal, false);
          await receiveMobileRecordings(localVault, key, signal);
          const next = await nextMobileRecording(localVault, key);
          if (next) {
            signal.throwIfAborted();
            const record = await api<RecordDetail>('/private-sync/recording', 'POST', { vault: localVault.id, id: next.id, title: next.title }, signal);
            if (!record.deleted && !['sealed', 'completed'].includes(record.capture)) {
              const { permitQueueRecord, localManifests } = await import('../audio/queue');
              permitQueueRecord(record.id);
              const { importAudio } = await import('../audio/capture');
              await importAudio(next.file, record, () => {}, signal, record.sources.find(source => source.kind === 'import'));
              const [item, manifests] = await Promise.all([api<RecordDetail>('/records/' + record.id, 'GET', undefined, signal), localManifests(record.id)]);
              await api('/records/' + record.id + '/seal', 'POST', {
                sources: item.sources.map(source => ({ sourceId: source.id, sessionId: source.sessionId, epoch: source.epoch,
                  lastSequence: source.lastSequence ?? manifests.find(manifest => manifest.sourceId === source.id && manifest.epoch === source.epoch)?.lastSequence ?? source.watermark })),
              }, signal);
            }
            await acknowledgeMobileRecording(localVault, next.id);
            if (!signal.aborted) importedCallback.current?.();
          }
        }
        if (!signal.aborted) setBackgroundIssue('');
        failures = 0;
      } catch (failure) {
        if (signal.aborted) return;
        if (desktop && failure instanceof ApiError && failure.status === 401) {
          lock();
          setSession(current => current?.email === owner ? { ...current, email: null } : current);
          accountChanged?.(null);
        } else {
          retryAt = Date.now() + Math.min(120_000, 8_000 * 2 ** Math.min(++failures, 4));
          if (mobile) setMobileStatus('同步暂缓，将自动重试');
          else setBackgroundIssue(syncError(failure));
        }
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
    const timer = setInterval(runCycle, mobile ? 5000 : 15000);
    addEventListener('lingji:sync-wakeup', runCycle);
    runCycle();
    return () => {
      clearInterval(timer);
      removeEventListener('lingji:sync-wakeup', runCycle);
      controller.abort();
    };
  }, [ready, online, accountEmail, unlocked, vault, desktop, mobile, automatic, recording, accountChanged]);

  async function enter(device: DeviceVault, signal: AbortSignal, remember = false) {
    const { vault: localVault, root: key } = device;
    let kit = device.kit;
    try {
      signal.throwIfAborted();
      if (remember && accountEmail) {
        if (!kit) {
          const previous = await readDeviceVault(accountEmail, localVault).catch(() => null);
          kit = previous?.kit;
          previous?.root.fill(0);
        }
        signal.throwIfAborted();
        await rememberDeviceVault(accountEmail, { ...device, kit });
      }
      signal.throwIfAborted();
      secret.current?.fill(0);
      secret.current = key;
      setUnlocked(true);
      setVault(localVault);
      setBackup(kit);
      setPairCode('');
      const local = await meetingCopies(localVault, key);
      signal.throwIfAborted();
      setCopies(local);
      if (navigator.onLine && !mobile) await update(localVault, key, signal);
    } finally {
      if (secret.current !== key) key.fill(0);
    }
  }

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const email = String(fields.get('email')), password = String(fields.get('password'));
    run(async signal => {
      const result = legacyPrompt
        ? { user: await api<Session>('/private-sync/session', 'POST', { email, password }, signal), material: undefined }
        : await authenticateAccount({ email, password, register, desktop: true, signal }).catch(failure => {
            if (failure instanceof ApiError && failure.code === 'account_legacy') setLegacyPrompt(true);
            throw failure;
          });
      const { user, material } = result;
      try {
        signal.throwIfAborted();
        setRegister(false); setLegacyPrompt(false);
        form.reset();
        setSession({ email: user.email, companion: user.companion || '' });
        accountChanged?.(user.email);
        setVault(undefined);
        if (user.email) await connectAccount(user.email, signal, material);
      } finally { material?.fill(0); }
    });
  }

  function upgradeAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!vault || !accountEmail || !secret.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form), root = secret.current;
    run(async signal => {
      const { material } = await authenticateAccount({
        email: accountEmail, password: String(fields.get('newPassword')), desktop, signal,
        upgrade: { currentPassword: String(fields.get('currentPassword')), vault, root },
      });
      material.fill(0);
      signal.throwIfAborted();
      form.reset();
      setLegacyAccount(false);
      setNotice('账号已升级，新设备登录后会自动解锁');
    });
  }

  function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const code = String(new FormData(form).get('kit'));
    form.reset();
    if (vault) run(async signal => enter({ vault, root: await recoverVault(vault, code), kit: code.trim() }, signal, true));
  }

  function lock() {
    forget();
    setNewLoginNeeded(!legacyAccount);
    setUnlocked(false); setBackup(undefined); setInvitation(null); setApprove(null); setCopies([]); setQr(''); setPairCode(''); setBusy(false);
    setBackgroundIssue(''); setNotice('当前会话已锁定');
  }

  const relay = desktop ? session?.companion || 'https://lingji.rookiehouse.com' : location.origin;

  function pair() {
    if (!vault || !secret.current) return;
    const key = secret.current;
    run(async signal => {
      const { createInvitation, authorizeInvite } = await import('../sync/pairing');
      const { toDataURL } = await import('qrcode');
      const offer = await createInvitation(vault, relay);
      signal.throwIfAborted();
      const image = await toDataURL(offer.code, { width: 264, margin: 2 });
      setQr(image); setInvitation(offer);
      try {
        await authorizeInvite(vault, key, offer, relay, signal, () => new Promise<void>((resolve, reject) => {
          if (signal.aborted) { reject(signal.reason); return; }
          const remaining = Math.max(0, offer.expires - Date.now());
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
          };
          const cancel = () => { finish(); reject(new Error('配对已取消')); };
          const timer = setTimeout(() => { finish(); reject(new Error('配对已过期')); }, remaining);
          signal.addEventListener('abort', cancel, { once: true });
          setApprove(() => () => { finish(); setApprove(null); resolve(); });
        }));
        setNotice('新设备已配对');
      } finally {
        setInvitation(null); setApprove(null); setQr('');
      }
    });
  }

  function cancelPair() {
    pending.current?.abort();
    pending.current = null;
    setInvitation(null); setApprove(null); setQr(''); setBusy(false);
  }

  function useInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (vault) run(async signal => {
      const { joinInvite } = await import('../sync/pairing');
      await enter({ vault, root: await joinInvite(vault, pairCode, relay, signal) }, signal, true);
    });
  }

  function scan(file?: File) {
    if (!file || file.size > 8 * 1024 * 1024) { setError('请选择不超过 8 MB 的二维码图片'); return; }
    run(async signal => {
      const { default: jsQR } = await import('jsqr');
      const img = await createImageBitmap(file);
      let decoded;
      try {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('无法读取二维码图片');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        decoded = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      } finally { img.close(); }
      signal.throwIfAborted();
      if (!decoded?.data?.startsWith('LJPAIR1.')) throw new Error('未识别到聆记配对码');
      setPairCode(decoded.data);
    });
  }

  const status = error ? <FeedbackNotice key={error} message={error} error/> : notice ? <p role="status" className="muted">{notice}</p> : null;
  if (!ready) return <section className="settings-section"><p role="status">正在加载账号…</p></section>;
  if (desktop && (!online || (!session?.email && !showLogin))) {
    return <section className="settings-section sync-settings account-access" aria-label="本地空间">
      <h2>本机会议</h2>
      <p className="muted">{online ? '登录后可同步会议和接收手机录音。' : '当前离线，可以继续在本机记录和查看会议。'}</p>
      <div className="sync-actions">{online && <Button variant="primary" onClick={() => setShowLogin(true)}>登录在线账号</Button>}<ThemeToggle/></div>
    </section>;
  }
  if (desktop && !session?.email) return <section className="settings-section sync-settings account-access" aria-label="聆记账号">
    <div className="sync-intro"><h2>{register ? '创建聆记账号' : '登录聆记账号'}</h2></div>
    <form onSubmit={signIn} className="sync-form">
      <label>邮箱<input type="email" name="email" autoComplete="username" required onChange={()=>{if(legacyPrompt){setLegacyPrompt(false);setError('');}}}/></label>
      <label>密码<input key={register ? 'new' : 'existing'} type="password" name="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={10} maxLength={128}/></label>
      <div className="sync-actions">
        <Button variant="primary" type="submit" disabled={busy}>{busy ? '请稍候…' : register ? '注册并登录' : legacyPrompt ? '使用旧账号登录' : '登录'}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => { setRegister(!register); setLegacyPrompt(false); setError(''); setNotice(''); }}>{register ? '返回登录' : '注册账号'}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => { setShowLogin(false); setRegister(false); setError(''); }}>返回本地空间</Button>
      </div>
    </form>
    {status}
  </section>;

  return <section className="settings-section sync-settings" aria-label="个人中心">
    {mobile && unlocked && vault && <QuickMobileRecording status={mobileStatus} onActive={mobileActive} save={async (blob, title) => {
      if (!secret.current) throw new Error('请先验证此设备');
      const key = secret.current.slice();
      try {
        await queueMobileRecording(vault, key, blob, title);
        setMobileStatus(online ? '已在本机保存，正在同步…' : '已在本机保存，联网后自动同步');
        dispatchEvent(new Event('lingji:sync-wakeup'));
      } finally { key.fill(0); }
    }}/> }
    <div className="sync-account">
      <div className="sync-intro"><h2>{profile || '个人设置'}</h2><p>{accountEmail}</p></div>
      {desktop && session && <Button variant="ghost" disabled={busy} onClick={() => run(async signal => {
        await api('/private-sync/session', 'DELETE', undefined, signal);
        lock(); setSession({ ...session, email: null }); accountChanged?.(null); setVault(undefined); setLegacyAccount(false); setNewLoginNeeded(false); setProfile(''); setName(''); setShowLogin(false);
      })}>退出账号</Button>}
    </div>
    <form className="sync-form profile-settings" onSubmit={event => {
      event.preventDefault();
      run(async signal => {
        const data = await api<{ name: string }>('/private-sync/profile', 'PATCH', { name }, signal);
        signal.throwIfAborted();
        setName(data.name); setProfile(data.name); setNotice('个人设置已保存');
      });
    }}>
      <label>显示名称<input autoComplete="nickname" maxLength={60} value={name} disabled={!online || busy} onChange={event => setName(event.target.value)}/></label>
      <div className="sync-actions"><Button type="submit" disabled={!online || busy || name.trim() === profile}>保存</Button><ThemeToggle/></div>
    </form>
    {!mobile && <h3>会议同步</h3>}
    {backgroundIssue && <p className="sync-background-issue" role="status">{backgroundIssue}。将自动重试。</p>}
    {legacyAccount && unlocked && <details className="sync-options">
      <summary>升级账号，登录即同步</summary>
      <p>设置一个新密码，之后在其他设备登录就能自动解锁。</p>
      <form className="sync-form" onSubmit={upgradeAccount}>
        <label>当前密码<input type="password" name="currentPassword" required minLength={10} maxLength={128} autoComplete="current-password"/></label>
        <label>新密码<input type="password" name="newPassword" required minLength={10} maxLength={128} autoComplete="new-password"/></label>
        <Button type="submit" disabled={busy || !online}>升级账号</Button>
      </form>
    </details>}
    {!vault && (!online ? <p role="status">联网后可验证此设备。</p> : newLoginNeeded ? <p role="status">请退出后重新登录以解锁同步。</p> : error && accountEmail ? <Button disabled={busy} onClick={() => run(signal => connectAccount(accountEmail, signal))}>重新连接</Button> : <p role="status" className="muted">正在准备会议同步…</p>)}
    {vault && !unlocked && <div className="sync-stack">
      <p>{newLoginNeeded ? '请退出后重新登录以解锁同步。' : '旧账号需确认一次设备，升级后可直接登录同步。'}</p>
      <details className="sync-options">
        <summary>其他验证方式</summary>
        {!desktop && <Button variant="primary" disabled={busy} onClick={() => run(async signal => enter({ vault, root: await unlockPasskey(vault, signal) }, signal, true))}>验证此设备</Button>}
        <details className="sync-options">
          <summary>从旧设备配对</summary>
          <form className="sync-form" onSubmit={useInvitation}>
            <label>配对码<input value={pairCode} onChange={event => setPairCode(event.target.value)} required autoComplete="off" spellCheck={false}/></label>
            <label>或读取二维码图片<input type="file" accept="image/*" disabled={busy} onChange={event => { const file=event.currentTarget.files?.[0]; if(file)scan(file); event.currentTarget.value = ''; }}/></label>
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
    </div>}
    {vault && unlocked && <div className="sync-stack">
      {desktop && <div className="sync-preference"><label><input type="checkbox" checked={automatic} onChange={event => {
        if (!automationKey) return;
        const enabled = event.target.checked;
        try {
          localStorage.setItem(automationKey, enabled ? '1' : '0');
          seen.current.clear();
          setAutomatic(enabled);
        } catch { setError('无法在本机保存同步设置'); }
      }}/> 自动同步本机已完成的会议</label><ExternalLink href={relay + '/quick-record'}>手机快速记录</ExternalLink></div>}
      {!mobile && <div className="sync-actions">
        {record?.capture === 'completed' && <Button variant="primary" disabled={busy} onClick={() => run(async signal => {
          const key = secret.current!;
          await queueMeeting(vault, key, record);
          setNotice('会议已存入本机待传队列');
          await update(vault, key, signal);
        })}>同步当前会议</Button>}
        <Button variant={record?.capture === 'completed' ? undefined : 'primary'} disabled={busy} onClick={() => run(signal => update(vault, secret.current!, signal))}>获取云端更新</Button>
      </div>}
      {!mobile && copies.length > 0 && <ul className="sync-copies">
        {copies.map(copy => <li key={copy.id}>
          <div><strong>{copy.title}</strong><time dateTime={new Date(copy.at).toISOString()}>{new Date(copy.at).toLocaleString()}</time></div>
          {desktop && <Button disabled={busy} onClick={() => run(async signal => {
            const revision = await loadMeetingCopy(vault, secret.current!, copy.id);
            signal.throwIfAborted();
            const result = await api<{ id: string }>('/private-sync/restore', 'POST', { id: revision.id, content: revision.content, notes: revision.notes }, signal);
            setNotice('本机副本已就绪');
            restored?.(result.id);
          })}>恢复到本机</Button>}
        </li>)}
      </ul>}
      <details className="sync-options" open={invitation ? true : undefined}>
        <summary>连接设备与恢复</summary>
        <div className="sync-actions">
          {!invitation && <Button onClick={pair} disabled={busy}>配对新设备</Button>}
          {desktop ? <ExternalLink href={relay}>在浏览器验证设备</ExternalLink> :
            <Button disabled={busy} onClick={() => run(async signal => { await enrollPasskey(vault, secret.current!, signal); setNotice('已信任此浏览器'); })}>信任此浏览器</Button>}
          {backup && <Button onClick={() => downloadKit(backup)}>下载恢复文件</Button>}
          <Button variant="ghost" onClick={lock}>锁定当前会话</Button>
        </div>
        {invitation && <div className="sync-invitation">
          <img src={qr} width={220} height={220} alt="新设备配对二维码"/>
          <div className="sync-stack">
            <p>在新设备登录同一账号后，读取二维码图片或粘贴配对码。邀请五分钟内有效。</p>
            <label>配对码<input value={invitation.code} readOnly onFocus={event => event.currentTarget.select()}/></label>
            {approve && <Button variant="primary" onClick={approve}>确认允许新设备访问会议</Button>}
            <Button onClick={cancelPair}>取消配对</Button>
          </div>
        </div>}
      </details>
    </div>}
    {status}
  </section>;
}
