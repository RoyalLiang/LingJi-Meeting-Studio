import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CloudCheck, GearSix, Plug } from '@phosphor-icons/react';
import { api, messageOf } from '../api';
import { Button, Status } from './ui';
import { Select } from './Select';
import { Toast } from './Toast';
import { protocolForAddress } from '../provider-settings';
type Values = Record<string, string | boolean>;
const secretKeys = new Set(['FUNASR_API_KEY', 'OPENAI_REALTIME_API_KEY', 'DOUBAO_API_KEY', 'ASR_API_KEY', 'DEEPGRAM_API_KEY', 'LLM_API_KEY', 'DOUBAO_TRANSLATION_API_KEY']);
export function ProviderSettings({ saved, actionsTarget, initialProvider = 'doubao', initialMinutesMode = 'asr-llm' }: { saved: () => Promise<void>; actionsTarget: HTMLElement | null; initialProvider?: string; initialMinutesMode?: string }) {
  const [values, setValues] = useState<Values | null>(null), [provider, setProvider] = useState(initialProvider);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({ MINUTES_MODE: initialMinutesMode }), protocolTouched = useRef(false), pending = useRef(false);
  const dismiss = useCallback(() => { setNotice(''); setError(''); }, []);
  useEffect(() => {
    let active = true;
    api<{ values: Values }>('/settings/providers').then(({ values: config }) => {
      if (!active) return;
      setValues(config); setProvider(String(config.ASR_PROVIDER));
      const effort = String(config.LLM_REASONING_EFFORT || 'auto');
      setDraft({ ...Object.fromEntries(Object.entries(config).map(([key, value]) => [key, typeof value === 'boolean' ? '' : String(value)])), LLM_REASONING_EFFORT: effort === 'default' ? 'auto' : effort === 'max' ? 'xhigh' : effort });
    }).catch(e => { if (active) setError(messageOf(e)); });
    return () => { active = false; };
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!values || pending.current) return;
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
  const field = (key: string, label: string, secret = false, placeholder = '') => <label key={key}><span className="settings-field-label" title={label}><span>{label}</span>{secret && <Status>{values?.[key] ? '已设置' : '未设置'}</Status>}</span><input name={key} type={secret ? 'password' : 'text'} autoComplete="off" disabled={!values} value={draft[key] || ''} onChange={event => {
    const value = event.target.value;
    setDraft(current => ({ ...current, [key]: value, ...(key === 'LLM_API_URL' && !protocolTouched.current ? { LLM_PROTOCOL: protocolForAddress(value) } : {}) }));
  }} placeholder={secret && values?.[key] ? '留空保留已保存密钥' : placeholder}/></label>;
  async function test(kind: string) {
    if (!values || pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { const result = await api<{ message: string }>('/settings/providers/test', 'POST', { kind }); setNotice(result.message); }
    catch (e) { setError(messageOf(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  const nativeMeeting = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && /Mac|Windows/.test(navigator.userAgent);
  const audioOnly = draft.MINUTES_MODE === 'doubao-audio-only';
  return <div className="settings-section">
    <Toast message={error || notice} error={Boolean(error)} dismiss={dismiss}/>
    <form id="provider-settings" onSubmit={submit} className="provider-form" aria-busy={busy || !values}>
      <div className="settings-heading-row"><div className="section-title"><GearSix size={19}/><h3>模型与转录服务</h3></div><Select label="转录服务" name="ASR_PROVIDER" disabled={!values} value={provider} onChange={setProvider} options={[...(values?.LOCAL_ASR_AVAILABLE || provider === 'sensevoice-local' ? [{value:'sensevoice-local',label:values?.LOCAL_ASR_AVAILABLE ? '本地转录 · SenseVoice（已内置）' : '本地转录 · SenseVoice（未安装）'}] : []),{value:'funasr',label:'FunASR · 外部服务（高级）'},{value:'doubao',label:'豆包语音识别 · API Key'},{value:'deepgram',label:'Deepgram'},{value:'openai-compatible',label:'兼容转录接口'}]}/></div>
      {!values && <p className="settings-mode-note" role="status">正在读取服务配置…</p>}
      {!audioOnly && <div className="settings-dependent-fields">
        {provider === 'doubao' && <>{field('DOUBAO_ASR_URL','WebSocket 地址')}{field('DOUBAO_ASR_RESOURCE_ID','语音资源 ID')}{field('DOUBAO_API_KEY','语音 API Key',true)}{field('DOUBAO_ASR_HOTWORDS','容易识别错误的词语',false,'例如：聆记，Redis Sentinel，产品名称')}{field('DOUBAO_ASR_CONTEXT','识别场景背景（可选）',false,'例如：港口调度周会，讨论集装箱车辆与路径规划')}</>}
        {provider === 'sensevoice-local' && values && !values.LOCAL_ASR_AVAILABLE && <p role="status">本地模型未安装，请选择其他转录服务。</p>}
        {provider === 'funasr' && <>{field('FUNASR_API_URL','FunASR 转录地址',false,'http://127.0.0.1:18586/v1/audio/transcriptions')}{field('FUNASR_MODEL','识别模型',false,'sensevoice')}{field('FUNASR_API_KEY','服务密钥（可选）',true)}</>}
        {provider === 'deepgram' && field('DEEPGRAM_API_KEY','Deepgram API Key',true)}
        {provider === 'openai-compatible' && <>{field('ASR_API_URL','转录请求地址')}{field('ASR_MODEL','语音模型')}{field('ASR_API_KEY','转录 API Key',true)}</>}
      </div>}
      <div className="settings-heading-row"><div className="settings-subheading"><CloudCheck size={18}/><h4>AI纪要</h4></div><Select label="纪要输入方式" name="MINUTES_MODE" disabled={!values} value={draft.MINUTES_MODE || 'asr-llm'} onChange={value => setDraft(current => ({...current,MINUTES_MODE:value}))} options={[{value:'asr-llm',label:'ASR＋LLM'},{value:'openai-realtime',label:'OpenAI Realtime'},{value:'doubao-audio',label:'豆包音频'},{value:'doubao-audio-only',label:'仅豆包音频模型'}]}/></div>
      <div className="settings-dependent-fields">
        {draft.MINUTES_MODE === 'openai-realtime' && <><h4 className="settings-model-title">实时音频模型</h4>{field('OPENAI_REALTIME_URL','Realtime WebSocket 地址')}{field('OPENAI_REALTIME_MODEL','Realtime 模型')}{field('OPENAI_REALTIME_API_KEY','OpenAI Realtime API Key',true)}</>}
        <h4 className="settings-model-title">{draft.MINUTES_MODE === 'openai-realtime' ? '文字分析模型' : '纪要模型'}</h4>
        <label>模型协议<Select label="模型协议" name="LLM_PROTOCOL" disabled={!values} value={draft.LLM_PROTOCOL || 'responses'} onChange={value => { protocolTouched.current = true; setDraft(current => ({...current,LLM_PROTOCOL:value})); }} options={[{value:'responses',label:'Responses'},{value:'chat-completions',label:'Chat Completions'}]}/></label>
        {field('LLM_API_URL','服务地址',false,'https://服务域名/v1 或完整接口地址')}{field('LLM_MODEL','模型 / 接入点 ID',false,'填写已开通的 model ID 或 ep-…')}
        <label>推理强度<Select label="推理强度" name="LLM_REASONING_EFFORT" disabled={!values} value={draft.LLM_REASONING_EFFORT || 'auto'} onChange={value=>setDraft(current=>({...current,LLM_REASONING_EFFORT:value}))} options={[{value:'auto',label:'自动'},{value:'low',label:'低'},{value:'medium',label:'中'},{value:'high',label:'高'},{value:'xhigh',label:'更高'}]}/></label>{field('LLM_API_KEY','模型Key',true)}
      </div>
      <div className="settings-heading-row"><div className="settings-subheading"><CloudCheck size={18}/><h4>翻译服务</h4></div><Select label="翻译模型" name="TRANSLATION_PROVIDER" disabled={!values} value={draft.TRANSLATION_PROVIDER || 'auto'} onChange={value => setDraft(current => ({...current,TRANSLATION_PROVIDER:value}))} options={[{value:'auto',label:'自动选择'},{value:'text-model',label:'当前文字模型'},{value:'doubao-seed',label:'豆包 Seed 专用翻译'}]}/></div>
      {draft.TRANSLATION_PROVIDER === 'text-model' ? <p className="settings-mode-note">翻译使用上方文字模型的连接配置。</p> : <div className="settings-dependent-fields"><h4 className="settings-model-title">专用翻译模型</h4>{field('DOUBAO_TRANSLATION_MODEL','翻译模型 / 接入点 ID',false,'doubao-seed-translation-250915')}{field('DOUBAO_TRANSLATION_API_URL','翻译服务地址（可选）',false,'留空沿用上方完整模型服务地址')}{field('DOUBAO_TRANSLATION_API_KEY','翻译 API Key（可选）',true)}</div>}
      <div className="settings-heading-row"><div className="settings-subheading"><CloudCheck size={18}/><h4>学习与评审</h4><Status>{draft.LEARNING_SSH_HOST && draft.LEARNING_REMOTE_BASE ? '已填写' : '未配置'}</Status></div></div>
      <div className="settings-dependent-fields">{field('LEARNING_SSH_HOST','SSH 主机',false,'填写已配置的 SSH 主机别名或域名')}{field('LEARNING_REMOTE_BASE','远端服务目录',false,'填写服务所在的绝对目录')}</div>
      <div className="settings-heading-row"><div className="settings-subheading"><CloudCheck size={18}/><h4>后台会议联动</h4></div></div>
      <input type="hidden" name="AUTO_MEETING_ENABLED" value={draft.AUTO_MEETING_ENABLED || 'false'}/><input type="hidden" name="AUTO_MEETING_BROWSER" value={draft.AUTO_MEETING_BROWSER || 'true'}/><input type="hidden" name="AUTO_MEETING_FEISHU" value={draft.AUTO_MEETING_FEISHU || 'true'}/>
      <label className="checkbox-label"><input type="checkbox" checked={draft.AUTO_MEETING_ENABLED==='true'} disabled={!values || !nativeMeeting} onChange={event=>setDraft(current=>({...current,AUTO_MEETING_ENABLED:String(event.target.checked)}))}/>允许音频调用触发自动录音</label>
      <div className="settings-dependent-fields"><label className="checkbox-label"><input type="checkbox" checked={draft.AUTO_MEETING_BROWSER!=='false'} disabled={!values || !nativeMeeting || draft.AUTO_MEETING_ENABLED!=='true'} onChange={event=>setDraft(current=>({...current,AUTO_MEETING_BROWSER:String(event.target.checked)}))}/>浏览器 · Chrome / Edge</label><label className="checkbox-label"><input type="checkbox" checked={draft.AUTO_MEETING_FEISHU!=='false'} disabled={!values || !nativeMeeting || draft.AUTO_MEETING_ENABLED!=='true'} onChange={event=>setDraft(current=>({...current,AUTO_MEETING_FEISHU:String(event.target.checked)}))}/>飞书</label></div>
      <p className="settings-mode-note">{nativeMeeting ? '持续调用扬声器或麦克风 10 秒后开始；全部调用停止 30 秒后结束，只管理自动创建的记录。录制麦克风与系统音频，沿用当前转录和纪要设置。浏览器视频、音乐也可能触发；关闭联动不会结束当前录音。Windows 仅监听共享音频会话，独占音频不在首版覆盖范围。' : '支持 macOS / Windows 桌面的 Chrome / Edge 与飞书；Windows 仅覆盖共享音频会话，Linux 暂不启用。'}</p>
      {actionsTarget && createPortal(<div className="actions"><Button type="button" disabled={!values || audioOnly} aria-disabled={busy || !values || audioOnly} onClick={() => void test('asr')}><Plug size={16}/>测试转录</Button><Button type="button" disabled={!values} aria-disabled={busy || !values} onClick={() => void test('minutes')}>测试纪要</Button><Button disabled={!values} aria-disabled={busy || !values} type="submit" form="provider-settings" variant="primary">保存配置</Button></div>, actionsTarget)}
    </form>
  </div>;
}
