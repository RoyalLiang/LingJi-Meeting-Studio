export type SourceKind = 'microphone' | 'display' | 'import';
export interface Source { id: string; sessionId: string; epoch: string; kind: SourceKind; label: string; lastSequence: number | null; watermark: number; stopped: boolean }
export interface Evidence { segmentId: string; revision: number }
export interface Segment { id: string; revision: number; sourceId: string; text: string; speaker: string; startMs: number; endMs: number; translation?: string; edited: boolean }
export interface MinutesItem { text: string; evidence: Evidence[] }
export interface Minutes { title: string; sections: { heading: string; items: MinutesItem[] }[]; actions: (MinutesItem & { owner?: string; due?: string })[];
  revision: number; transcriptRevision: number; edited: boolean; evidenceSnapshot: Segment[] }
export interface Job { id: string; status: string; error?: string; transcriptRevision: number }
export interface RecordDetail { id: string; title: string; language: string; capture: string; transcription: string; sources: Source[]; segments: Segment[];
  notes: string; notesRevision: number; minutes: Minutes | null; minutesRevision: number; minuteVersions: { revision: number; transcriptRevision: number; edited: boolean }[]; transcriptRevision: number; cursor: string; jobs: Job[]; pendingChunks: number;
  retainAudio: boolean; audioPurged?: boolean; retentionDays: number; deleteAt: string; translationTarget?: string; usage: { samples: number; llmTokens: number } }
export interface RecordListItem { id: string; title: string; createdAt: string; updatedAt: string; capture: string; transcription: string; segments: number; seconds: number; hasMinutes: boolean }
export interface Bootstrap { email: string; csrf: string; storage: string; providers: { asr: boolean; minutes: boolean; fixture: boolean }; limits: { maxMinutes: number; maxRecords: number } }
export interface AudioChunk { sessionId: string; sourceId: string; epoch: string; sequence: number; sampleOffset: number; sampleCount: number; sampleRate: number; digest: string; pcm: string }
export const timecode = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`;
