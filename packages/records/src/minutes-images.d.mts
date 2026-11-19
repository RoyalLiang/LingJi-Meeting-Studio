type Ref = {segmentId: string; revision: number};
type Group = {evidence?: Ref[]; items: {evidence?: Ref[]}[]};
type Timeline = {evidenceSnapshot?: {id: string; revision: number; startMs?: number; endMs?: number}[]};
export const otherMeetingImages: string;
export function placeMeetingImages<T extends {atMs: number; revision: number}>(
  minutes: Timeline, groups: Group[], frames: readonly T[],
): {placed: T[][]; other: T[]};
