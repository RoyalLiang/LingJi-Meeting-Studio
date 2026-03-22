import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { resolveDoubaoAstCodec } from "./doubao-ast-codec.mjs";

const DOUBAO_AST_BASE_URL = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
const DOUBAO_AST_RESOURCE_ID = "volc.service_type.10053";
const KEEP_ALIVE_INTERVAL_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const PARTIAL_DRAIN_WAIT_MS = Number(process.env.DOUBAO_AST_PARTIAL_DRAIN_WAIT_MS ?? 180);
const FINAL_DRAIN_WAIT_MS = Number(process.env.DOUBAO_AST_FINAL_DRAIN_WAIT_MS ?? 3_000);
const SUPPORTED_LANGUAGES = new Set([
  "zh",
  "en",
  "ja",
  "id",
  "es",
  "pt",
  "de",
  "fr",
  "zhen"
]);
const SUPPORTED_MODES = new Set(["s2t", "s2s"]);

function providerError(errorCode, detail) {
  const error = new Error(detail);
  error.statusCode = 500;
  error.errorCode = errorCode;
  return error;
}

function createDeferred() {
  let resolve;
  let reject;

  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject
  };
}

function normalizeLanguage(name, value, fallback = null) {
  const requested = String(value ?? "").trim();
  const normalized = requested === "auto"
    ? String(fallback ?? "").trim()
    : String(value ?? fallback ?? "").trim();

  if (!normalized) {
    throw providerError(
      `missing_doubao_ast_${name}`,
      `Doubao AST provider requires ${name}.`
    );
  }

  if (!SUPPORTED_LANGUAGES.has(normalized)) {
    throw providerError(
      `invalid_doubao_ast_${name}`,
      `Doubao AST ${name} "${normalized}" is not supported by the configured adapter.`
    );
  }

  return normalized;
}

function normalizeMode(value) {
  const mode = String(value ?? "s2t").trim();

  if (!SUPPORTED_MODES.has(mode)) {
    throw providerError(
      "invalid_doubao_ast_mode",
      `Doubao AST mode "${mode}" is invalid. Supported modes: s2t, s2s.`
    );
  }

  return mode;
}

function normalizeAudioMetadata(metadata) {
  const encoding = String(metadata.encoding ?? "").trim().toLowerCase();

  if (!["wav", "pcm_s16le", "raw"].includes(encoding)) {
    throw providerError(
      "unsupported_doubao_ast_audio_encoding",
      `Doubao AST provider expects wav/raw/pcm_s16le input. Received "${metadata.encoding}".`
    );
  }

  if (Number(metadata.sampleRateHz) !== 16000) {
    throw providerError(
      "invalid_doubao_ast_sample_rate",
      "Doubao AST provider currently expects 16k sample rate input."
    );
  }

  if (Number(metadata.channels) !== 1) {
    throw providerError(
      "invalid_doubao_ast_channel_count",
      "Doubao AST provider currently expects mono input."
    );
  }

  return {
    format: encoding === "pcm_s16le" ? "raw" : encoding,
    rate: 16000,
    channel: 1,
    bits: 16
  };
}

function buildHeaders(config) {
  const headers = {
    "X-Api-App-Key": config.appKey,
    "X-Api-Access-Key": config.accessKey,
    "X-Api-Resource-Id": config.resourceId
  };

  if (config.appId) {
    headers["X-Api-App-Id"] = config.appId;
  }

  if (config.connectionId) {
    headers["X-Api-Connect-Id"] = config.connectionId;
  }

  return headers;
}

function buildRequestMeta(sessionState) {
  return {
    Endpoint: sessionState?.endpoint,
    AppKey: sessionState?.appKey,
    AppID: sessionState?.appId,
    ResourceID: sessionState?.resourceId,
    ConnectionID: sessionState?.connectionId,
    SessionID: sessionState?.remoteSessionId ?? sessionState?.sessionId ?? null,
    Sequence: sessionState?.sequence ?? 0
  };
}

function buildRequestConfig(config, input) {
  return {
    mode: config.mode,
    sourceLanguage: normalizeLanguage("source_language", input.metadata?.sourceLanguage, config.sourceLanguage),
    targetLanguage: normalizeLanguage("target_language", input.metadata?.targetLanguages?.[0], config.targetLanguage),
    corpus: {
      correcting: true
    }
  };
}

