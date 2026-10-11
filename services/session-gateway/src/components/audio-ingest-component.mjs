import { randomUUID } from "node:crypto";
import {
  AudioChunkStreamTracker,
  normalizeSourceLanguage,
  normalizeTargetLanguages
} from "@tts/domain";

function parseBooleanHeader(value) {
  if (!value) {
    return false;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function parseIntegerHeader(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class AudioIngestComponent {
  #trackersBySession = new Map();

  getTracker(sessionId) {
    let tracker = this.#trackersBySession.get(sessionId);
    if (!tracker) {
      tracker = new AudioChunkStreamTracker(sessionId);
      this.#trackersBySession.set(sessionId, tracker);
    }
    return tracker;
  }

  parseMetadata(sessionId, headers, body) {
    const chunkId = headers["x-audio-chunk-id"] ?? randomUUID();
    const sequence = parseIntegerHeader(headers["x-audio-sequence"], 1);
    const encoding = headers["x-audio-encoding"] ?? "unknown";
    const sampleRateHz = parseIntegerHeader(headers["x-audio-sample-rate"], 16000);
    const channels = parseIntegerHeader(headers["x-audio-channels"], 1);
    const durationMs = parseIntegerHeader(headers["x-audio-duration-ms"], undefined);
    const sourceLanguage = normalizeSourceLanguage(headers["x-source-language"], "en");
    const targetLanguages = normalizeTargetLanguages(headers["x-target-languages"]);
    const transcriptHint = headers["x-transcript-hint"];
    const isFinalChunk = parseBooleanHeader(headers["x-audio-final"]);

    return {
      chunkId: String(chunkId),
      sessionId,
      sequence,
      encoding: String(encoding),
      sampleRateHz,
      channels,
      byteLength: body.length,
      durationMs,
      sourceLanguage: String(sourceLanguage),
      targetLanguages,
      transcriptHint: transcriptHint ? String(transcriptHint) : undefined,
      isFinalChunk,
      receivedAt: new Date().toISOString()
    };
  }

  ingestChunk(sessionId, headers, body) {
    const metadata = this.parseMetadata(sessionId, headers, body);
    const tracker = this.getTracker(sessionId);
    const ack = tracker.recordChunk(metadata, body);

    return {
      metadata,
      ack
    };
  }

  getStats(sessionId) {
    const tracker = this.#trackersBySession.get(sessionId);
    if (!tracker) {
      return {
        totalChunksReceived: 0,
        totalBytesReceived: 0,
        lastSequence: 0
      };
    }
    return {
      totalChunksReceived: tracker.totalChunksReceived,
      totalBytesReceived: tracker.totalBytesReceived,
      lastSequence: tracker.lastSequence
    };
  }

  deleteSession(sessionId) {
    this.#trackersBySession.delete(sessionId);
  }
}
