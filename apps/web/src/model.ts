export type SourceKind = 'microphone' | 'display' | 'import';
export interface Source { asr?: {state:string;error?:string;identityWarning?:string;preview?:{text:string;startMs:number;updatedAt:number}|null;runtime?:{firstTextMs?:number;firstConfirmedMs?:number;firstUiReadyMs?:number;connectionMs?:number;totalMs?:number}}; id: string; sessionId: string; timelineOffsetMs?: number; epoch: string; kind: SourceKind; label: string; lastSequence: number | null; watermark: number; stopped: boolean }
export interface Evidence { segmentId: string; revision: number }
export interface Segment { speakerId?: string | null; speakerHash?: string | null; id: string; revision: number; sourceId: string; text: string; speaker: string; startMs: number; endMs: number; translation?: string; translationLanguage?: string; translationError?: string; translationAttempts?: number; edited: boolean }
export interface MinutesItem { text: string; evidence: Evidence[] }
export interface Topic { title: string; summary: string; evidence: Evidence[] }
export interface SpeakerSummary { speakerId: string | null; speaker: string; summary: string; evidence: Evidence[] }
export interface ModelRuntime { protocol?: string; streamed?: boolean; firstTokenMs?: number | null; durationMs?: number; elapsedMs?: number }
export interface SummaryTable { title: string; columns: string[]; rows: { cells: string[]; evidence: Evidence[] }[] }
export interface Minutes { tables?: SummaryTable[]; currentDiscussion?: MinutesItem[]; speakerSummaries?: SpeakerSummary[]; decisions?: MinutesItem[]; topics?: Topic[]; runtime?: ModelRuntime; method?: string; title: string; sections: { heading: string; items: MinutesItem[] }[]; actions: (MinutesItem & { owner?: string; due?: string })[];
  revision: number; transcriptRevision: number; edited: boolean; evidenceSnapshot: Segment[] }
export interface Job { scope?: string; automatic?: boolean; preview?: {kind:string;text:string}[]; runtime?: ModelRuntime; id: string; status: string; error?: string; transcriptRevision: number }
export interface RecordDetail { speakers?: {id:string;hash?:string;label:string}[]; autoMinutes?: {enabled:boolean;intervalSeconds:number}; liveMinutes?: Minutes | null;
  insights?: {transcriptRevision: number; method: string; items: {kind: string; text: string; evidence: Evidence[]}[]; evidenceSnapshot: Segment[]}; intentError?: string; id: string; title: string; workspaceId?: string|null; language: string; capture: string; transcription: string; sources: Source[]; segments: Segment[];
  notes: string; notesRevision: number; minutes: Minutes | null; minutesRevision: number; minuteVersions: { revision: number; transcriptRevision: number; edited: boolean }[]; transcriptRevision: number; cursor: string; jobs: Job[]; pendingChunks: number;
  retainAudio: boolean; audioPurged?: boolean; retentionDays: number; deleteAt: string; translationTarget?: string; usage: { samples: number; llmTokens: number } }
export interface RecordListItem { id: string; title: string; workspaceId?:string|null; createdAt: string; updatedAt: string; capture: string; transcription: string; segments: number; seconds: number; hasMinutes: boolean }
export interface Bootstrap { canConfigure?: boolean; email: string; csrf: string; storage: string; providers: { asr: boolean; minutes: boolean; translation?: boolean; fixture: boolean }; limits: { maxMinutes: number; maxRecords: number } }
export interface AudioChunk { sessionId: string; sourceId: string; epoch: string; sequence: number; sampleOffset: number; sampleCount: number; sampleRate: number; digest: string; pcm: string }
export const timecode = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`;
