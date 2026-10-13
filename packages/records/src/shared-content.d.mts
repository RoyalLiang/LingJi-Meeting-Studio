export function sharedMinutes<T extends { evidenceSnapshot: { id: string; revision: number }[] }>(minutes: T | null | undefined): T | null;
export function sharedSegments<T extends { id: string; revision: number }>(segments: T[]): T[];
