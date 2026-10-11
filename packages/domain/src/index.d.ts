import type {
  Session,
  TranscriptSegment,
  SegmentTranslation,
  AudioChunkMetadata,
  AudioChunkAck,
  RealtimeEnvelope
} from "@tts/shared-types";

export class SessionAggregate {
  constructor(params: Partial<Session>);
  static create(payload?: Partial<Session>): SessionAggregate;
  static fromSnapshot(snapshot: Session): SessionAggregate;
  get id(): string;
  get workspaceId(): string;
  get folderId(): string | null;
  get title(): string;
  get status(): Session["status"];
  get deviceSelection(): Session["deviceSelection"];
  get config(): Session["config"];
  get createdAt(): string;
  get startedAt(): string | null;
  get endedAt(): string | null;
  isLive(): boolean;
  isTerminated(): boolean;
  start(): this;
  complete(): this;
  fail(): this;
  rename(newTitle: string): this;
  moveToFolder(folderId?: string | null): this;
  updateConfig(updates?: Partial<Session["config"]>): this;
  updateDeviceSelection(updates?: Partial<Session["deviceSelection"]>): this;
  toSnapshot(): Session;
}

export class TranscriptSegmentEntity {
  constructor(params: Partial<TranscriptSegment>);
  static create(payload: Partial<TranscriptSegment>): TranscriptSegmentEntity;
  static fromSnapshot(snapshot: TranscriptSegment): TranscriptSegmentEntity;
  get segmentId(): string;
  get sessionId(): string;
  get sequence(): number;
  get status(): TranscriptSegment["status"];
  get sourceLanguage(): string;
  get startMs(): number;
  get endMs(): number;
  get text(): string;
  get confidence(): number | undefined;
  get speakerId(): string | undefined;
  get provider(): string;
  get glossaryHits(): string[];
  get receivedAt(): string;
  isFinal(): boolean;
  isPartial(): boolean;
  markFinal(): this;
  updateText(text: string, status?: TranscriptSegment["status"]): this;
  toSnapshot(): TranscriptSegment;
}

export class TranslationEntity {
  constructor(params: Partial<SegmentTranslation>);
  static create(payload: Partial<SegmentTranslation>): TranslationEntity;
  static fromSnapshot(snapshot: SegmentTranslation): TranslationEntity;
  get segmentId(): string;
  get targetLanguage(): string;
  get text(): string;
  get provider(): string;
  get isFinal(): boolean;
  markFinal(): this;
  toSnapshot(): SegmentTranslation;
}

export class DomainError extends Error {
  errorCode: string;
  statusCode: number;
  constructor(message: string, errorCode?: string, statusCode?: number);
}

export class AudioChunkStreamTracker {
  constructor(sessionId: string);
  get sessionId(): string;
  get totalChunksReceived(): number;
  get totalBytesReceived(): number;
  get lastSequence(): number;
  recordChunk(metadata: AudioChunkMetadata, bodyBuffer?: Buffer): AudioChunkAck;
  reset(): void;
}

export function normalizeSourceLanguage(value?: string, fallback?: string): string;
export function normalizeTargetLanguages(rawValue?: string | string[]): string[];
export function detectLanguageFromText(text?: string): string | null;
export function resolveSegmentSourceLanguage(requestedSourceLanguage?: string, text?: string, fallback?: string): string;
export function isSameLanguage(langA?: string, langB?: string): boolean;
export function shouldTranslate(sourceLanguage?: string, targetLanguage?: string, options?: { suppressSameLanguage?: boolean }): boolean;

export function createRealtimeEnvelope<TType extends string, TPayload>(type: TType, sessionId: string, payload: TPayload): RealtimeEnvelope<TType, TPayload>;
export function createSessionStatusChangedEvent(sessionId: string, status: Session["status"]): RealtimeEnvelope<"session.status_changed", Pick<Session, "id" | "status">>;

export function normalizeDraftText(value?: string): string;
export function progressiveDraftEvents(previousText?: string, nextText?: string, status?: string): Array<{ text: string; status: "partial" | "final" }>;
export function calculateSegmentTiming(currentOffsetMs: number, wordCount: number): { startMs: number; endMs: number; durationMs: number; nextOffsetMs: number };

export function shapeReplayPayload(session: Session, segments?: TranscriptSegment[], translations?: SegmentTranslation[], audioClips?: any[], summary?: any): any;
export function attachSessionMetrics(session: Session, replay: any): Session & { segmentCount: number; translationCount: number };
