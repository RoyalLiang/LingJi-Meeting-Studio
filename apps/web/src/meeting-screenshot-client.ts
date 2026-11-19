import type {MeetingScreenshot} from './model';

export async function loadMinutesScreenshots(recordId: string, through: number, signal?: AbortSignal) {
  const {api} = await import('./api');
  const {frames} = await api<{frames: MeetingScreenshot[]}>(`/records/${recordId}/screenshots?through=${through}`, 'GET', undefined, signal);
  return frames;
}
