import { ApiError, serviceFetch } from './api';
export async function fetchDownload(href: string, signal?: AbortSignal) {
  const response = await serviceFetch(href, { credentials: 'same-origin', cache: 'no-store', signal }, 0);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error || 'download_failed', response.status);
  }
  let blob: Blob;
  try { blob = await response.blob(); } catch { throw new ApiError('invalid_response', response.status); }
  if (!blob.size) throw new Error('下载文件为空，请重试。');
  const format = new URL(href, location.origin).searchParams.get('format') || 'json';
  const fallback = `meeting.${format === 'markdown' ? 'md' : format === 'issues' ? 'issues.json' : format}`;
  const disposition = response.headers.get('content-disposition') || '';
  let offered = disposition.match(/filename="([^"]+)"/)?.[1];
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) { try { offered = decodeURIComponent(encoded); } catch { /* Use the ASCII fallback. */ } }
  const filename = (offered || fallback).replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0,160);
  return { blob, filename };
}
