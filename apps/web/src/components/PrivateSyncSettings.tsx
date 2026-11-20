import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, messageOf } from '../api';
import type { RecordDetail } from '../model';
import { createVault, recoverVault, type Vault } from '../sync/vault';
import { loadMeetingCopy, meetingCopies, queueMeeting, syncMeetings, type CopySummary } from '../sync/journal';
import { enrollPasskey, unlockPasskey } from '../sync/passkey';
import { Button } from './ui';
import { ExternalLink } from './ExternalLink';
import { FeedbackNotice } from './FeedbackNotice';
import './PrivateSyncSettings.css';

type Session = { email: string | null; companion: string };
type Initial = Awaited<ReturnType<typeof createVault>>;
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
      invite_required: '请输入有效的邀请码',
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

export function PrivateSyncSettings({ desktop, email, accountChanged, record, restored }: {
  desktop: boolean;
  email?: string;
  accountChanged?: (email: string | null) => void;
  record?: RecordDetail | null;
  restored?: (id: string) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [register, setRegister] = useState(false);
  const [vault, setVault] = useState<Vault | null>();
  const [initial, setInitial] = useState<Initial | null>(null);
  const [kitConfirmed, setKitConfirmed] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [copies, setCopies] = useState<CopySummary[]>([]);
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [invitation, setInvitation] = useState<Invitation | null>(null), [qr, setQr] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [approve, setApprove] = useState<(() => void) | null>(null);
  const secret = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const pending = useRef<AbortController | null>(null);
  const initialRef = useRef<Initial | null>(null);
  function forget() {
    pending.current?.abort();
    pending.current = null;
    secret.current?.fill(0);
    secret.current = null;
    initialRef.current?.root.fill(0);
    initialRef.current = null;
  }
  async function readVault(signal: AbortSignal) {
    const { vault } = await api<{ vault: Vault | null }>('/private-sync/vault', 'GET', undefined, signal);
    signal.throwIfAborted();
    setVault(vault);
  }
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const account = desktop ? await api<Session>('/private-sync/session', 'GET', undefined, controller.signal) : null;
      controller.signal.throwIfAborted();
      if (account) { setSession(account); accountChanged?.(account.email); }
      if (account?.email || !desktop) await readVault(controller.signal);
      setError('');
      setReady(true);
    }
    void load().catch(failure => { if (!controller.signal.aborted) { setError(syncError(failure)); setReady(true); } });
    return () => { controller.abort(); forget(); };
  }, [desktop, accountChanged]);

  function run(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setError(''); setNotice('');
    void action(controller.signal).catch(failure => {
      if (!controller.signal.aborted) setError(syncError(failure));
    }).finally(() => {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    });
  }

  async function update(localVault: Vault, key: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    const result = await syncMeetings(localVault, key, signal);
    signal.throwIfAborted();
    const next = await meetingCopies(localVault, key);
    signal.throwIfAborted();
    setCopies(next);
    setNotice(result.pending ? '仍有会议待传，可继续同步' : '同步完成');
  }

  async function enter(localVault: Vault, key: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    if (signal.aborted) { key.fill(0); return; }
    secret.current?.fill(0);
    secret.current = key;
    setUnlocked(true);
    setVault(localVault);
    setPairCode('');
    const local = await meetingCopies(localVault, key);
    signal.throwIfAborted();
    setCopies(local);
    await update(localVault, key, signal);
  }

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    run(async signal => {
      const user = await api<Session>('/private-sync/session', 'POST', { ...body, register }, signal);
      signal.throwIfAborted();
      setRegister(false);
      form.reset(); setSession(user); accountChanged?.(user.email); setVault(undefined);
      await readVault(signal);
    });
  }

  function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const code = String(new FormData(form).get('kit'));
    form.reset();
    if (vault) run(async signal => enter(vault, await recoverVault(vault, code), signal));
  }

  function lock() {
    forget();
    setUnlocked(false); setInitial(null); setInvitation(null); setApprove(null); setCopies([]); setQr(''); setPairCode(''); setBusy(false);
    setNotice('这台设备已锁定同步');
  }

  async function beginSetup(signal: AbortSignal) {
    const draft = await createVault();
    if (signal.aborted) { draft.root.fill(0); return; }
    initialRef.current = draft;
    setInitial(draft);
    setKitConfirmed(false);
  }

  function enroll() {
    if (!initial || !kitConfirmed) return;
    run(async signal => {
      await api('/private-sync/vault', 'PUT', initial.vault, signal);
      const key = initial.root;
      initialRef.current = null;
      setInitial(null);
      await enter(initial.vault, key, signal);
    });
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
      await enter(vault, await joinInvite(vault, pairCode, relay, signal), signal);
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
  if (desktop && !session?.email) return <section className="settings-section sync-settings" aria-label="聆记账号">
    <div className="sync-intro"><h2>{register ? '注册聆记账号' : '登录聆记账号'}</h2><p className="muted">使用同一个账号，在设备间同步选中的会议。</p></div>
    <form onSubmit={signIn} className="sync-form">
      <label>邮箱<input type="email" name="email" autoComplete="username" required/></label>
      <label>密码<input key={register ? 'new' : 'existing'} type="password" name="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={10} maxLength={128}/></label>
      {register && <label>邀请码<input name="inviteCode" autoComplete="off"/></label>}
      <div className="sync-actions">
        <Button variant="primary" type="submit" disabled={busy}>{busy ? '请稍候…' : register ? '注册并登录' : '登录'}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => { setRegister(!register); setError(''); setNotice(''); }}>{register ? '返回登录' : '注册账号'}</Button>
      </div>
    </form>
    {status}
  </section>;

  return <section className="settings-section sync-settings" aria-label="聆记账号">
    <div className="sync-account">
      <div className="sync-intro"><h2>聆记账号</h2><p>{desktop ? session?.email : email}</p></div>
      {desktop && session && <Button variant="ghost" disabled={busy} onClick={() => run(async signal => {
        await api('/private-sync/session', 'DELETE', undefined, signal);
        lock(); setSession({ ...session, email: null }); accountChanged?.(null); setVault(undefined); setNotice('已退出账号');
      })}>退出账号</Button>}
    </div>
    <h3>会议同步</h3>
    {vault === undefined && (error ? <Button disabled={busy} onClick={() => run(readVault)}>重新连接</Button> : <p role="status" className="muted">正在检查同步状态…</p>)}
    {vault === null && !initial && <div className="sync-stack">
      <p>可同步已完成会议的转录、纪要和手记。原音和截图保存在本机。</p>
      <Button variant="primary" disabled={busy} onClick={() => run(beginSetup)}>设置同步</Button>
    </div>}
    {initial && <div className="sync-stack">
      <p>请先下载恢复密钥。换设备或遗失旧设备时，可用它恢复会议。</p>
      <Button onClick={() => downloadKit(initial.kit)}>下载恢复密钥</Button>
      <label className="checkbox-label"><input type="checkbox" checked={kitConfirmed} onChange={event => setKitConfirmed(event.target.checked)}/>我已妥善保存</label>
      <Button variant="primary" disabled={busy || !kitConfirmed} onClick={enroll}>启用同步</Button>
    </div>}
    {vault && !unlocked && <div className="sync-stack">
      <p>请解锁这台设备，以访问该账号的同步会议。</p>
      {!desktop && <Button variant="primary" disabled={busy} onClick={() => run(async signal => enter(vault, await unlockPasskey(vault, signal), signal))}>用通行密钥解锁</Button>}
      <details className="sync-options">
        <summary>从旧设备配对</summary>
        <form className="sync-form" onSubmit={useInvitation}>
          <label>配对码<input value={pairCode} onChange={event => setPairCode(event.target.value)} required autoComplete="off" spellCheck={false}/></label>
          <label>或读取二维码图片<input type="file" accept="image/*" disabled={busy} onChange={event => { const file=event.currentTarget.files?.[0]; if(file)scan(file); event.currentTarget.value = ''; }}/></label>
          <Button type="submit" disabled={busy}>连接设备</Button>
        </form>
      </details>
      <details className="sync-options">
        <summary>使用恢复密钥</summary>
        <form className="sync-form" onSubmit={recover}>
          <label>恢复密钥<input type="password" name="kit" required autoComplete="off" spellCheck={false}/></label>
          <Button type="submit" disabled={busy}>恢复资料库</Button>
        </form>
      </details>
    </div>}
    {vault && unlocked && <div className="sync-stack">
      <div className="sync-actions">
        {record?.capture === 'completed' && <Button variant="primary" disabled={busy} onClick={() => run(async signal => {
          const key = secret.current!;
          await queueMeeting(vault, key, record);
          setNotice('会议已存入本机待传队列');
          await update(vault, key, signal);
        })}>同步当前会议</Button>}
        <Button variant={record?.capture === 'completed' ? undefined : 'primary'} disabled={busy} onClick={() => run(signal => update(vault, secret.current!, signal))}>获取云端更新</Button>
      </div>
      {copies.length > 0 && <ul className="sync-copies">
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
        <summary>设备与通行密钥</summary>
        <div className="sync-actions">
          {!invitation && <Button onClick={pair} disabled={busy}>配对新设备</Button>}
          {desktop ? <ExternalLink href={relay}>在浏览器管理通行密钥</ExternalLink> :
            <Button disabled={busy} onClick={() => run(async signal => { await enrollPasskey(vault, secret.current!, signal); setNotice('通行密钥已添加'); })}>添加通行密钥</Button>}
          <Button variant="ghost" onClick={lock}>锁定此设备</Button>
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
