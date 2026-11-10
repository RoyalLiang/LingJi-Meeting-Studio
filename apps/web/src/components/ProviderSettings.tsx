import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CaretDown, CloudCheck, GearSix } from '@phosphor-icons/react';
import { api, messageOf } from '../api';
import { Button, Status } from './ui';
import { Select } from './Select';
import { Toast } from './Toast';
import { ModuleConnectionCheck } from './ModuleConnectionCheck';
import type { Bootstrap } from '../model';
import { protocolForAddress, modelRoleLabels, modelRoleValues, updateModelRole } from '../provider-settings';
type Values = Record<string, string | boolean>;
const secretKeys = new Set(['FUNASR_API_KEY', 'OPENAI_REALTIME_API_KEY', 'DOUBAO_API_KEY', 'ASR_API_KEY', 'DEEPGRAM_API_KEY', 'LLM_API_KEY', 'DOUBAO_TRANSLATION_API_KEY']);
export function ProviderSettings({ saved, actionsTarget, beforeSave, initialProvider = 'doubao', initialMinutesMode = 'asr-llm' }: { saved: (state: Pick<Bootstrap,'providers'|'meetingAutomation'|'audioMinutesDefault'>) => void; actionsTarget: HTMLElement | null; beforeSave?:()=>Promise<void>|undefined; initialProvider?: string; initialMinutesMode?: string }) {
  const savedDraft=useRef<Record<string,string>>({});
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
      savedDraft.current={ ...Object.fromEntries(Object.entries(config).map(([key, value]) => [key, typeof value === 'boolean' ? '' : String(value)])), LLM_REASONING_EFFORT: effort === 'default' ? 'auto' : effort === 'max' ? 'xhigh' : effort };
      setDraft(savedDraft.current);
    }).catch(e => { if (active) setError(messageOf(e)); });
    return () => { active = false; };
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!values || pending.current) return;
    const submitted = Object.fromEntries(new FormData(e.currentTarget));
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await beforeSave?.();
      const { values: config, providers, meetingAutomation, audioMinutesDefault } = await api<{ values: Values } & Pick<Bootstrap,'providers'|'meetingAutomation'|'audioMinutesDefault'>>('/settings/providers', 'PUT', submitted);
      setValues(config);
      savedDraft.current={...savedDraft.current,...Object.fromEntries(Object.entries(submitted).map(([key,value])=>[key,secretKeys.has(key)?'':String(config[key]??value)]))};
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
      saved({providers,meetingAutomation,audioMinutesDefault});
    } catch (e) { setError(messageOf(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  const dirty=Boolean(values)&&(provider!==savedDraft.current.ASR_PROVIDER||Object.entries(draft).some(([key,value])=>key!=='ASR_PROVIDER'&&value!==(savedDraft.current[key]||'')));
  const roleValues = modelRoleValues(draft.LLM_ROLE_MODELS);
  const setRoleModel = (role: string, model: string) => setDraft(current => ({ ...current, LLM_ROLE_MODELS: updateModelRole(current.LLM_ROLE_MODELS, role, model) }));
  const field = (key: string, label: string, secret = false, placeholder = '') => <label key={key}><span className="settings-field-label" title={label}><span>{label}</span>{secret && <Status>{values?.[key] ? '已设置' : '未设置'}</Status>}</span><input name={key} type={secret ? 'password' : 'text'} autoComplete="off" disabled={!values} value={draft[key] || ''} onChange={event => {
    const value = event.target.value;
    setDraft(current => ({ ...current, [key]: value, ...(key === 'LLM_API_URL' && !protocolTouched.current ? { LLM_PROTOCOL: protocolForAddress(value) } : {}) }));
  }} placeholder={secret && values?.[key] ? '留空保留已保存密钥' : placeholder}/></label>;
  const probe = (kind:'asr'|'minutes'|'learning',label:string) => {
    const belongs=(key:string)=>kind==='asr'?/^(ASR_|FUNASR_|DEEPGRAM_|DOUBAO_ASR_|DOUBAO_API_KEY$)/.test(key):kind==='learning'?key.startsWith('LEARNING_'):/^(MINUTES_MODE$|LLM_|OPENAI_REALTIME_|DOUBAO_(?!ASR)|AUTO_AUDIO_MINUTES$)/.test(key);
    const entries=Object.entries(draft).filter(([key])=>key!=='ASR_PROVIDER'&&belongs(key));
    const dirty=Boolean(values)&&(kind==='asr'&&provider!==savedDraft.current.ASR_PROVIDER||entries.some(([key,value])=>value!==(savedDraft.current[key]||'')));
    const revision=JSON.stringify([kind==='asr'?provider:null,entries,Object.entries(values||{}).filter(([key])=>belongs(key))]);
    return <ModuleConnectionCheck label={label} revision={revision} disabled={busy} blockedReason={!values?'正在加载配置…':dirty?'请先保存这组配置，再检测已保存的连接。':undefined} check={async signal=>{if(kind==='learning'){const status=await api<{available:boolean;status:string}>('/learning/status','GET',undefined,signal);if(!status.available)throw new Error(status.status==='disabled'?'学习服务尚未启用。':status.status==='checking'?'学习服务正在检查，请稍后重试。':'学习服务暂不可用，请检查该模块配置。');return '学习服务可用。';}return (await api<{message:string}>('/settings/providers/test','POST',{kind},signal)).message;}}/>;
  };
  const nativeMeeting = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && /Mac|Windows/.test(navigator.userAgent);
  const audioOnly = draft.MINUTES_MODE === 'doubao-audio-only';
  return <div className="settings-section provider-settings-surface">
    <Toast message={error || notice} error={Boolean(error)} dismiss={dismiss}/>
    <form id="provider-settings" onSubmit={submit} className="provider-form" aria-busy={busy || !values}>
      <section className="provider-module"><div className="provider-module-copy"><h3>语音转录</h3><p>为每次讨论选择合适的转录服务，识别设置分别保留。</p></div><div className="provider-module-fields"><div className="settings-heading-row"><div className="section-title"><GearSix size={19}/><h3>模型与转录服务</h3></div><Select label="转录服务" name="ASR_PROVIDER" disabled={!values} value={provider} onChange={setProvider} options={[...(values?.LOCAL_ASR_AVAILABLE || provider === 'sensevoice-local' ? [{value:'sensevoice-local',label:values?.LOCAL_ASR_AVAILABLE ? '本地转录 · SenseVoice（已内置）' : '本地转录 · SenseVoice（未安装）'}] : []),{value:'funasr',label:'FunASR · 外部服务（高级）'},{value:'doubao',label:'豆包语音识别 · API Key'},{value:'deepgram',label:'Deepgram'},{value:'openai-compatible',label:'兼容转录接口'}]}/></div>
      {!values && <p className="settings-mode-note" role="status">正在读取服务配置…</p>}
      {!audioOnly && <div className="settings-dependent-fields">
        {provider === 'doubao' && <>{field('DOUBAO_ASR_URL','WebSocket 地址')}{field('DOUBAO_ASR_RESOURCE_ID','语音资源 ID')}{field('DOUBAO_API_KEY','语音 API Key',true)}{field('DOUBAO_ASR_HOTWORDS','容易识别错误的词语',false,'例如：聆记，Redis Sentinel，产品名称')}{field('DOUBAO_ASR_CONTEXT','识别场景背景（可选）',false,'例如：港口调度周会，讨论集装箱车辆与路径规划')}</>}
        {provider === 'sensevoice-local' && values && !values.LOCAL_ASR_AVAILABLE && <p role="status">本地模型未安装，请选择其他转录服务。</p>}
        {provider === 'funasr' && <>{field('FUNASR_API_URL','FunASR 转录地址',false,'http://127.0.0.1:18586/v1/audio/transcriptions')}{field('FUNASR_MODEL','识别模型',false,'sensevoice')}{field('FUNASR_API_KEY','服务密钥（可选）',true)}</>}
        {provider === 'deepgram' && field('DEEPGRAM_API_KEY','Deepgram API Key',true)}
        {provider === 'openai-compatible' && <>{field('ASR_API_URL','转录请求地址')}{field('ASR_MODEL','语音模型')}{field('ASR_API_KEY','转录 API Key',true)}</>}
      </div>}
      {!audioOnly&&probe('asr','语音转录')}</div></section><section className="provider-module"><div className="provider-module-copy"><h3>文字与音频模型</h3><p>纪要、翻译与分析沿用各自的模型配置。</p></div><div className="provider-module-fields">
      <div className="settings-heading-row"><div className="settings-subheading"><CloudCheck size={18}/><h4>AI纪要</h4></div><Select label="纪要输入方式" name="MINUTES_MODE" disabled={!values} value={draft.MINUTES_MODE || 'asr-llm'} onChange={value => setDraft(current => ({...current,MINUTES_MODE:value}))} options={[{value:'asr-llm',label:'ASR＋LLM'},{value:'openai-realtime',label:'OpenAI Realtime'},{value:'doubao-audio',label:'豆包音频'},{value:'doubao-audio-only',label:'仅豆包音频模型'}]}/></div>
      <div className="settings-dependent-fields">
        {draft.MINUTES_MODE === 'openai-realtime' && <><h4 className="settings-model-title">实时音频模型</h4>{field('OPENAI_REALTIME_URL','Realtime WebSocket 地址')}{field('OPENAI_REALTIME_MODEL','Realtime 模型')}{field('OPENAI_REALTIME_API_KEY','OpenAI Realtime API Key',true)}</>}
        <h4 className="settings-model-title">{draft.MINUTES_MODE === 'openai-realtime' ? '文字分析模型' : '纪要模型'}</h4>
        <label>模型协议<Select label="模型协议" name="LLM_PROTOCOL" disabled={!values} value={draft.LLM_PROTOCOL || 'responses'} onChange={value => { protocolTouched.current = true; setDraft(current => ({...current,LLM_PROTOCOL:value})); }} options={[{value:'responses',label:'Responses'},{value:'chat-completions',label:'Chat Completions'}]}/></label>
        {field('LLM_API_URL','服务地址',false,'https://服务域名/v1 或完整接口地址')}{field('LLM_MODEL','模型 / 接入点 ID',false,'填写已开通的 model ID 或 ep-…')}
        <label>推理强度<Select label="推理强度" name="LLM_REASONING_EFFORT" disabled={!values} value={draft.LLM_REASONING_EFFORT || 'auto'} onChange={value=>setDraft(current=>({...current,LLM_REASONING_EFFORT:value}))} options={[{value:'auto',label:'自动'},{value:'low',label:'低'},{value:'medium',label:'中'},{value:'high',label:'高'},{value:'xhigh',label:'更高'}]}/></label>{field('LLM_API_KEY','模型Key',true)}
      </div>
      <input type="hidden" name="LLM_ROLE_MODELS" value={draft.LLM_ROLE_MODELS || ''}/>
    <details className="settings-model-routing"><summary><span>按任务选择模型</span><span className="settings-routing-state">{!values ? '加载中' : Object.keys(roleValues).length ? `${Object.keys(roleValues).length} 项已设置` : '沿用默认'}</span><CaretDown size={15} aria-hidden="true"/></summary>
    <div className="settings-dependent-fields">
      {modelRoleLabels.map(([role, label]) => {
        const audio = ['minutesMap', 'minutesFinal'].includes(role) && ['openai-realtime', 'doubao-audio', 'doubao-audio-only'].includes(draft.MINUTES_MODE);
        const dedicated = role === 'translation' && draft.TRANSLATION_PROVIDER === 'doubao-seed';
        return <label key={role}><span className="settings-field-label"><span>{label}</span></span><input aria-label={label + '模型'} disabled={!values || audio || dedicated} value={audio || dedicated ? '' : roleValues[role] || ''} placeholder={audio ? '使用上方音频模型' : dedicated ? '使用专用翻译模型' : '跟随默认模型'} title={audio ? '音频纪要使用上方音频模型' : dedicated ? '当前使用专用翻译服务' : undefined} onChange={event => setRoleModel(role, event.target.value)} onBlur={event => setRoleModel(role, event.target.value.trim())}/></label>;
      })}
    </div></details>
    {probe('minutes','纪要模型')}</div></section><section className="provider-module"><div className="provider-module-copy"><h3>学习与评审</h3><p>管理已配置的学习服务，连接状态独立显示。</p></div><div className="provider-module-fields">
      <div className="settings-heading-row"><div className="settings-subheading"><CloudCheck size={18}/><h4>翻译服务</h4></div><Select label="翻译模型" name="TRANSLATION_PROVIDER" disabled={!values} value={draft.TRANSLATION_PROVIDER || 'auto'} onChange={value => setDraft(current => ({...current,TRANSLATION_PROVIDER:value}))} options={[{value:'auto',label:'自动选择'},{value:'text-model',label:'当前文字模型'},{value:'doubao-seed',label:'豆包 Seed 专用翻译'}]}/></div>
      {(draft.TRANSLATION_PROVIDER === 'text-model' || ((!draft.TRANSLATION_PROVIDER || draft.TRANSLATION_PROVIDER === 'auto') && roleValues.translation)) ? <p className="settings-mode-note">翻译使用文字模型的连接配置；任务模型留空时沿用默认模型。</p> : <div className="settings-dependent-fields"><h4 className="settings-model-title">专用翻译模型</h4>{field('DOUBAO_TRANSLATION_MODEL','翻译模型 / 接入点 ID',false,'doubao-seed-translation-250915')}{field('DOUBAO_TRANSLATION_API_URL','翻译服务地址（可选）',false,'留空沿用上方完整模型服务地址')}{field('DOUBAO_TRANSLATION_API_KEY','翻译 API Key（可选）',true)}</div>}
      <div className="settings-heading-row"><div className="settings-subheading"><CloudCheck size={18}/><h4>学习与评审</h4><Status>{draft.LEARNING_SSH_HOST && draft.LEARNING_REMOTE_BASE ? '已填写' : '未配置'}</Status></div></div>
      <div className="settings-dependent-fields">{field('LEARNING_SSH_HOST','SSH 主机',false,'填写已配置的 SSH 主机别名或域名')}{field('LEARNING_REMOTE_BASE','远端服务目录',false,'填写服务所在的绝对目录')}</div>
      {probe('learning','学习与评审')}</div></section><section className="provider-module"><div className="provider-module-copy"><h3>会议联动</h3><p>选择需要联动的应用，保留原有录音与授权方式。</p></div><div className="provider-module-fields">
      <div className="settings-heading-row"><div className="settings-subheading"><CloudCheck size={18}/><h4>后台会议联动</h4></div></div>
      <input type="hidden" name="AUTO_AUDIO_MINUTES" value={draft.AUTO_AUDIO_MINUTES||'false'}/>
      {['openai-realtime','doubao-audio','doubao-audio-only'].includes(draft.MINUTES_MODE)&&<label className="checkbox-label"><input type="checkbox" checked={draft.AUTO_AUDIO_MINUTES==='true'} disabled={!values} onChange={event=>setDraft(current=>({...current,AUTO_AUDIO_MINUTES:String(event.target.checked)}))}/><span>新会议默认发送音频生成 AI 纪要</span></label>}
      <input type="hidden" name="AUTO_MEETING_ENABLED" value={draft.AUTO_MEETING_ENABLED || 'false'}/><input type="hidden" name="AUTO_MEETING_BROWSER" value={draft.AUTO_MEETING_BROWSER || 'true'}/><input type="hidden" name="AUTO_MEETING_FEISHU" value={draft.AUTO_MEETING_FEISHU || 'true'}/>
      <label className="checkbox-label"><input type="checkbox" checked={draft.AUTO_MEETING_ENABLED==='true'} disabled={!values || !nativeMeeting} onChange={event=>setDraft(current=>({...current,AUTO_MEETING_ENABLED:String(event.target.checked)}))}/>允许音频调用触发自动录音</label>
      <div className="settings-dependent-fields"><label className="checkbox-label"><input type="checkbox" checked={draft.AUTO_MEETING_BROWSER!=='false'} disabled={!values || !nativeMeeting || draft.AUTO_MEETING_ENABLED!=='true'} onChange={event=>setDraft(current=>({...current,AUTO_MEETING_BROWSER:String(event.target.checked)}))}/>浏览器 · Chrome / Edge</label><label className="checkbox-label"><input type="checkbox" checked={draft.AUTO_MEETING_FEISHU!=='false'} disabled={!values || !nativeMeeting || draft.AUTO_MEETING_ENABLED!=='true'} onChange={event=>setDraft(current=>({...current,AUTO_MEETING_FEISHU:String(event.target.checked)}))}/>飞书</label></div>
    </div></section>{actionsTarget && createPortal(<><span className="settings-save-state" role="status" data-dirty={dirty}>{busy?'正在保存…':error?'保存失败':dirty?'有未保存的更改':notice?'已保存':''}</span><Button disabled={busy || !values} type="submit" form="provider-settings" variant="primary">保存设置</Button></>, actionsTarget)}
    </form>
  </div>;
}
