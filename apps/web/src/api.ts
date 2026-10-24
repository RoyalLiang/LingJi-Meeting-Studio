import { trace } from './telemetry';
import type { AudioChunk } from './model';
let binaryAudio = false;
export function setAudioTransport(value?: string) { binaryAudio = value === 'pcm-v1'; }
let csrf = '';
export const setCsrf = (token: string) => { csrf = token; };
const messages: Record<string, string> = {
  funasr_not_configured: '请在设置中填写 FunASR 转录地址和识别模型。',
  funasr_service_unavailable: 'FunASR 服务暂不可用，请先启动本机服务或检查私有服务连接，再重新处理。录音已保留。',
  funasr_credentials_rejected: 'FunASR 服务拒绝了密钥，请检查服务认证配置。',
  funasr_endpoint_unavailable: 'FunASR 转录接口不存在，请使用完整的 /v1/audio/transcriptions 地址。',
  funasr_compatible_endpoint_required: 'FunASR 需要兼容转录地址，路径以 /v1/audio/transcriptions 结尾。',
  invalid_funasr_response: 'FunASR 未返回有效转录，请检查服务和模型版本。录音已保留。',
  invalid_funasr_audio: '转录音频格式异常，录音已保留，请重新处理。',
  doubao_asr_45000292: '豆包语音识别配额超限，请在语音服务控制台检查额度后重试（45000292）。',
  service_unavailable: '记录服务暂时不可用，正在尝试恢复连接。',
  invalid_response: '记录服务返回不完整，操作结果尚未确认，请恢复连接后检查。',
  translation_not_configured: '请在设置中配置豆包翻译模型与服务连接。',
  translation_connection_failed: '翻译连接失败，请检查翻译服务地址后重试。',
  translation_credentials_rejected: '翻译密钥被拒绝，请核对对应服务。',
  translation_incomplete: '翻译未完整返回，原文已保留，可重试。',
  invalid_translation: '翻译结果不可用，原文已保留，可重试。',
  invalid_workspace: '目录名称需为 1 至 80 个字，说明最多 240 个字。',
  workspace_not_found: '工作目录不存在或当前账户无权访问。',
  workspace_limit: '最多创建 50 个工作目录，请使用已有目录。',
  invalid_record_selection: '请选择 1 至 200 场可归档会议。',
  archive_recording: '请先暂停或结束录音，再归档这场会议。',
  workspace_no_completed_transcript: '当前范围尚无已结束且有转录内容的会议。',
  analysis_run_conflict: '分析任务已变化，请刷新后重试。',
  record_completed: '本场会议已结束，请开启新会议。',
  pause_audio_pending: '上一段音频仍在补传，完成后即可继续本场会议。',
  capture_not_recording: '当前没有可暂停的录音。',
  download_failed: '下载失败，请检查登录状态和网络后重试。',
  doubao_credentials_required: '请在设置中配置豆包语音密钥。',
  doubao_http_401: '豆包语音鉴权失败，请核对语音 API Key 或旧版双密钥。',
  doubao_http_403: '豆包语音资源无权限，请核对开通状态与资源 ID。',
  doubao_completion_timeout: '豆包未在时限内返回最终转录，音频已保留待重试。',
  doubao_incomplete_session: '转录连接提前结束，未把临时文字作为最终结果。',
  provider_model_unavailable: '模型不存在或当前密钥无访问权限，请填写已开通的模型 / ep- 接入点 ID。',
  provider_credentials_rejected: '模型密钥被拒绝，请核对对应平台与区域。',
  provider_rate_limited: '模型服务限流或配额不足，请稍后重试。',
  llm_endpoint_not_api: '模型服务返回了网页，请在设置中填写完整的模型 API 地址后重新整理。',
  llm_timeout: '模型整理超过处理时限，转录已保留，可稍后重新整理或使用更快的模型。',
  invalid_llm_response: '模型未返回有效的 JSON 结果，请检查模型与协议后重新整理。',
  configuration_admin_required: '当前账户无权修改服务配置，请联系维护者。',
  invalid_provider_url: '地址格式不正确。语音使用 wss://，纪要使用 https://。',
  invalid_asr_hotwords: '术语总长最多 100 字，每词最多 50 字，请精简后重试。',

  login_required: '请先登录。', invalid_credentials: '邮箱或密码不正确。', password_length_10_128: '密码需要 10 至 128 个字符。',
  already_exists: '该邮箱已注册，请登录。', invite_required: '请输入有效的邀请码。', invalid_email: '请输入有效的邮箱。',
  asr_not_configured: '尚未配置语音识别服务。', minutes_not_configured: '尚未配置纪要模型，请联系服务维护者。',
  record_not_finalized: '音频仍在补传或转录，请等待处理完成。', empty_transcript: '还没有可总结的转录。',
  notes_revision_conflict: '笔记已有更新，请保留当前内容并重新载入后合并。', minutes_revision_conflict: '纪要已有更新，请重新载入后合并。',
  segment_revision_conflict: '这段转录已有更新，请重新载入后合并。', realtime_audio_consent_required: '请在整理设置中明确开启音频直接理解，授权本场音频发送到所选纪要模型。', doubao_audio_not_configured: '请配置豆包 Responses 地址、模型和密钥。', doubao_audio_requires_responses: '豆包音频模式需要选择 Responses 协议。', audio_minutes_audio_unavailable: '本次片段的原音已不可用，不能生成音频纪要。', audio_minutes_window_limit: '音频窗口超出处理范围，请缩小整理范围后重试。', audio_minutes_invalid_pcm: '原音数据不完整，请检查录音上传。', realtime_not_configured: '请先配置 OpenAI Realtime 地址、模型和密钥。', realtime_connection_failed: 'Realtime 连接失败，转录仍独立进行。', realtime_connection_closed: 'Realtime 连接中断，将从本机音频恢复。', realtime_provider_error: 'Realtime 服务拒绝了请求，请核对服务地址、模型和权限。', realtime_timeout: 'Realtime 请求超时，请稍后重试。', realtime_audio_unavailable: 'Realtime 需要的原音已不可用，可切回转录后整理。', invalid_realtime_response: 'Realtime 返回的内容无法校验，请重试。', realtime_response_incomplete: 'Realtime 响应未完成，请重试。', record_chunk_limit: '本次会议的音频片段已达到资源上限，请结束后新建会议。', record_duration_limit: '旧版服务仍有音频时长限制，请升级服务后继续。',
  csrf_required: '登录状态已变化，请重新登录。', session_expired: '登录已过期，请重新登录。', login_rate_limited: '尝试过于频繁，请一分钟后重试。',
  temporary_audio_expired: '临时音频已超过 24 小时保存期，请重新导入原音。', audio_identity_conflict: '音频身份发生冲突，已保留本地数据，请导出并联系维护者。', share_expired_or_revoked: '分享已过期或被撤销。',
  minutes_unavailable: '还没有已保存的会议纪要，请生成后再导出。',
  invalid_asr_context: '识别场景背景最多 400 字，请移除控制字符。',
  asr_context_requires_second_pass: '识别场景背景需要 bigmodel_async 二遍接口；切换接口前请清空背景。'
};
export class ApiError extends Error { constructor(public code: string, public status: number) { super(messages[code] || `操作未完成（${code}）`); } }
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, method, body === undefined ? undefined : JSON.stringify(body), { 'Content-Type': 'application/json' }, signal);
}
export async function uploadAudio<T>(path: string, chunk: AudioChunk): Promise<T> {
  if (!binaryAudio) return api<T>(path, 'POST', chunk);
  const { pcm, ...metadata } = chunk;
  const bytes = Uint8Array.from(atob(pcm), char => char.charCodeAt(0));
  return request<T>(path, 'POST', bytes, { 'Content-Type': 'application/octet-stream', 'X-Record-Audio': JSON.stringify(metadata) });
}
async function request<T>(path: string, method: string, body: BodyInit | undefined, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const started = performance.now(), traceId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2).padEnd(16,'0')}`;
  const response = await serviceFetch(`/api${path}`, { method, credentials: 'same-origin', signal,
    headers: { ...headers, 'X-Record-Trace': traceId, ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }) },
    ...(body === undefined ? {} : { body }) });
  trace('http.received', {traceId, durationMs:performance.now()-started});
  const data = await readServiceJson<T & { error?: string }>(response); if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : 'request_failed', response.status); return data;
}
export const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';

export async function serviceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try { return await fetch(input, init); }
  catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw error;
    throw new ApiError('service_unavailable', 0);
  }
}
export async function readServiceJson<T>(response: Response): Promise<T> {
  try {
    const data = await response.json();
    if (!data || typeof data !== 'object') throw new Error('invalid_json_shape');
    return data as T;
  }
  catch { throw new ApiError(response.status >= 500 ? 'service_unavailable' : 'invalid_response', response.status); }
}