function buildStartSessionPayload(config, input) {
  return {
    requestMeta: {
      Endpoint: config.endpoint,
      AppKey: config.appKey,
      AppID: config.appId,
      ResourceID: config.resourceId,
      ConnectionID: config.connectionId,
      SessionID: input.sessionId
    },
    user: {
      uid: input.sessionId
    },
    sourceAudio: normalizeAudioMetadata(input.metadata),
    targetAudio: config.mode === "s2s"
      ? {
          format: "ogg_opus",
          rate: 48000
        }
      : undefined,
    request: buildRequestConfig(config, input),
    denoise: false
  };
}

function buildUpdateConfigPayload(config, input, sessionState) {
  return {
    requestMeta: buildRequestMeta(sessionState),
    request: buildRequestConfig(config, input)
  };
}

function buildTaskRequestPayload(config, input, sessionState) {
  return {
    requestMeta: buildRequestMeta(sessionState),
    sourceAudio: {
      ...normalizeAudioMetadata(input.metadata),
      binaryData: input.body
    }
  };
}

function buildFinishSessionPayload(sessionState) {
  return {
    requestMeta: buildRequestMeta(sessionState)
  };
}

function normalizeDraftFromCodecMessage(message, providerName) {
  const eventCode = Number(message?.event ?? message?.event_code ?? message?.type ?? 0);
  const sequenceHint = message?.responseMeta?.Sequence ?? message?.response_meta?.sequence;

  if (eventCode === 153) {
    throw providerError(
      "doubao_ast_session_failed",
      message?.responseMeta?.Message
        ?? message?.message
        ?? message?.error_message
        ?? "Doubao AST session failed."
    );
  }

  if ([150, 154].includes(eventCode)) {
    return null;
  }

  if (eventCode === 350) {
    return {
      kind: "audio_start",
      provider: providerName,
      sequenceHint
    };
  }

  if (eventCode === 352) {
    return {
      kind: "audio_chunk",
      provider: providerName,
      sequenceHint,
      format: "ogg_opus",
      mimeType: "audio/ogg; codecs=opus",
      audioData: message.data
    };
  }

  if (eventCode === 351) {
    return {
      kind: "audio_end",
      provider: providerName,
      sequenceHint
    };
  }

  if (![651, 652, 654, 655].includes(eventCode)) {
    return null;
  }

  const payload = message.payload ?? message.data ?? message;
  const text = String(
    payload?.text
      ?? payload?.subtitle
      ?? payload?.content
      ?? payload?.utterance
      ?? ""
  ).trim();

  if (!text) {
    return null;
  }

  return {
    kind: "transcript",
    status: [652, 655].includes(eventCode) ? "final" : "partial",
    text,
    confidence: payload?.confidence ?? message?.confidence,
    provider: providerName,
    providerMessageType: eventCode,
    channel: [651, 652].includes(eventCode) ? "source" : "translation",
    sequenceHint
  };
}

function pushDecodedMessage(sessionState, decodedMessage) {
  sessionState.pendingMessages.push(decodedMessage);
  sessionState.waiters.splice(0).forEach((waiter) => waiter.resolve());
}

function flushWaiters(sessionState) {
  sessionState.waiters.splice(0).forEach((waiter) => waiter.resolve());
}

function setSessionError(sessionState, error) {
  sessionState.lastError = error;
  sessionState.waiters.splice(0).forEach((waiter) => waiter.reject(error));
}

function startKeepAlive(sessionState) {
  sessionState.keepAliveTimer = setInterval(() => {
    if (sessionState.socket?.readyState === WebSocket.OPEN) {
      try {
        sessionState.socket.ping();
      } catch {
        return;
      }
    }
  }, KEEP_ALIVE_INTERVAL_MS);
}

function stopKeepAlive(sessionState) {
  if (sessionState.keepAliveTimer) {
    clearInterval(sessionState.keepAliveTimer);
    sessionState.keepAliveTimer = null;
  }
}

