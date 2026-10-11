let csrf = '';
export const setCsrf = (token: string) => { csrf = token; };
const messages: Record<string, string> = {
  login_required: '请先登录。', invalid_credentials: '邮箱或密码不正确。', password_length_10_128: '密码需要 10 至 128 个字符。',
  already_exists: '该邮箱已注册，请登录。', invite_required: '请输入有效的邀请码。', invalid_email: '请输入有效的邮箱。',
  asr_not_configured: '尚未配置语音识别服务。', minutes_not_configured: '尚未配置纪要模型，请联系服务维护者。',
  record_not_finalized: '音频仍在补传或转录，请等待处理完成。', empty_transcript: '还没有可总结的转录。',
  notes_revision_conflict: '笔记已有更新，请保留当前内容并重新载入后合并。', minutes_revision_conflict: '纪要已有更新，请重新载入后合并。',
  segment_revision_conflict: '这段转录已有更新，请重新载入后合并。', record_duration_limit: '本次记录已达到两小时音频配额。',
  csrf_required: '登录状态已变化，请重新登录。', session_expired: '登录已过期，请重新登录。', login_rate_limited: '尝试过于频繁，请一分钟后重试。',
  temporary_audio_expired: '临时音频已超过 24 小时保存期，请重新导入原音。', audio_identity_conflict: '音频身份发生冲突，已保留本地数据，请导出并联系维护者。', share_expired_or_revoked: '分享已过期或被撤销。'
};
export class ApiError extends Error { constructor(public code: string, public status: number) { super(messages[code] || `操作未完成（${code}）`); } }
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new ApiError(data.error || 'request_failed', response.status); return data;
}
export const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
