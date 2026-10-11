import { randomUUID } from "node:crypto";

export class TranscriptSegmentEntity {
  #segmentId;
  #sessionId;
  #sequence;
  #status;
  #sourceLanguage;
  #startMs;
  #endMs;
  #text;
  #confidence;
  #speakerId;
  #provider;
  #glossaryHits;
  #receivedAt;

  constructor(params) {
    this.#segmentId = params.segmentId ?? randomUUID();
    this.#sessionId = params.sessionId;
    this.#sequence = Number(params.sequence ?? 1);
    this.#status = params.status === "final" ? "final" : "partial";
    this.#sourceLanguage = String(params.sourceLanguage ?? "en");
    this.#startMs = Number(params.startMs ?? 0);
    this.#endMs = Number(params.endMs ?? 0);
    this.#text = String(params.text ?? "");
    this.#confidence = params.confidence !== undefined ? Number(params.confidence) : undefined;
    this.#speakerId = params.speakerId ? String(params.speakerId) : undefined;
    this.#provider = String(params.provider ?? "unknown");
    this.#glossaryHits = Array.isArray(params.glossaryHits) ? [...params.glossaryHits] : [];
    this.#receivedAt = params.receivedAt ?? new Date().toISOString();
  }

  static create(payload) {
    return new TranscriptSegmentEntity(payload);
  }

  static fromSnapshot(snapshot) {
    return new TranscriptSegmentEntity(snapshot);
  }

  get segmentId() {
    return this.#segmentId;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get sequence() {
    return this.#sequence;
  }

  get status() {
    return this.#status;
  }

  get sourceLanguage() {
    return this.#sourceLanguage;
  }

  get startMs() {
    return this.#startMs;
  }

  get endMs() {
    return this.#endMs;
  }

  get text() {
    return this.#text;
  }

  get confidence() {
    return this.#confidence;
  }

  get speakerId() {
    return this.#speakerId;
  }

  get provider() {
    return this.#provider;
  }

  get glossaryHits() {
    return [...this.#glossaryHits];
  }

  get receivedAt() {
    return this.#receivedAt;
  }

  isFinal() {
    return this.#status === "final";
  }

  isPartial() {
    return this.#status === "partial";
  }

  markFinal() {
    this.#status = "final";
    return this;
  }

  updateText(text, status) {
    this.#text = String(text ?? "");
    if (status) {
      this.#status = status === "final" ? "final" : "partial";
    }
    return this;
  }

  toSnapshot() {
    return {
      segmentId: this.#segmentId,
      sessionId: this.#sessionId,
      sequence: this.#sequence,
      status: this.#status,
      sourceLanguage: this.#sourceLanguage,
      startMs: this.#startMs,
      endMs: this.#endMs,
      text: this.#text,
      confidence: this.#confidence,
      speakerId: this.#speakerId,
      provider: this.#provider,
      glossaryHits: [...this.#glossaryHits],
      receivedAt: this.#receivedAt
    };
  }
}

export class TranslationEntity {
  #segmentId;
  #targetLanguage;
  #text;
  #provider;
  #isFinal;

  constructor(params) {
    this.#segmentId = params.segmentId;
    this.#targetLanguage = String(params.targetLanguage ?? "zh-CN");
    this.#text = String(params.text ?? "");
    this.#provider = String(params.provider ?? "unknown");
    this.#isFinal = Boolean(params.isFinal);
  }

  static create(payload) {
    return new TranslationEntity(payload);
  }

  static fromSnapshot(snapshot) {
    return new TranslationEntity(snapshot);
  }

  get segmentId() {
    return this.#segmentId;
  }

  get targetLanguage() {
    return this.#targetLanguage;
  }

  get text() {
    return this.#text;
  }

  get provider() {
    return this.#provider;
  }

  get isFinal() {
    return this.#isFinal;
  }

  markFinal() {
    this.#isFinal = true;
    return this;
  }

  toSnapshot() {
    return {
      segmentId: this.#segmentId,
      targetLanguage: this.#targetLanguage,
      text: this.#text,
      provider: this.#provider,
      isFinal: this.#isFinal
    };
  }
}