async function ensureConnection(config, sessionState, input) {
  if (sessionState.lastError) {
    throw sessionState.lastError;
  }

  if (sessionState.socket?.readyState === WebSocket.OPEN) {
    return sessionState.socket;
  }

  if (sessionState.connectingPromise) {
    await sessionState.connectingPromise;
    return sessionState.socket;
  }

  const deferred = createDeferred();
  const ws = new WebSocket(config.baseUrl, {
    headers: buildHeaders(config)
  });

  sessionState.connectingPromise = deferred.promise;
  sessionState.socket = ws;
  sessionState.pendingMessages = [];
  sessionState.waiters = [];
  sessionState.closed = false;
  sessionState.lastError = null;
  sessionState.handshakeComplete = false;
  const handshakeTimer = setTimeout(() => {
    const error = providerError(
      "doubao_ast_handshake_timeout",
      "Timed out waiting for Doubao AST SessionStarted response."
    );
    setSessionError(sessionState, error);
    deferred.reject(error);
    try {
      ws.close(1011, "handshake timeout");
    } catch {
      return;
    }
  }, HANDSHAKE_TIMEOUT_MS);

  ws.once("open", async () => {
    try {
      startKeepAlive(sessionState);
      ws.send(config.codec.encodeStartSession(buildStartSessionPayload(config, input)));
    } catch (error) {
      clearTimeout(handshakeTimer);
      const wrappedError = providerError(
        "doubao_ast_session_init_failed",
        error instanceof Error ? error.message : String(error)
      );
      setSessionError(sessionState, wrappedError);
      deferred.reject(wrappedError);
    }
  });

  ws.on("message", (payload) => {
    try {
      const decoded = config.codec.decodeMessage(payload);

      if (!decoded || typeof decoded !== "object") {
        return;
      }

      if (Number(decoded.event ?? decoded.event_code ?? 0) === 150) {
        clearTimeout(handshakeTimer);
        sessionState.remoteSessionId = decoded?.response_meta?.session_id
          ?? decoded.session_id
          ?? decoded.sessionId
          ?? sessionState.remoteSessionId
          ?? null;
        if (!sessionState.handshakeComplete) {
          sessionState.handshakeComplete = true;
          deferred.resolve();
        }
      }

      pushDecodedMessage(sessionState, decoded);
    } catch (error) {
      setSessionError(
        sessionState,
        providerError(
          "doubao_ast_decode_failed",
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  });

  ws.once("close", (code, reasonBuffer) => {
    clearTimeout(handshakeTimer);
    stopKeepAlive(sessionState);
    sessionState.closed = true;
    sessionState.socket = null;
    sessionState.connectingPromise = null;

    if (code !== 1000 && !sessionState.lastError) {
      setSessionError(
        sessionState,
        providerError(
          "doubao_ast_socket_closed",
          `Doubao AST socket closed unexpectedly (${code}): ${reasonBuffer.toString("utf8") || "no reason"}`
        )
      );
      return;
    }

    flushWaiters(sessionState);
  });

  ws.once("error", (error) => {
    clearTimeout(handshakeTimer);
    stopKeepAlive(sessionState);
    sessionState.socket = null;
    sessionState.connectingPromise = null;
    const wrappedError = providerError(
      "doubao_ast_connection_failed",
      error instanceof Error ? error.message : String(error)
    );
    setSessionError(sessionState, wrappedError);
    deferred.reject(wrappedError);
  });

  try {
    await deferred.promise;
    return ws;
  } finally {
    sessionState.connectingPromise = null;
  }
}

async function waitForMessages(sessionState, timeoutMs) {
  if (sessionState.lastError) {
    throw sessionState.lastError;
  }

  if (sessionState.pendingMessages.length > 0 || sessionState.closed) {
    return;
  }

  const deferred = createDeferred();
  sessionState.waiters.push(deferred);

  try {
    await Promise.race([
      deferred.promise,
      delay(timeoutMs)
    ]);
  } finally {
    sessionState.waiters = sessionState.waiters.filter((waiter) => waiter !== deferred);
  }
}

async function collectDrafts(config, sessionState, options = {}) {
  const drafts = [];
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    while (sessionState.pendingMessages.length > 0) {
      const decodedMessage = sessionState.pendingMessages.shift();
      const draft = normalizeDraftFromCodecMessage(decodedMessage, config.providerName);

      if (!draft) {
        continue;
      }

      drafts.push(draft);

      if (options.requireFinal && draft.status === "final") {
        return drafts;
      }
    }

    if (sessionState.closed && !options.requireFinal) {
      break;
    }

    await waitForMessages(sessionState, Math.max(1, deadline - Date.now()));
  }

  return drafts;
}

async function sendTaskRequest(config, sessionState, input) {
  const socket = await ensureConnection(config, sessionState, input);
  sessionState.sequence += 1;

  socket.send(config.codec.encodeTaskRequest(buildTaskRequestPayload(config, input, sessionState)));
}

async function finishSession(config, sessionState) {
  if (sessionState.socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  sessionState.socket.send(config.codec.encodeFinishSession(buildFinishSessionPayload(sessionState)));
}

async function closeConnection(sessionState) {
  if (!sessionState) {
    return;
  }

  if (sessionState.socket?.readyState !== WebSocket.OPEN) {
    stopKeepAlive(sessionState);
    return;
  }

  try {
    sessionState.socket.close(1000, "client shutdown");
    await Promise.race([
      new Promise((resolve) => {
        sessionState.socket.once("close", resolve);
      }),
      delay(1_000)
    ]);
  } finally {
    stopKeepAlive(sessionState);
  }
}

function readProviderConfig(options = {}) {
  const appId = options.appId ?? options.doubaoAstAppId ?? process.env.DOUBAO_AST_APP_ID;
  const appKey = options.appKey
    ?? options.doubaoAstAppKey
    ?? options.secret
    ?? options.doubaoAstSecret
    ?? process.env.DOUBAO_AST_APP_KEY
    ?? process.env.DOUBAO_AST_SECRET;
  const accessKey = options.accessKey
    ?? options.doubaoAstAccessKey
    ?? options.accessToken
    ?? options.doubaoAstAccessToken
    ?? process.env.DOUBAO_AST_ACCESS_KEY
    ?? process.env.DOUBAO_AST_ACCESS_TOKEN;

  if (!appKey) {
    throw providerError("missing_doubao_ast_app_key", "Doubao AST provider requires DOUBAO_AST_APP_KEY or DOUBAO_AST_SECRET.");
  }

  if (!accessKey) {
    throw providerError("missing_doubao_ast_access_key", "Doubao AST provider requires DOUBAO_AST_ACCESS_KEY or DOUBAO_AST_ACCESS_TOKEN.");
  }

  return {
    providerName: "doubao-ast",
    appId: appId ? String(appId) : undefined,
    appKey: String(appKey),
    accessKey: String(accessKey),
    resourceId: options.resourceId ?? options.doubaoAstResourceId ?? process.env.DOUBAO_AST_RESOURCE_ID ?? DOUBAO_AST_RESOURCE_ID,
    baseUrl: options.baseUrl ?? options.doubaoAstBaseUrl ?? process.env.DOUBAO_AST_BASE_URL ?? DOUBAO_AST_BASE_URL,
    endpoint: options.endpoint ?? options.doubaoAstEndpoint ?? process.env.DOUBAO_AST_ENDPOINT ?? "v4/ast/v2/translate",
    sourceLanguage: normalizeLanguage("source_language", options.sourceLanguage ?? options.doubaoAstSourceLanguage ?? process.env.DOUBAO_AST_SOURCE_LANGUAGE, "zh"),
    targetLanguage: normalizeLanguage("target_language", options.targetLanguage ?? options.doubaoAstTargetLanguage ?? process.env.DOUBAO_AST_TARGET_LANGUAGE, "en"),
    mode: normalizeMode(options.mode ?? options.doubaoAstMode ?? process.env.DOUBAO_AST_MODE ?? "s2t")
  };
}

export async function createDoubaoAstProvider(options = {}) {
  const config = readProviderConfig(options);
  const codec = await resolveDoubaoAstCodec(options);

  return {
    name: "doubao-ast",
    providerId: "doubao-ast",
    createSessionState({ sessionId }) {
      return {
        sessionId,
        endpoint: config.endpoint,
        appKey: config.appKey,
        appId: config.appId,
        resourceId: config.resourceId,
        connectionId: randomUUID(),
        socket: null,
        connectingPromise: null,
        pendingMessages: [],
        waiters: [],
        keepAliveTimer: null,
        closed: false,
        lastError: null,
        remoteSessionId: null,
        sequence: 0
      };
    },
    async disposeSessionState(sessionState) {
      await closeConnection(sessionState);
    },
    async *transcribeText(input) {
      const trimmed = String(input.text ?? "").trim();

      if (!trimmed) {
        throw new Error("text is required");
      }

      yield {
        status: "final",
        text: trimmed,
        confidence: 1,
        provider: "doubao-ast-passthrough"
      };
    },
    async *transcribeAudioChunk(input) {
      const runtimeConfig = {
        ...config,
        codec
      };

      await sendTaskRequest(runtimeConfig, input.sessionState, input);

      if (input.metadata?.isFinalChunk) {
        await finishSession(runtimeConfig, input.sessionState);
      }

      const drafts = await collectDrafts(runtimeConfig, input.sessionState, {
        timeoutMs: input.metadata?.isFinalChunk ? FINAL_DRAIN_WAIT_MS : PARTIAL_DRAIN_WAIT_MS,
        requireFinal: false
      });

      for (const draft of drafts) {
        yield draft;
      }
    }
  };
}
