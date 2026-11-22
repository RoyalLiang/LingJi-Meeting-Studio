import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Desktop, DeviceMobile, Globe } from '@phosphor-icons/react';
import { api, ApiError, getAuthGeneration, messageOf } from '../api';
import { Button } from './ui';

type Device = { id: string; name: string; issuedAt: number; current: boolean };
type DeviceList = { current: boolean; items: Device[] };
type FactorStatus = { available: boolean; enabled: boolean; recent: boolean };
type BillingPlan = { id: string; name: string; storageGb: number; monthly: number; yearly: number };
type Catalog = { plans: BillingPlan[] };
type Period = 'monthly' | 'yearly';

let deviceRequest: { generation: number; until: number; promise: Promise<DeviceList> } | undefined;
export function loadMobileDevices() {
  const generation = getAuthGeneration();
  if (deviceRequest?.generation === generation && deviceRequest.until > Date.now()) return deviceRequest.promise;
  const promise = api<DeviceList>('/private-sync/devices').catch(error => {
    if (deviceRequest?.promise === promise) deviceRequest = undefined;
    throw error;
  });
  deviceRequest = { generation, until: Date.now() + 30_000, promise };
  return promise;
}

export function MobileAccountDevices() {
  const [devices, setDevices] = useState<DeviceList>();
  const [error, setError] = useState('');
  const [revoke, setRevoke] = useState<Device>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void loadMobileDevices().then(value => { if (active) setDevices(value); })
      .catch(error => { if (active) setError(messageOf(error)); });
    return () => { active = false; };
  }, []);
  async function remove() {
    if (!revoke || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/private-sync/devices', 'DELETE', { id: revoke.id });
      deviceRequest = undefined;
      setDevices(items => items && { ...items, items: items.items.filter(item => item.id !== revoke.id) });
      setRevoke(undefined);
    } catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(false); }
  }
  return <>
    {error && <p role="alert">{error}</p>}
    {!devices && !error && <p role="status">正在加载设备…</p>}
    {devices && !devices.current && <p className="mobile-sheet-note">重新登录可登记当前设备。</p>}
    <ul className="mobile-record-list mobile-device-list">{devices?.items.map(device => {
      const name = device.current && /LingJi-Android/.test(navigator.userAgent) ? '聆记 Android' : device.name;
      const Icon = /Android|iPhone|iPad/.test(name) ? DeviceMobile : name === '浏览器' ? Globe : Desktop;
      return <li className="mobile-device" key={device.id}>
        <Icon size={20} aria-hidden="true"/>
        <div><strong>{name}</strong><small>{new Date(device.issuedAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}</small></div>
        {device.current ? <small className="mobile-device-current">当前设备</small> :
          <Button variant="ghost" disabled={!devices.current} aria-label={'移除 ' + name} onClick={() => setRevoke(device)}>移除</Button>}
      </li>;
    })}</ul>
    {revoke && <div className="mobile-card">
      <p>{revoke.name} 将退出同步账号。</p>
      <div className="mobile-sheet-actions">
        <Button variant="ghost" disabled={busy} onClick={() => setRevoke(undefined)}>取消</Button>
        <Button disabled={busy} onClick={() => void remove()}>确认移除</Button>
      </div>
    </div>}
  </>;
}

let factorRequest: { generation: number; until: number; promise: Promise<FactorStatus> } | undefined;

export function loadMobileFactor(force = false) {
  const generation = getAuthGeneration();
  if (!force && factorRequest?.generation === generation && factorRequest.until > Date.now()) return factorRequest.promise;
  const promise = api<FactorStatus>('/private-sync/factor').catch(error => {
    if (factorRequest?.promise === promise) factorRequest = undefined;
    throw error;
  });
  factorRequest = { generation, until: Date.now() + 15_000, promise };
  return promise;
}

