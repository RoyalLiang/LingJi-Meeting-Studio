import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createAsrProvider,
  createAsrProviderSessionState,
  disposeAsrProviderSessionState
} from "./providers/index.mjs";

const TRANSCRIPT_API_BASE_URL = process.env.TRANSCRIPT_API_BASE_URL ?? "http://127.0.0.1:3020";
const MAX_AUDIO_CHUNK_BYTES = Number(process.env.MAX_AUDIO_CHUNK_BYTES ?? 1024 * 1024);
const MAX_TRANSCRIPT_HINT_CHARS = Number(process.env.MAX_TRANSCRIPT_HINT_CHARS ?? 4000);
const ENABLE_AUDIO_CHUNK_EVENTS = process.env.ENABLE_AUDIO_CHUNK_EVENTS === "true";
const subscribersBySession = new Map();
const sequenceBySession = new Map();
const offsetBySession = new Map();
const liveSessionIds = new Set();
const chunkStatsBySession = new Map();
const providerStateBySession = new Map();
const transcriptDraftStateBySession = new Map();

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Headers",
    [
      "Content-Type",
      "x-audio-chunk-id",
      "x-audio-sequence",
      "x-audio-encoding",
      "x-audio-sample-rate",
      "x-audio-channels",
      "x-audio-duration-ms",
      "x-audio-final",
      "x-source-language",
      "x-target-languages",
      "x-transcript-hint"
    ].join(", ")
  );
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function sendJson(response, statusCode, payload) {
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readBuffer(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function badRequest(response, error) {
  sendJson(response, error.statusCode ?? 400, {
    error: error.errorCode ?? "bad_request",
    detail: error instanceof Error ? error.message : String(error)
  });
}

function httpError(statusCode, errorCode, detail) {
  const error = new Error(detail);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function ensureSubscribers(sessionId) {
  let subscribers = subscribersBySession.get(sessionId);

  if (!subscribers) {
    subscribers = new Set();
    subscribersBySession.set(sessionId, subscribers);
  }

  return subscribers;
}

function ensureChunkStats(sessionId) {
  let stats = chunkStatsBySession.get(sessionId);

  if (!stats) {
    stats = {
      totalChunksReceived: 0,
      totalBytesReceived: 0,
      lastSequence: 0
    };
    chunkStatsBySession.set(sessionId, stats);
  }

  return stats;
}

function writeEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(sessionId, event) {
  const subscribers = subscribersBySession.get(sessionId);

  if (!subscribers) {
    return;
  }

  for (const subscriber of subscribers) {
    writeEvent(subscriber, event);
  }
}

function eventEnvelope(type, sessionId, payload) {
  return {
    type,
    sessionId,
    emittedAt: new Date().toISOString(),
    payload
  };
}

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

function normalizeTargetLanguages(rawValue) {
  return String(rawValue ?? "zh-CN")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeSourceLanguage(value, fallback = "en") {
  const normalized = String(value ?? fallback).trim();
  return normalized || fallback;
}

function detectLanguageFromText(text) {
  const sample = String(text ?? "").trim();

  if (!sample) {
    return null;
  }

  if (/[\u3040-\u30ff]/.test(sample)) {
    return "ja";
  }

  if (/[\uac00-\ud7af]/.test(sample)) {
    return "ko";
  }

  if (/[\u0400-\u04ff]/.test(sample)) {
    return "ru";
  }

  if (/[\u0600-\u06ff]/.test(sample)) {
    return "ar";
  }

  if (/[\u0900-\u097f]/.test(sample)) {
    return "hi";
  }

  if (/[\u4e00-\u9fff]/.test(sample)) {
    return "zh";
  }

  if (/[A-Za-z]/.test(sample)) {
    return "en";
  }

  return null;
}

function resolveSegmentSourceLanguage(requestedSourceLanguage, text, fallback = "en") {
  const sourceLanguage = normalizeSourceLanguage(requestedSourceLanguage, fallback);

  if (sourceLanguage !== "auto") {
    return sourceLanguage;
  }

  return detectLanguageFromText(text) ?? fallback;
}

function parseAudioChunkMetadata(sessionId, request, body) {
  const chunkId = request.headers["x-audio-chunk-id"] ?? randomUUID();
  const sequence = parseIntegerHeader(request.headers["x-audio-sequence"], 1);
  const encoding = request.headers["x-audio-encoding"] ?? "unknown";
  const sampleRateHz = parseIntegerHeader(request.headers["x-audio-sample-rate"], 16000);
  const channels = parseIntegerHeader(request.headers["x-audio-channels"], 1);
  const durationMs = parseIntegerHeader(request.headers["x-audio-duration-ms"], undefined);
  const sourceLanguage = normalizeSourceLanguage(request.headers["x-source-language"], "en");
  const targetLanguages = normalizeTargetLanguages(request.headers["x-target-languages"]);
  const transcriptHint = request.headers["x-transcript-hint"];
  const isFinalChunk = parseBooleanHeader(request.headers["x-audio-final"]);

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

function nextSequence(sessionId) {
  const current = sequenceBySession.get(sessionId) ?? 0;
  const next = current + 1;
  sequenceBySession.set(sessionId, next);
  return next;
}

function nextTiming(sessionId, wordCount) {
  const startMs = offsetBySession.get(sessionId) ?? 0;
  const durationMs = Math.max(900, wordCount * 260);
  const endMs = startMs + durationMs;
  offsetBySession.set(sessionId, endMs + 280);
  return {
    startMs,
    endMs
  };
}

function mockTranslate(text, targetLanguage) {
  const dictionaries = {
    "zh-CN": {
      hello: "你好",
      roadmap: "路线图",
      action: "行动项",
      meeting: "会议",
      transcript: "转录",
      translation: "翻译",
      customer: "客户",
      launch: "上线",
      summary: "摘要"
    }
  };
  const dictionary = dictionaries[targetLanguage];

  if (!dictionary) {
    return `[${targetLanguage}] ${text}`;
  }

  const translated = text
    .split(/\s+/)
    .map((token) => {
      const normalized = token.toLowerCase().replace(/[^a-z-]/g, "");
      return dictionary[normalized] ?? token;
    })
    .join(" ");

  return `[${targetLanguage}] ${translated}`;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${detail}`);
  }

  return response.json();
}

async function syncSessionStatus(sessionId, action) {
  try {
    await postJson(`${TRANSCRIPT_API_BASE_URL}/sessions/${sessionId}/${action}`, {});
    return true;
  } catch (error) {
    console.warn(`[session-gateway] failed to sync session ${action}`, error instanceof Error ? error.message : error);
    return false;
  }
}

async function ensureLiveSession(sessionId) {
  if (liveSessionIds.has(sessionId)) {
    return;
  }

  const started = await syncSessionStatus(sessionId, "start");

  if (!started) {
    throw httpError(404, "session_not_found", `Unable to start session ${sessionId}.`);
  }

  liveSessionIds.add(sessionId);
  broadcast(sessionId, eventEnvelope("session.status_changed", sessionId, {
    id: sessionId,
    status: "live"
  }));
}

function getProviderSessionState(provider, sessionId) {
  let sessionState = providerStateBySession.get(sessionId);

  if (!sessionState) {
    sessionState = createAsrProviderSessionState(provider, sessionId);
    providerStateBySession.set(sessionId, sessionState);
  }

  return sessionState;
}

async function persistFinalArtifacts(sessionId, segment, targetLanguages) {
  try {
    await postJson(`${TRANSCRIPT_API_BASE_URL}/sessions/${sessionId}/segments`, segment);

    for (const targetLanguage of targetLanguages) {
      const translation = {
        segmentId: segment.segmentId,
        targetLanguage,
        text: mockTranslate(segment.text, targetLanguage),
        provider: "mock-translate",
        isFinal: true
      };

      await postJson(`${TRANSCRIPT_API_BASE_URL}/sessions/${sessionId}/translations`, translation);
      broadcast(sessionId, eventEnvelope("translation.upserted", sessionId, translation));
    }
  } catch (error) {
    console.warn("[session-gateway] failed to persist final artifacts", error instanceof Error ? error.message : error);
  }
}

async function persistTranslationArtifact(sessionId, translation) {
  try {
    await postJson(`${TRANSCRIPT_API_BASE_URL}/sessions/${sessionId}/translations`, translation);
  } catch (error) {
    console.warn("[session-gateway] failed to persist translation artifact", error instanceof Error ? error.message : error);
  }
}

function ensureTranscriptDraftState(sessionId) {
  let state = transcriptDraftStateBySession.get(sessionId);

  if (!state) {
    state = {
      byProviderSequence: new Map(),
      audioBuildersBySequence: new Map(),
      emittedTextByKey: new Map()
    };
    transcriptDraftStateBySession.set(sessionId, state);
  }

  return state;
}

function normalizeDraftText(value) {
  return String(value ?? "").trim();
}

function progressiveDraftEvents(previousText, nextText, status) {
  const normalizedNext = normalizeDraftText(nextText);
  if (!normalizedNext) {
    return [];
  }

  const normalizedPrevious = normalizeDraftText(previousText);
  const alignedPrevious = normalizedNext.startsWith(normalizedPrevious) ? normalizedPrevious : "";

  if (status === "final" && alignedPrevious === normalizedNext) {
    return [{
      text: normalizedNext,
      status: "final"
    }];
  }

  const startIndex = alignedPrevious.length;
  const deltaLength = normalizedNext.length - startIndex;
  if (deltaLength <= 0) {
    return [];
  }

  const step = Math.max(1, Math.ceil(deltaLength / 4));
  const events = [];

  for (let cursor = startIndex + step; cursor < normalizedNext.length; cursor += step) {
    events.push({
      text: normalizedNext.slice(0, cursor),
      status: "partial"
    });
  }

  events.push({
    text: normalizedNext,
    status: status === "final" ? "final" : "partial"
  });

  return events;
}

function ensureSegmentRecord(sessionId, draft, input) {
  const transcriptState = ensureTranscriptDraftState(sessionId);
  const providerSequence = draft.sequenceHint ?? `${draft.channel ?? "source"}:${draft.providerMessageType ?? "default"}`;
  let record = transcriptState.byProviderSequence.get(providerSequence);

  if (!record) {
    const estimatedText = String(input.estimatedText ?? draft.text ?? "").trim() || "pending";
    const words = estimatedText.split(/\s+/);
    record = {
      providerSequence,
      segmentId: randomUUID(),
      sequence: nextSequence(sessionId),
      timing: nextTiming(sessionId, words.length)
    };
    transcriptState.byProviderSequence.set(providerSequence, record);
  }

  return record;
}

async function persistAudioClipArtifact(sessionId, audioClip) {
  try {
    const persistedAudioClip = await postJson(`${TRANSCRIPT_API_BASE_URL}/sessions/${sessionId}/audio-clips`, audioClip);
    broadcast(sessionId, eventEnvelope("audio.clip_received", sessionId, persistedAudioClip));
  } catch (error) {
    console.warn("[session-gateway] failed to persist audio clip artifact", error instanceof Error ? error.message : error);
  }
}

async function emitTranscriptDrafts(sessionId, input, drafts) {
  const requestedSourceLanguage = normalizeSourceLanguage(input.sourceLanguage, "en");
  const targetLanguages = Array.isArray(input.targetLanguages) && input.targetLanguages.length > 0
    ? input.targetLanguages
    : ["zh-CN"];
  let usingStructuredDrafts = false;
  let segmentId = null;
  let sequence = null;
  let timing = null;
  let finalSegment = null;

  for await (const draft of drafts) {
    if (draft.kind === "audio_start") {
      const transcriptState = ensureTranscriptDraftState(sessionId);
      const record = ensureSegmentRecord(sessionId, {
        ...draft,
        channel: "translation"
      }, input);
      transcriptState.audioBuildersBySequence.set(record.providerSequence, {
        segmentId: record.segmentId,
        sequence: record.sequence,
        targetLanguage: targetLanguages[0] ?? "en",
        provider: draft.provider,
        format: draft.format ?? "ogg_opus",
        mimeType: draft.mimeType ?? "audio/ogg; codecs=opus",
        chunks: [],
        createdAt: new Date().toISOString()
      });
      continue;
    }

    if (draft.kind === "audio_chunk") {
      const transcriptState = ensureTranscriptDraftState(sessionId);
      const record = ensureSegmentRecord(sessionId, {
        ...draft,
        channel: "translation"
      }, input);
      const builder = transcriptState.audioBuildersBySequence.get(record.providerSequence)
        ?? {
          segmentId: record.segmentId,
          sequence: record.sequence,
          targetLanguage: targetLanguages[0] ?? "en",
          provider: draft.provider,
          format: draft.format ?? "ogg_opus",
          mimeType: draft.mimeType ?? "audio/ogg; codecs=opus",
          chunks: [],
          createdAt: new Date().toISOString()
        };
      builder.chunks.push(Buffer.from(draft.audioData ?? []));
      transcriptState.audioBuildersBySequence.set(record.providerSequence, builder);
      continue;
    }

    if (draft.kind === "audio_end") {
      const transcriptState = ensureTranscriptDraftState(sessionId);
      const record = ensureSegmentRecord(sessionId, {
        ...draft,
        channel: "translation"
      }, input);
      const builder = transcriptState.audioBuildersBySequence.get(record.providerSequence);

      if (builder && builder.chunks.length > 0) {
        const audioBuffer = Buffer.concat(builder.chunks);
        await persistAudioClipArtifact(sessionId, {
          segmentId: builder.segmentId,
          sequence: builder.sequence,
          targetLanguage: builder.targetLanguage,
          provider: builder.provider,
          format: builder.format,
          mimeType: builder.mimeType,
          byteLength: audioBuffer.length,
          dataBase64: audioBuffer.toString("base64"),
          createdAt: builder.createdAt
        });
      }

      transcriptState.audioBuildersBySequence.delete(record.providerSequence);
      continue;
    }

    if (draft.channel === "translation") {
      usingStructuredDrafts = true;
      const record = ensureSegmentRecord(sessionId, draft, input);
      const transcriptState = ensureTranscriptDraftState(sessionId);
      const targetLanguage = targetLanguages[0] ?? "en";
      const progressKey = `translation:${record.segmentId}:${targetLanguage}`;
      const previousText = transcriptState.emittedTextByKey.get(progressKey) ?? "";
      const updates = progressiveDraftEvents(previousText, draft.text, draft.status);

      for (const update of updates) {
        const translation = {
          segmentId: record.segmentId,
          targetLanguage,
          text: update.text,
          provider: draft.provider,
          isFinal: update.status === "final"
        };

        broadcast(sessionId, eventEnvelope("translation.upserted", sessionId, translation));

        if (translation.isFinal) {
          await persistTranslationArtifact(sessionId, translation);
        }
      }

      transcriptState.emittedTextByKey.set(progressKey, normalizeDraftText(draft.text));

      continue;
    }

    if (draft.kind === "transcript" && (draft.channel || draft.sequenceHint !== undefined)) {
      usingStructuredDrafts = true;
      const record = ensureSegmentRecord(sessionId, draft, input);
      const transcriptState = ensureTranscriptDraftState(sessionId);
      const progressKey = `segment:${record.segmentId}`;
      const previousText = transcriptState.emittedTextByKey.get(progressKey) ?? "";
      const updates = progressiveDraftEvents(previousText, draft.text, draft.status);

      for (const update of updates) {
        const segment = {
          segmentId: record.segmentId,
          sessionId,
          sequence: record.sequence,
          status: update.status,
          sourceLanguage: resolveSegmentSourceLanguage(requestedSourceLanguage, update.text),
          startMs: record.timing.startMs,
          endMs: record.timing.endMs,
          text: update.text,
          confidence: draft.confidence,
          speakerId: undefined,
          provider: draft.provider,
          glossaryHits: [],
          receivedAt: new Date().toISOString()
        };

        broadcast(sessionId, eventEnvelope("segment.upserted", sessionId, segment));

        if (update.status === "final") {
          finalSegment = segment;
          await persistFinalArtifacts(sessionId, segment, []);
        }
      }

      transcriptState.emittedTextByKey.set(progressKey, normalizeDraftText(draft.text));

      continue;
    }

    if (!segmentId || !timing) {
      const estimatedText = String(input.estimatedText ?? draft.text ?? "").trim();

      if (!estimatedText) {
        throw new Error("estimatedText is required when provider emits transcript drafts.");
      }

      const words = estimatedText.split(/\s+/);
      segmentId = randomUUID();
      sequence = nextSequence(sessionId);
      timing = nextTiming(sessionId, words.length);
    }

    const transcriptState = ensureTranscriptDraftState(sessionId);
    const progressKey = `segment:${segmentId}`;
    const previousText = transcriptState.emittedTextByKey.get(progressKey) ?? "";
    const updates = progressiveDraftEvents(previousText, draft.text, draft.status);

    for (const update of updates) {
      const segment = {
        segmentId,
        sessionId,
        sequence,
        status: update.status,
        sourceLanguage: resolveSegmentSourceLanguage(requestedSourceLanguage, update.text),
        startMs: timing.startMs,
        endMs: timing.endMs,
        text: update.text,
        confidence: draft.confidence,
        speakerId: undefined,
        provider: draft.provider,
        glossaryHits: [],
        receivedAt: new Date().toISOString()
      };

      broadcast(sessionId, eventEnvelope("segment.upserted", sessionId, segment));

      if (!draft.channel) {
        for (const targetLanguage of targetLanguages) {
          const translationKey = `translation:${segmentId}:${targetLanguage}`;
          const previousTranslationText = transcriptState.emittedTextByKey.get(translationKey) ?? "";
          const nextTranslationText = mockTranslate(update.text, targetLanguage);
          const translationUpdates = progressiveDraftEvents(previousTranslationText, nextTranslationText, update.status);

          for (const translationUpdate of translationUpdates) {
            broadcast(sessionId, eventEnvelope("translation.upserted", sessionId, {
              segmentId,
              targetLanguage,
              text: translationUpdate.text,
              provider: "mock-translate",
              isFinal: translationUpdate.status === "final"
            }));
          }

          transcriptState.emittedTextByKey.set(translationKey, normalizeDraftText(nextTranslationText));
        }
      }

      if (update.status === "final") {
        finalSegment = segment;
      }
    }

    transcriptState.emittedTextByKey.set(progressKey, normalizeDraftText(draft.text));
  }

  if (finalSegment && !usingStructuredDrafts) {
    await persistFinalArtifacts(sessionId, finalSegment, targetLanguages);
  }

  return finalSegment;
}

async function ingestAudioChunk(provider, sessionId, request) {
  const body = await readBuffer(request);
  const metadata = parseAudioChunkMetadata(sessionId, request, body);
  const stats = ensureChunkStats(sessionId);

  if (metadata.sequence < 1) {
    throw httpError(400, "invalid_audio_sequence", "x-audio-sequence must be greater than or equal to 1.");
  }

  if (metadata.sampleRateHz < 8_000 || metadata.sampleRateHz > 192_000) {
    throw httpError(400, "invalid_audio_sample_rate", "x-audio-sample-rate must be between 8000 and 192000.");
  }

  if (metadata.channels < 1 || metadata.channels > 8) {
    throw httpError(400, "invalid_audio_channels", "x-audio-channels must be between 1 and 8.");
  }

  if (metadata.byteLength > MAX_AUDIO_CHUNK_BYTES) {
    throw httpError(413, "audio_chunk_too_large", `Audio chunk exceeds ${MAX_AUDIO_CHUNK_BYTES} bytes.`);
  }

  if (!metadata.byteLength && !metadata.isFinalChunk) {
    throw httpError(400, "empty_audio_chunk", "Audio chunk body cannot be empty unless it is a finalization chunk.");
  }

  if (metadata.transcriptHint && metadata.transcriptHint.length > MAX_TRANSCRIPT_HINT_CHARS) {
    throw httpError(400, "transcript_hint_too_large", `x-transcript-hint must be shorter than ${MAX_TRANSCRIPT_HINT_CHARS} characters.`);
  }

  if (stats.lastSequence > 0 && metadata.sequence <= stats.lastSequence) {
    throw httpError(409, "audio_sequence_conflict", "x-audio-sequence must be strictly increasing within a session.");
  }

  stats.totalChunksReceived += 1;
  stats.totalBytesReceived += body.length;
  stats.lastSequence = metadata.sequence;

  await ensureLiveSession(sessionId);

  if (ENABLE_AUDIO_CHUNK_EVENTS) {
    broadcast(sessionId, eventEnvelope("audio.chunk_received", sessionId, metadata));
  }

  const sessionState = getProviderSessionState(provider, sessionId);
  const segment = await emitTranscriptDrafts(sessionId, {
    estimatedText: metadata.transcriptHint,
    sourceLanguage: metadata.sourceLanguage,
    targetLanguages: metadata.targetLanguages
  }, provider.transcribeAudioChunk({
    sessionId,
    metadata,
    body,
    sessionState
  }));

  return {
    accepted: true,
    sessionId,
    chunkId: metadata.chunkId,
    sequence: metadata.sequence,
    byteLength: metadata.byteLength,
    totalChunksReceived: stats.totalChunksReceived,
    totalBytesReceived: stats.totalBytesReceived,
    transcriptAccepted: Boolean(segment)
  };
}

function openEventStream(sessionId, response) {
  setCorsHeaders(response);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  response.write(": connected\n\n");

  const subscribers = ensureSubscribers(sessionId);
  subscribers.add(response);

  const keepAliveTimer = setInterval(() => {
    response.write(": keep-alive\n\n");
  }, 15000);

  response.on("close", () => {
    clearInterval(keepAliveTimer);
    subscribers.delete(response);

    if (subscribers.size === 0) {
      subscribersBySession.delete(sessionId);
    }
  });
}

async function routeRequest(provider, request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "session-gateway",
      asrProvider: provider.name,
      providerId: provider.providerId,
      activeProvider: provider.activeProviderName ?? provider.name,
      fallbackProvider: provider.fallbackProviderName ?? null,
      startupError: provider.startupError ?? null
    });
    return;
  }

  const streamMatch = pathname.match(/^\/sessions\/([^/]+)\/stream$/);

  if (request.method === "GET" && streamMatch) {
    openEventStream(streamMatch[1], response);
    return;
  }

  const ingestMatch = pathname.match(/^\/sessions\/([^/]+)\/ingest-text$/);

  if (request.method === "POST" && ingestMatch) {
    try {
      const sessionId = ingestMatch[1];
      const body = await readJson(request);
      await ensureLiveSession(sessionId);
      const sessionState = getProviderSessionState(provider, sessionId);
      const segment = await emitTranscriptDrafts(sessionId, {
        estimatedText: body.text,
        sourceLanguage: body.sourceLanguage,
        targetLanguages: body.targetLanguages
      }, provider.transcribeText({
        sessionId,
        text: body.text,
        sourceLanguage: body.sourceLanguage,
        targetLanguages: body.targetLanguages,
        sessionState
      }));

      if (!segment) {
        throw new Error(`ASR provider "${provider.name}" did not emit a final transcript for text ingest.`);
      }

      sendJson(response, 202, {
        accepted: true,
        sessionId,
        segmentId: segment.segmentId,
        sequence: segment.sequence
      });
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  const audioChunkMatch = pathname.match(/^\/sessions\/([^/]+)\/audio-chunks$/);

  if (request.method === "POST" && audioChunkMatch) {
    try {
      const result = await ingestAudioChunk(provider, audioChunkMatch[1], request);
      sendJson(response, 202, result);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  const stopMatch = pathname.match(/^\/sessions\/([^/]+)\/stop$/);

  if (request.method === "POST" && stopMatch) {
    const sessionId = stopMatch[1];
    await syncSessionStatus(sessionId, "stop");
    liveSessionIds.delete(sessionId);
    chunkStatsBySession.delete(sessionId);
    sequenceBySession.delete(sessionId);
    offsetBySession.delete(sessionId);
    transcriptDraftStateBySession.delete(sessionId);
    const sessionState = providerStateBySession.get(sessionId);
    providerStateBySession.delete(sessionId);
    await disposeAsrProviderSessionState(provider, sessionState);
    broadcast(sessionId, eventEnvelope("session.status_changed", sessionId, {
      id: sessionId,
      status: "completed"
    }));
    sendJson(response, 200, {
      ok: true,
      sessionId
    });
    return;
  }

  sendJson(response, 404, {
    error: "not_found"
  });
}

export function createSessionGatewayServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.SESSION_GATEWAY_PORT ?? 3010);
  let provider = null;
  const server = http.createServer((request, response) => {
    routeRequest(provider, request, response).catch((error) => {
      sendJson(response, 500, {
        error: error.errorCode ?? "internal_error",
        detail: error instanceof Error ? error.message : String(error)
      });
    });
  });

  return {
    server,
    async start() {
      if (!provider) {
        if (options.asrProvider && typeof options.asrProvider === "object") {
          provider = options.asrProvider;
        } else {
          provider = await createAsrProvider({
            ...options,
            providerName: typeof options.asrProvider === "string"
              ? options.asrProvider
              : options.providerName
          });
        }
      }

      return new Promise((resolve) => {
        server.listen(port, host, () => {
          resolve({
            host,
            port
          });
        });
      });
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const app = createSessionGatewayServer();
  const { host, port } = await app.start();
  console.log(`[session-gateway] listening on http://${host}:${port}`);
}
