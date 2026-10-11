import { useEffect, useState, type FormEvent } from 'react';
import { CloudCheck, GearSix, Plug } from '@phosphor-icons/react';
import { api, messageOf } from '../api';
import { Button, Status } from './ui';
import { Select } from './Select';
type Values = Record<string, string | boolean>;
export function ProviderSettings({ saved }: { saved: () => Promise<void> }) {
  const [values, setValues] = useState<Values | null>(null), [provider, setProvider] = useState('doubao'), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { api<{values: Values}>('/settings/providers').then(d => { setValues(d.values); setProvider(String(d.values.ASR_PROVIDER)); }).catch(e => setError(messageOf(e))); }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const d = await api<{values: Values}>('/settings/providers', 'PUT', Object.fromEntries(new FormData(e.currentTarget)));
      setValues(d.values); await saved(); setNotice('配置已保存，下一次处理自动生效。');
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  const field = (key: string, label: string, secret = false, placeholder = '') => <label key={`${provider}:${key}`}>{label}{secret && <Status>{values?.[key] ? '已设置' : '未设置'}</Status>}<input name={key} type={secret ? 'password' : 'text'} autoComplete="off" defaultValue={secret ? '' : String(values?.[key] || '')} placeholder={secret && values?.[key] ? '留空保留已保存密钥' : placeholder}/></label>;
  async function test(kind: string) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await api<{message: string}>('/settings/providers/test', 'POST', {kind}); setNotice(result.message); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <div className="settings-section"><div className="section-title"><GearSix size={19}/><h3>模型与转录服务</h3></div><p className="fine-print">密钥仅保存在服务端。先保存，再测试连接；测试只使用静音或虚构文本。</p>
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {values && <form onSubmit={submit} className="provider-form"><label>转录服务<Select name="ASR_PROVIDER" label="转录服务" value={provider} onChange={setProvider} options={[{value:'doubao',label:'豆包语音识别 · API Key'},{value:'doubao-ast',label:'豆包 AST · 旧版双密钥'},{value:'deepgram',label:'Deepgram'},{value:'openai-compatible',label:'兼容转录接口'}]}/></label>
      {provider === 'doubao' && <>{field('DOUBAO_ASR_URL','WebSocket 地址')}{field('DOUBAO_ASR_RESOURCE_ID','语音资源 ID')}{field('DOUBAO_API_KEY','语音 API Key',true)}</>}
      {provider === 'doubao-ast' && <>{field('DOUBAO_AST_BASE_URL','AST WebSocket 地址')}{field('DOUBAO_AST_RESOURCE_ID','AST 资源 ID')}{field('DOUBAO_AST_APP_KEY','App Key',true)}{field('DOUBAO_AST_ACCESS_KEY','Access Key',true)}</>}
      {provider === 'deepgram' && field('DEEPGRAM_API_KEY','Deepgram API Key',true)}
      {provider === 'openai-compatible' && <>{field('ASR_API_URL','转录请求地址')}{field('ASR_MODEL','语音模型')}{field('ASR_API_KEY','转录 API Key',true)}</>}
      <div className="settings-subheading"><CloudCheck size={18}/><h4>纪要、意图识别与翻译</h4></div>
      <label>模型协议<Select label="模型协议" name="LLM_PROTOCOL" defaultValue={String(values?.LLM_PROTOCOL || 'chat-completions')} options={[{value:'chat-completions',label:'Chat Completions · /chat/completions'},{value:'responses',label:'Responses · /responses'}]}/></label>{field('LLM_API_URL','模型服务地址（基础地址或完整接口）')}{field('LLM_MODEL','模型 / 接入点 ID',false,'填写已开通的 model ID 或 ep-…')}{field('LLM_API_KEY','方舟 / 兼容模型 API Key',true)}
      <div className="actions"><Button disabled={busy} type="submit" variant="primary">{busy ? '处理中…' : '保存服务配置'}</Button><Button disabled={busy} onClick={() => void test('asr')}><Plug size={16}/>测试转录</Button><Button disabled={busy} onClick={() => void test('minutes')}>测试纪要</Button></div>
    </form>}
  </div>;
}
