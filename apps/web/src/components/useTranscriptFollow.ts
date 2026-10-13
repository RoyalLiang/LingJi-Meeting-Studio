import { useContentFollow } from './useContentFollow';

export function useTranscriptFollow(update: string, paused: boolean) {
  return useContentFollow(update, paused);
}