export function MobileAccountFactor({ email, legacy, onBusy, done }: {
  email: string; legacy: boolean; onBusy: (busy: boolean) => void; done: () => void;
}) {
  const [status, setStatus] = useState<FactorStatus>();
  const [setup, setSetup] = useState('');
  const [image, setImage] = useState('');
  const [disable, setDisable] = useState(false);
  const [recovery, setRecovery] = useState<string[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(false);

  useEffect(() => {
    let active = true;
    void loadMobileFactor().then(value => { if (active) setStatus(value); })
      .catch(failure => { if (active) setError(messageOf(failure)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!setup) return;
    let active = true;
    void import('qrcode').then(({ toDataURL }) => toDataURL(setup, { width: 152, margin: 2 }))
      .then(value => { if (active) setImage(value); }).catch(() => {});
    return () => { active = false; };
  }, [setup]);

  async function act(action: () => Promise<void>) {
    if (request.current) return;
    request.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'account_recent_login_required') {
        setStatus(current => current && { ...current, recent: false });
        setSetup('');
        setDisable(false);
      }
      setError(messageOf(failure));
    } finally {
      request.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  function restart() {
    setSetup('');
    setImage('');
    setDisable(false);
    setError('');
  }

  function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    void act(async () => {
      const { authenticateAccount } = await import('../sync/account');
      const { material } = await authenticateAccount({
        email, password: String(fields.get('password')),
        factor: String(fields.get('factor') || '') || undefined, desktop: false,
      });
      material.fill(0);
      deviceRequest = undefined;
      form.reset();
      setStatus({ available: true, enabled: Boolean(status?.enabled), recent: true });
      void loadMobileFactor(true).then(setStatus).catch(() => {});
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') || '').trim();
    void act(async () => {
      if (disable) {
        await api('/private-sync/factor', 'DELETE', { code });
        setDisable(false);
      } else {
        const result = await api<{ recovery: string[] }>('/private-sync/factor', 'POST', { code });
        setRecovery(result.recovery);
        setSetup('');
        setImage('');
      }
      factorRequest = undefined;
      deviceRequest = undefined;
      setStatus({ available: true, enabled: !disable, recent: true });
    });
  }

  return <div className="mobile-factor">
    {error && <p className="mobile-sheet-note mobile-form-error" role="alert">{error}</p>}
    {!status && (error
      ? <Button variant="secondary" disabled={busy} onClick={() => void act(async () => setStatus(await loadMobileFactor(true)))}>重试</Button>
      : <p className="mobile-sheet-note" role="status">正在检查验证状态…</p>)}
    {status && !setup && !disable && !recovery && <>
      <p className="mobile-factor-state" data-enabled={status.enabled}>{status.enabled ? '已开启' : '未开启'}</p>
      <p className="mobile-sheet-note">{status.enabled ? '登录需要验证器代码或备用码。' : '为账号登录增加一层验证。'}</p>
      {!status.available && <p className="mobile-sheet-note">当前同步服务未开放双重验证。</p>}
      {status.available && legacy && <p className="mobile-sheet-note">升级账号后即可设置验证器。</p>}
      {status.available && !legacy && (status.recent
        ? <Button variant={status.enabled ? 'secondary' : 'primary'} disabled={busy} onClick={() => {
          if (status.enabled) { setError(''); setDisable(true); }
          else void act(async () => setSetup((await api<{ uri: string }>('/private-sync/factor/enroll', 'POST', {})).uri));
        }}>{status.enabled ? '关闭双重验证' : busy ? '正在准备…' : '设置验证器'}</Button>
        : <form className="mobile-security-form" onSubmit={verify}>
          <p className="mobile-sheet-note">修改设置前，请验证身份。</p>
          <label>当前密码<input name="password" type="password" autoComplete="current-password" minLength={10} maxLength={128} required/></label>
          {status.enabled && <label>验证器代码或备用码<input name="factor" autoComplete="one-time-code" maxLength={24} required spellCheck={false}/></label>}
          <Button type="submit" variant="primary" disabled={busy}>{busy ? '正在验证…' : '验证身份'}</Button>
        </form>)}
    </>}
    {setup && <div className="mobile-factor-setup">
      <p className="mobile-sheet-note">扫描二维码或在验证器中输入设置密钥。开启后，其他设备需要重新登录。</p>
      {image && <img src={image} alt="验证器登记二维码" width={152} height={152}/>}
      <details><summary>查看设置密钥</summary><code>{new URL(setup).searchParams.get('secret')}</code></details>
    </div>}
    {(setup || disable) && <form className="mobile-security-form" onSubmit={submit}>
      {disable && <p className="mobile-sheet-note">请使用验证器新生成的代码。关闭后，其他设备需要重新登录。</p>}
      <label>{disable ? '验证器代码或备用码' : '六位验证码'}<input name="code" required maxLength={disable ? 24 : 6}
        pattern={disable ? undefined : '[0-9]{6}'} inputMode={disable ? 'text' : 'numeric'} autoComplete="one-time-code" spellCheck={false}/></label>
      <div className="mobile-sheet-actions mobile-sheet-paired">
        <Button variant="secondary" disabled={busy} onClick={restart}>返回</Button>
        <Button type="submit" variant={disable ? 'danger' : 'primary'} disabled={busy}>{disable ? '确认关闭' : '确认开启'}</Button>
      </div>
    </form>}
    {recovery && <>
      <p className="mobile-factor-state" data-enabled="true">已开启</p>
      <p className="mobile-sheet-note">请保存备用码。验证器丢失时，每个备用码可登录一次。</p>
      <ul className="mobile-recovery-codes">{recovery.map(code => <li key={code}><code>{code}</code></li>)}</ul>
      <Button variant="primary" onClick={done}>已保存备用码</Button>
    </>}
  </div>;
}

export function MobileBillingPlans() {
  const [catalog, setCatalog] = useState<Catalog>();
  const [period, setPeriod] = useState<Period>('monthly');
  const [quote, setQuote] = useState<{ planId: string; amount: number }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<Catalog>('/private-sync/billing/plans', 'GET', undefined, controller.signal)
      .then(setCatalog).catch(error => { if (!controller.signal.aborted) setError(messageOf(error)); });
    return () => controller.abort();
  }, []);
  const price = (amount: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(amount / 100);
  async function select(planId: string) {
    setBusy(true);
    setError('');
    try { setQuote(await api('/private-sync/billing/quote', 'POST', { planId, period })); }
    catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(false); }
  }
  return <>
    <p className="mobile-sheet-note">测试报价，暂未开放购买。</p>
    {error && <p role="alert">{error}</p>}
    {!catalog && !error && <p role="status">正在加载套餐…</p>}
    {catalog && <>
      <div className="mobile-detail-tabs mobile-billing-period">
        {(['monthly', 'yearly'] as const).map(item => <button type="button" key={item} disabled={busy}
          aria-pressed={period === item} onClick={() => { setPeriod(item); setQuote(undefined); }}>{item === 'monthly' ? '按月' : '按年'}</button>)}
      </div>
      <ul className="mobile-record-list">{catalog.plans.map(plan => <li key={plan.id} className="mobile-card mobile-device">
        <div><strong>{plan.name}</strong><small>{price(plan[period])}{plan.storageGb ? (period === 'monthly' ? ' / 月' : ' / 年') : ''}</small></div>
        {!!plan.storageGb && <Button variant="ghost" disabled={busy} onClick={() => void select(plan.id)}>查看报价</Button>}
      </li>)}</ul>
    </>}
    {quote && <p className="mobile-save-status" role="status">{catalog?.plans.find(plan => plan.id === quote.planId)?.name} · {price(quote.amount)}</p>}
  </>;
}
