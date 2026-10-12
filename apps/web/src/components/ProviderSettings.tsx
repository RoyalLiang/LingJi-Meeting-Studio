import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CloudCheck, GearSix, Plug } from '@phosphor-icons/react';
import { api, messageOf } from '../api';
import { Button, Status } from './ui';
import { Select } from './Select';
import { Toast } from './Toast';
import { protocolForAddress } from '../provider-settings';
type Values = Record<string, string | boolean>;
export function ProviderSettings({ saved }: { saved: () => Promise<void> }) {
  const [values, setValues] = useState<Values | null>(null), [provider, setProvider] = useState('doubao'), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string,string>>({}), protocolTouched = useRef(false);
  const dismiss = useCallback(() => { setNotice(''); setError(''); }, []);
  const applyConfig = useCallback((config: Values) => {
    setValues(config); setProvider(String(config.ASR_PROVIDER));
    setDraft(Object.fromEntries(Object.entries(config).map(([key,value]) => [key, typeof value === 'boolean' ? '' : String(value)])));
    protocolTouched.current = false;
  }, []);
  useEffect(() => { api<{values: Values}>('/settings/providers').then(d => applyConfig(d.values)).catch(e => setError(messageOf(e))); }, [applyConfig]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const d = await api<{values: Values}>('/settings/providers', 'PUT', Object.fromEntries(new FormData(e.currentTarget)));
      applyConfig(d.values); setNotice('配置已保存，下一次处理自动生效。');
      try { await saved(); } catch { setNotice('配置已保存，服务状态刷新失败；可关闭设置后重试。'); }
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  const field = (key: string, label: string, secret = false, placeholder = '') => <label key={`${provider}:${key}`}>{label}{secret && <Status>{values?.[key] ? '已设置' : '未设置'}</Status>}<input name={key} type={secret ? 'password' : 'text'} autoComplete="off" disabled={busy} value={draft[key] || ''} onChange={event => { const value=event.target.value; setDraft(current => ({...current,[key]:value,...(key==='LLM_API_URL' && !protocolTouched.current ? {LLM_PROTOCOL:protocolForAddress(value)} : {})})); }} placeholder={secret && values?.[key] ? '留空保留已保存密钥' : placeholder}/></label>;
  async function test(kind: string) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await api<{message: string}>('/settings/providers/test', 'POST', {kind}); setNotice(result.message); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <div className="settings-section"><div className="section-title"><GearSix size={19}/><h3>模型与转录服务</h3></div><p className="fine-print">密钥仅保存在服务端。先保存，再测试连接；测试只使用静音或虚构文本。</p>
    {error && <p className="inline-error" role="alert">{error}</p>}<Toast message={error || notice} error={Boolean(error)} dismiss={dismiss}/>
    {values && <form onSubmit={submit} className="provider-form"><label>转录服务<Select name="ASR_PROVIDER" label="转录服务" value={provider} disabled={busy} onChange={setProvider} options={[{value:'doubao',label:'豆包语音识别 · API Key'},{value:'doubao-ast',label:'豆包 AST · 旧版双密钥'},{value:'deepgram',label:'Deepgram'},{value:'openai-compatible',label:'兼容转录接口'}]}/></label>
      {provider === 'doubao' && <>{field('DOUBAO_ASR_URL','WebSocket 地址')}{field('DOUBAO_ASR_RESOURCE_ID','语音资源 ID')}{field('DOUBAO_API_KEY','语音 API Key',true)}</>}
      {provider === 'doubao-ast' && <>{field('DOUBAO_AST_BASE_URL','AST WebSocket 地址')}{field('DOUBAO_AST_RESOURCE_ID','AST 资源 ID')}{field('DOUBAO_AST_APP_KEY','App Key',true)}{field('DOUBAO_AST_ACCESS_KEY','Access Key',true)}</>}
      {provider === 'deepgram' && field('DEEPGRAM_API_KEY','Deepgram API Key',true)}
      {provider === 'openai-compatible' && <>{field('ASR_API_URL','转录请求地址')}{field('ASR_MODEL','语音模型')}{field('ASR_API_KEY','转录 API Key',true)}</>}
      <div className="settings-subheading"><CloudCheck size={18}/><h4>纪要、意图识别与翻译</h4></div>
      <label>模型协议<Select label="模型协议" name="LLM_PROTOCOL" value={draft.LLM_PROTOCOL || 'responses'} disabled={busy} onChange={value => { protocolTouched.current=true; setDraft(current=>({...current,LLM_PROTOCOL:value})); }} options={[{value:'responses',label:'Responses · /responses'},{value:'chat-completions',label:'Chat Completions · /chat/completions'}]}/></label>{field('LLM_API_URL','模型服务地址（基础地址或完整接口）')}{field('LLM_MODEL','模型 / 接入点 ID',false,'填写已开通的 model ID 或 ep-…')}{field('LLM_API_KEY','方舟 / 兼容模型 API Key',true)}
      <div className="actions"><Button disabled={busy} type="submit" variant="primary">{busy ? '处理中…' : '保存服务配置'}</Button><Button disabled={busy} onClick={() => void test('asr')}><Plug size={16}/>测试转录</Button><Button disabled={busy} onClick={() => void test('minutes')}>测试纪要</Button></div>
    </form>}
  </div>;
}
