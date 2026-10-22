import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CloudCheck, GearSix, Plug } from '@phosphor-icons/react';
import { api, messageOf } from '../api';
import { Button, Status } from './ui';
import { Select } from './Select';
import { Toast } from './Toast';
import { protocolForAddress } from '../provider-settings';
type Values = Record<string, string | boolean>;
const secretKeys = new Set(['OPENAI_REALTIME_API_KEY', 'DOUBAO_API_KEY', 'DOUBAO_AST_APP_KEY', 'DOUBAO_AST_ACCESS_KEY', 'ASR_API_KEY', 'DEEPGRAM_API_KEY', 'LLM_API_KEY', 'DOUBAO_TRANSLATION_API_KEY']);
export function ProviderSettings({ saved }: { saved: () => Promise<void> }) {
  const [values, setValues] = useState<Values | null>(null), [provider, setProvider] = useState('doubao');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({}), protocolTouched = useRef(false), pending = useRef(false);
  const dismiss = useCallback(() => { setNotice(''); setError(''); }, []);
  useEffect(() => {
    let active = true;
    api<{ values: Values }>('/settings/providers').then(({ values: config }) => {
      if (!active) return;
      setValues(config); setProvider(String(config.ASR_PROVIDER));
      setDraft(Object.fromEntries(Object.entries(config).map(([key, value]) => [key, typeof value === 'boolean' ? '' : String(value)])));
    }).catch(e => { if (active) setError(messageOf(e)); });
    return () => { active = false; };
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (pending.current) return;
    const submitted = Object.fromEntries(new FormData(e.currentTarget));
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const { values: config } = await api<{ values: Values }>('/settings/providers', 'PUT', submitted);
      setValues(config);
      // Editing can continue during the request. Only reconcile the submitted values
      // that have not changed since, and never replace a newer secret draft.
      setDraft(current => {
        const next = { ...current };
        for (const [key, value] of Object.entries(submitted)) {
          if (current[key] !== value) continue;
          next[key] = secretKeys.has(key) ? '' : String(config[key] ?? value);
        }
        return next;
      });
      setNotice('配置已保存，下一次处理自动生效。');
      try { await saved(); } catch { setNotice('配置已保存，服务状态刷新失败；可关闭设置后重试。'); }
    } catch (e) { setError(messageOf(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  const field = (key: string, label: string, secret = false, placeholder = '') => <label key={key}>{label}{secret && <Status>{values?.[key] ? '已设置' : '未设置'}</Status>}<input name={key} type={secret ? 'password' : 'text'} autoComplete="off" value={draft[key] || ''} onChange={event => {
    const value = event.target.value;
    setDraft(current => ({ ...current, [key]: value, ...(key === 'LLM_API_URL' && !protocolTouched.current ? { LLM_PROTOCOL: protocolForAddress(value) } : {}) }));
  }} placeholder={secret && values?.[key] ? '留空保留已保存密钥' : placeholder}/></label>;
  async function test(kind: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { const result = await api<{ message: string }>('/settings/providers/test', 'POST', { kind }); setNotice(result.message); }
    catch (e) { setError(messageOf(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="settings-section"><div className="section-title"><GearSix size={19}/><h3>模型与转录服务</h3></div><p className="fine-print">密钥仅保存在服务端。先保存，再测试连接；测试只使用静音或虚构文本。</p>
    <Toast message={error || notice} error={Boolean(error)} dismiss={dismiss}/>
    {values && <form onSubmit={submit} className="provider-form" aria-busy={busy}><label>转录服务<Select name="ASR_PROVIDER" label="转录服务" value={provider} onChange={setProvider} options={[{value:'doubao',label:'豆包语音识别 · API Key'},{value:'doubao-ast',label:'豆包 AST · 旧版双密钥'},{value:'deepgram',label:'Deepgram'},{value:'openai-compatible',label:'兼容转录接口'}]}/></label>
      {provider === 'doubao' && <>{field('DOUBAO_ASR_URL','WebSocket 地址')}{field('DOUBAO_ASR_RESOURCE_ID','语音资源 ID')}{field('DOUBAO_API_KEY','语音 API Key',true)}{field('DOUBAO_ASR_HOTWORDS','容易识别错误的词语',false,'例如：聆记，Redis Sentinel，产品名称')}{field('DOUBAO_ASR_CONTEXT','识别场景背景（可选）',false,'例如：港口调度周会，讨论集装箱车辆与路径规划')}<p className="fine-print">背景由你填写，仅在下一次中英二遍识别连接发送到转录服务，其他语言不附带背景；限 400 字，不自动收集历史会议。仅 bigmodel_async 支持。清空可关闭。</p><p className="fine-print">用逗号分隔正确写法，总长最多 100 字、每词 50 字。下一次识别连接使用这些术语辅助识别，不改写已有转录。建议只填写本次会用到的专有名词。</p></>}
      {provider === 'doubao-ast' && <>{field('DOUBAO_AST_BASE_URL','AST WebSocket 地址')}{field('DOUBAO_AST_RESOURCE_ID','AST 资源 ID')}{field('DOUBAO_AST_APP_KEY','App Key',true)}{field('DOUBAO_AST_ACCESS_KEY','Access Key',true)}</>}
      {provider === 'deepgram' && field('DEEPGRAM_API_KEY','Deepgram API Key',true)}
      {provider === 'openai-compatible' && <>{field('ASR_API_URL','转录请求地址')}{field('ASR_MODEL','语音模型')}{field('ASR_API_KEY','转录 API Key',true)}</>}
      <div className="settings-subheading"><CloudCheck size={18}/><h4>纪要输入方式</h4></div><label>会议理解<Select name="MINUTES_MODE" label="会议理解" value={draft.MINUTES_MODE || 'asr-llm'} onChange={value => setDraft(current => ({...current,MINUTES_MODE:value}))} options={[{value:'asr-llm',label:'ASR＋LLM · 转录后整理'},{value:'openai-realtime',label:'OpenAI Realtime · 音频直接理解'}]}/></label>{draft.MINUTES_MODE === 'openai-realtime' && <>{field('OPENAI_REALTIME_URL','Realtime WebSocket 地址')}{field('OPENAI_REALTIME_MODEL','Realtime 模型')}{field('OPENAI_REALTIME_API_KEY','OpenAI Realtime API Key',true)}<p className="fine-print">启用会议自动纪要后，音频直接送入 Realtime；转录服务并行提供逐字稿和来源引用。既有会议须在整理设置中重新开启以授权发送音频。服务失败会明确提示，不会自动切换纪要模式。</p></>}<div className="settings-subheading"><CloudCheck size={18}/><h4>文字模型 · 原链路与独立分析</h4></div>
      <label>模型协议<Select label="模型协议" name="LLM_PROTOCOL" value={draft.LLM_PROTOCOL || 'responses'} onChange={value => { protocolTouched.current = true; setDraft(current => ({...current,LLM_PROTOCOL:value})); }} options={[{value:'responses',label:'Responses'},{value:'chat-completions',label:'Chat Completions'}]}/></label>{field('LLM_API_URL','模型服务地址（完整接口）')}<p className="fine-print">按填写的完整地址发起请求，不自动补全或替换路径。切换协议不会修改地址。</p>{field('LLM_MODEL','模型 / 接入点 ID',false,'填写已开通的 model ID 或 ep-…')}{field('LLM_API_KEY','方舟 / 兼容模型 API Key',true)}
      <div className="settings-subheading"><CloudCheck size={18}/><h4>豆包实时翻译</h4></div>{field('DOUBAO_TRANSLATION_MODEL','翻译模型 / 接入点 ID',false,'doubao-seed-translation-250915')}{field('DOUBAO_TRANSLATION_API_URL','翻译服务地址（可选）',false,'留空沿用上方完整模型服务地址')}{field('DOUBAO_TRANSLATION_API_KEY','翻译 API Key（可选）',true)}<p className="fine-print">使用豆包 Seed Translation 专用接口参数。留空沿用纪要服务连接；单独填写地址时，请同时填写翻译密钥。仅开启本场翻译后发送原文，不改变纪要模型。</p>
      <div className="actions"><Button aria-disabled={busy} type="submit" variant="primary">保存服务配置</Button><Button type="button" aria-disabled={busy} onClick={() => void test('asr')}><Plug size={16}/>测试转录</Button><Button type="button" aria-disabled={busy} onClick={() => void test('minutes')}>测试纪要</Button></div>
    </form>}
  </div>;
}
