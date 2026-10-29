export function sharedMinutes<T extends { evidenceSnapshot: { id: string; revision: number }[] }>(minutes: T | null | undefined): T | null;
