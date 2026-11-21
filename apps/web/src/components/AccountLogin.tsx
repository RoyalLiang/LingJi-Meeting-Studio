import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CaretRight } from '@phosphor-icons/react';
import { api, ApiError, messageOf, setCsrf } from '../api';
import { Brand } from './Brand';
import { FeedbackNotice } from './FeedbackNotice';
import { Button, Status } from './ui';
import './MobileEntry.css';

export type AccountLogin = { email: string; material: Uint8Array<ArrayBuffer> };
export type AuthSession = { email?: string; csrf?: string };
export function Auth({ ready, accountLogin, mobile = false, prepare }: { ready: (session?: AuthSession) => Promise<boolean>; accountLogin: (login?: AccountLogin) => void; mobile?: boolean; prepare?: () => Promise<unknown> }) {
  const [register, setRegister] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [factorRequired, setFactorRequired] = useState(false);
  const [development, setDevelopment] = useState<{email:string;password:string|null}|null>(null);
  const submitting = useRef(false);
  useEffect(() => { if (!mobile) void api<{email:string;password:string|null}>('/development-account').then(setDevelopment).catch(() => {}); }, [mobile]);
  useEffect(() => {
    if (prepare) void prepare().catch(() => {});
    // Pre-warm OPAQUE WASM while user types credentials so clicking login does not stall.
    const timer = window.setTimeout(() => {
      void import('../sync/account').then(({ preloadAccountAuth }) => preloadAccountAuth()).catch(() => {});
    }, 120);
    return () => clearTimeout(timer);
  }, [prepare]);
  async function authenticate(path: string, body: { email: string; password: string; factor?: string }, developmentLogin = false) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const mode = developmentLogin ? { opaque: false } : await api<{ opaque: boolean }>('/auth/account');
      let session: AuthSession | undefined;
      if (mode.opaque && !legacy) {
        const { authenticateAccount } = await import('../sync/account');
        const { user, material } = await authenticateAccount({ ...body, register: path.endsWith('register') });
        accountLogin({ email: user.email, material });
        session = { email: user.email, csrf: user.csrf };
      } else {
        const response = await api<{ csrf: string; email?: string }>(path, 'POST', body);
        setCsrf(response.csrf);
        accountLogin();
        session = { email: response.email || body.email, csrf: response.csrf };
      }
      if (!await ready(session)) { accountLogin(); setError('会议空间暂未加载，请重试。'); }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'account_legacy') setLegacy(true);
      if (e instanceof ApiError && e.code === 'account_factor_required') setFactorRequired(true);
      setError(messageOf(e));
    }
    finally { submitting.current = false; setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    return authenticate(`/auth/${register ? 'register' : 'login'}`, { email: String(data.get('email')), password: String(data.get('password')), factor: String(data.get('factor') || '') });
  }
  const form = <form onSubmit={submit}>
    <label>{mobile ? '邮箱' : '用户名 / 邮箱'}
      <input name="email" type="email" autoComplete="username" required placeholder="name@example.com" onChange={() => {
        setFactorRequired(false);
        if (legacy) { setLegacy(false); setError(''); }
      }}/>
    </label>
    <label>密码
      <input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'}
        minLength={10} maxLength={128} required placeholder="至少 10 个字符"/>
    </label>
    {factorRequired && !register && <label>验证器代码或备用码
      <input name="factor" autoComplete="one-time-code" maxLength={24} required autoFocus spellCheck={false}/>
    </label>}
    {error && <FeedbackNotice key={error} message={error} error/>}
    <Button variant="primary" disabled={busy} type="submit">
      {busy ? '请稍候…' : register ? '注册并进入' : legacy ? '使用旧账号登录' : mobile ? '登录' : '进入会议空间'}
      {!mobile && <CaretRight size={18}/>}
    </Button>
  </form>;
  if (mobile) return <main className="phone-auth">
    <section className="phone-auth-card auth-card" aria-labelledby="phone-auth-heading">
      <Brand markOnly/>
      <h1 id="phone-auth-heading">{register ? '创建聆记账号' : '登录聆记'}</h1>
      {form}
      <Button variant="ghost" disabled={busy} onClick={() => { setRegister(!register); setLegacy(false); setFactorRequired(false); setError(''); }}>{register ? '已有账号，登录' : '创建账号'}</Button>
    </section>
  </main>;
  return <main className="auth-page"><section className="auth-story"><Brand/>
    <div><p className="kicker">让注意力，回到对话</p><h1>好好听。<br/>值得记住的，<br/><em>交给聆记。</em></h1><p>实时转录，梳理共识。<br/>从一句话，追溯每一个决定。</p></div><span className="auth-foot">浏览器打开即用 · 数据按账户隔离</span></section>
    <section className="auth-card glass"><p className="kicker">你的会议空间</p><h2>{register ? '创建账户' : '欢迎回来'}</h2><p className="muted">{register ? '记录、回看与整理，从这里开始。' : '继续上次的讨论，或开始一场新对话。'}</p>
      {form}
      <Button variant="ghost" disabled={busy} onClick={() => { setRegister(!register); setLegacy(false); setError(''); }}>{register ? '已有账户？登录' : '还没有账户？创建一个'}</Button>{development && <div className="development-account"><Status>本地开发账户</Status><p>用户名 <b>{development.email}</b></p><p>密码 <code>{development.password || '使用本机自定义密码'}</code></p>{development.password && <Button disabled={busy} onClick={() => authenticate('/auth/login', { email: development.email, password: development.password! }, true)}>使用开发账户进入</Button>}</div>}<p className="fine-print">录制前请告知参会者并取得适用的许可。登录不会自动启用麦克风或屏幕共享。</p>
    </section></main>;
}
