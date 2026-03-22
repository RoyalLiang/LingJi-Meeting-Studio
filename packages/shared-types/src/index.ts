export type SessionStatus =
  | "created"
  | "connecting"
  | "live"
  | "stopping"
  | "completed"
  | "failed";

export type SegmentStatus = "partial" | "final";

export type SourceKind = "microphone" | "system" | "mixed";

export type AudioEncoding = "pcm_s16le" | "wav" | "opus" | "unknown";

export interface SessionDeviceSelection {
  microphoneDeviceId?: string;
  systemDeviceId?: string;
  sourceKind: SourceKind;
}

export interface SessionConfig {
  sourceLanguage: string;
  targetLanguages: string[];
  enableAudioStorage: boolean;
  enableLiveShare: boolean;
  glossaryIds: string[];
  referenceDocumentIds: string[];
}

export interface Session {
  id: string;
  workspaceId: string;
  folderId?: string;
  title: string;
  status: SessionStatus;
  deviceSelection: SessionDeviceSelection;
  config: SessionConfig;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface TranscriptSegment {
  segmentId: string;
  sessionId: string;
  sequence: number;
  status: SegmentStatus;
  sourceLanguage: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  speakerId?: string;
  provider: string;
  glossaryHits: string[];
  receivedAt: string;
}

export interface SegmentTranslation {
  segmentId: string;
  targetLanguage: string;
  text: string;
  provider: string;
  isFinal: boolean;
}

export interface AudioChunkMetadata {
  chunkId: string;
  sessionId: string;
  sequence: number;
  encoding: AudioEncoding;
  sampleRateHz: number;
  channels: number;
  byteLength: number;
  durationMs?: number;
  sourceLanguage?: string;
  targetLanguages: string[];
  transcriptHint?: string;
  isFinalChunk: boolean;
  receivedAt: string;
}

export interface AudioChunkAck {
  accepted: true;
  sessionId: string;
  chunkId: string;
  sequence: number;
  byteLength: number;
  totalChunksReceived: number;
  totalBytesReceived: number;
  transcriptAccepted: boolean;
}

export interface ShareLink {
  id: string;
  sessionId: string;
  token: string;
  access: "anonymous_view" | "workspace_view";
  expiresAt?: string;
  revokedAt?: string;
}

export interface ActionItem {
  id: string;
  text: string;
  owner?: string;
  dueDate?: string;
  segmentIds: string[];
}

export interface SessionSummary {
  sessionId: string;
  summary: string;
  topics: Array<{
    title: string;
    segmentIds: string[];
  }>;
  actionItems: ActionItem[];
  generatedAt: string;
}

export interface RealtimeEnvelope<TType extends string, TPayload> {
  type: TType;
  sessionId: string;
  emittedAt: string;
  payload: TPayload;
}

export type RealtimeEvent =
  | RealtimeEnvelope<"session.status_changed", Pick<Session, "id" | "status">>
  | RealtimeEnvelope<"audio.chunk_received", AudioChunkMetadata>
  | RealtimeEnvelope<"segment.upserted", TranscriptSegment>
  | RealtimeEnvelope<"translation.upserted", SegmentTranslation>
  | RealtimeEnvelope<"summary.ready", SessionSummary>;
