// Synthesis reads several validated windows; its lease must cover this same bounded request.
export const minutesTimeoutMs = job => job.scope === 'live' && !job.pausedCheckpoint ? 120000 : job.stage === 'synthesis' && job.summaries?.length > 1 ? 360000 : 240000;
