import { useEffect, useState, type FormEvent } from 'react';
import { api, getAuthGeneration, messageOf } from '../api';
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
    <ul className="mobile-record-list">{devices?.items.map(device => <li className="mobile-card mobile-device" key={device.id}>
      <div><strong>{device.current && /LingJi-Android/.test(navigator.userAgent) ? '聆记 Android' : device.name}</strong>
        <small>{new Date(device.issuedAt).toLocaleString('zh-CN')}</small></div>
      {device.current ? <small>当前设备</small> : <Button variant="ghost" disabled={!devices.current || busy}
        aria-label={'移除 ' + device.name} onClick={() => setRevoke(device)}>移除</Button>}
    </li>)}</ul>
    {revoke && <div className="mobile-card">
      <p>{revoke.name} 将退出同步账号。</p>
      <div className="mobile-sheet-actions">
        <Button variant="ghost" disabled={busy} onClick={() => setRevoke(undefined)}>取消</Button>
        <Button disabled={busy} onClick={() => void remove()}>确认移除</Button>
      </div>
    </div>}
  </>;
}

export function MobileAccountFactor() {
  const [status, setStatus] = useState<FactorStatus>();
  const [setup, setSetup] = useState<{ uri: string; image: string }>();
  const [recovery, setRecovery] = useState<string[]>();
  const [disable, setDisable] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<FactorStatus>('/private-sync/factor', 'GET', undefined, controller.signal)
      .then(setStatus).catch(error => { if (!controller.signal.aborted) setError(messageOf(error)); });
    return () => controller.abort();
  }, []);
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') || '');
    void act(async () => {
      if (disable) {
        await api('/private-sync/factor', 'DELETE', { code });
        setDisable(false);
        setStatus({ available: true, enabled: false, recent: true });
      } else {
        const result = await api<{ recovery: string[] }>('/private-sync/factor', 'POST', { code });
        setRecovery(result.recovery);
        setSetup(undefined);
        setStatus({ available: true, enabled: true, recent: true });
      }
    });
  }
  return <>
    {error && <p role="alert">{error}</p>}
    {!status && !error && <p role="status">正在加载双重验证…</p>}
    {status && !recovery && <p>{status.enabled ? '已开启' : '未开启'}</p>}
    {status && !status.available && <p className="mobile-sheet-note">暂未开放设置。</p>}
    {status?.available && !status.recent && <p className="mobile-sheet-note">重新登录后可修改双重验证。</p>}
    {status?.available && status.recent && !setup && !disable && !recovery && <Button disabled={busy} onClick={() => {
      if (status.enabled) setDisable(true);
      else void act(async () => {
        const { uri } = await api<{ uri: string }>('/private-sync/factor/enroll', 'POST', {});
        const { toDataURL } = await import('qrcode');
        setSetup({ uri, image: await toDataURL(uri, { width: 180, margin: 2 }) });
      });
    }}>{status.enabled ? '关闭双重验证' : '设置验证器'}</Button>}
    {setup && <div className="mobile-factor-setup">
      <p>用验证器扫描二维码，然后填写六位代码。开启后其他设备需要重新登录。</p>
      <img src={setup.image} alt="验证器登记二维码" width={180} height={180}/>
      <details><summary>在这台手机设置</summary><code>{new URL(setup.uri).searchParams.get('secret')}</code></details>
    </div>}
    {(setup || disable) && <form className="mobile-security-form" onSubmit={submit}>
      <label>验证器代码{disable ? '或备用码' : ''}<input name="code" required maxLength={disable ? 24 : 6}
        autoComplete="one-time-code" inputMode={disable ? 'text' : 'numeric'} spellCheck={false}/></label>
      <Button type="submit" disabled={busy}>{disable ? '确认关闭' : '确认开启'}</Button>
    </form>}
    {recovery && <>
      <p>请保存备用码。每个可用一次，此处仅显示一次。</p>
      <ul className="mobile-recovery-codes">{recovery.map(code => <li key={code}><code>{code}</code></li>)}</ul>
    </>}
  </>;
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
