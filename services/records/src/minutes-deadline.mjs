// A paused checkpoint keeps live merge semantics, but can finish outside the interactive update budget.
export const minutesTimeoutMs = job => job.scope === 'live' && !job.pausedCheckpoint ? 120000 : 240000;
