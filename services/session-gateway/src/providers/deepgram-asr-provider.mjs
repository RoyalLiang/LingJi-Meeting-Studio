import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const KEEP_ALIVE_INTERVAL_MS = 4_000;
const PARTIAL_DRAIN_WAIT_MS = 250;
const FINAL_DRAIN_WAIT_MS = 2_500;

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

function mapEncoding(metadata) {
  switch (metadata.encoding) {
    case "pcm_s16le":
      return "linear16";
    case "opus":
      return "opus";
    default:
      return null;
  }
}

function buildConnectionUrl(baseUrl, options) {
  const url = new URL(baseUrl);
  url.searchParams.set("model", options.model);
  url.searchParams.set("interim_results", String(options.interimResults));
  url.searchParams.set("punctuate", String(options.punctuate));
  url.searchParams.set("smart_format", String(options.smartFormat));

  if (options.language && options.language !== "auto") {
    url.searchParams.set("language", options.language);
  }

  if (options.channels) {
    url.searchParams.set("channels", String(options.channels));
  }

  if (options.encoding) {
    url.searchParams.set("encoding", options.encoding);
  }

  if (options.sampleRateHz && options.encoding) {
    url.searchParams.set("sample_rate", String(options.sampleRateHz));
  }

  if (options.endpointing) {
    url.searchParams.set("endpointing", String(options.endpointing));
  }

  if (options.noDelay) {
    url.searchParams.set("no_delay", "true");
  }

  return url.toString();
}

function normalizeDraft(message) {
  if (message.type !== "Results") {
    return null;
  }

  const alternative = message.channel?.alternatives?.[0];
  const transcript = alternative?.transcript?.trim();

  if (!transcript) {
    return null;
  }

  return {
    status: message.is_final ? "final" : "partial",
    text: transcript,
    confidence: alternative?.confidence,
    provider: "deepgram"
  };
}

function pushDraft(sessionState, draft) {
  sessionState.pendingDrafts.push(draft);
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
      sessionState.socket.send(JSON.stringify({
        type: "KeepAlive"
      }));
    }
  }, KEEP_ALIVE_INTERVAL_MS);
}

function stopKeepAlive(sessionState) {
  if (sessionState.keepAliveTimer) {
    clearInterval(sessionState.keepAliveTimer);
    sessionState.keepAliveTimer = null;
  }
}

async function ensureConnection(sessionState, options) {
  if (!sessionState) {
    throw providerError("invalid_provider_session_state", "Deepgram provider requires a session state object.");
  }

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
  const ws = new WebSocket(options.url, {
    headers: {
      Authorization: `Token ${options.apiKey}`
    }
  });

  sessionState.connectingPromise = deferred.promise;
  sessionState.socket = ws;
  sessionState.closed = false;
  sessionState.pendingDrafts = [];
  sessionState.waiters = [];
  sessionState.lastError = null;

  ws.once("open", () => {
    startKeepAlive(sessionState);
    deferred.resolve();
  });

  ws.on("message", (payload) => {
    try {
      const message = JSON.parse(payload.toString("utf8"));
      const draft = normalizeDraft(message);

      if (draft) {
        pushDraft(sessionState, draft);
      }

      if (message.type === "Error") {
        setSessionError(sessionState, providerError(
          "deepgram_stream_error",
          message.description ?? "Deepgram stream returned an error."
        ));
      }

      if (message.from_finalize) {
        flushWaiters(sessionState);
      }
    } catch {
      return;
    }
  });

  ws.once("close", (code, reasonBuffer) => {
    stopKeepAlive(sessionState);
    sessionState.closed = true;
    sessionState.socket = null;
    sessionState.connectingPromise = null;

    if (code !== 1000 && !sessionState.lastError) {
      setSessionError(sessionState, providerError(
        "deepgram_socket_closed",
        `Deepgram socket closed unexpectedly (${code}): ${reasonBuffer.toString("utf8") || "no reason"}`
      ));
      return;
    }

    flushWaiters(sessionState);
  });

  ws.once("error", (error) => {
    stopKeepAlive(sessionState);
    sessionState.socket = null;
    sessionState.connectingPromise = null;
    const wrappedError = providerError(
      "deepgram_connection_failed",
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

async function waitForDrafts(sessionState, timeoutMs) {
  if (sessionState.lastError) {
    throw sessionState.lastError;
  }

  if (sessionState.pendingDrafts.length > 0 || sessionState.closed) {
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

async function collectDrafts(sessionState, options = {}) {
  const drafts = [];
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    while (sessionState.pendingDrafts.length > 0) {
      const draft = sessionState.pendingDrafts.shift();
      drafts.push(draft);

      if (options.requireFinal && draft.status === "final") {
        return drafts;
      }
    }

    if (sessionState.closed && !options.requireFinal) {
      break;
    }

    await waitForDrafts(sessionState, Math.max(1, deadline - Date.now()));
  }

  return drafts;
}

async function finalizeConnection(sessionState) {
  if (sessionState.socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  sessionState.socket.send(JSON.stringify({
    type: "Finalize"
  }));
}

async function closeConnection(sessionState) {
  if (!sessionState) {
    return;
  }

  if (sessionState.socket?.readyState !== WebSocket.OPEN) {
    stopKeepAlive(sessionState);
    return;
  }

  sessionState.socket.send(JSON.stringify({
    type: "CloseStream"
  }));

  try {
    await Promise.race([
      delay(1_000).then(() => {
        if (sessionState.socket?.readyState === WebSocket.OPEN) {
          sessionState.socket.close(1000, "client shutdown");
        }
      }),
      new Promise((resolve) => {
        sessionState.socket.once("close", resolve);
      })
    ]);
  } finally {
    stopKeepAlive(sessionState);
  }
}

export function createDeepgramAsrProvider(options = {}) {
  const apiKey = options.apiKey ?? process.env.DEEPGRAM_API_KEY ?? process.env.ASR_API_KEY;

  if (!apiKey) {
    throw providerError(
      "missing_deepgram_api_key",
      "Deepgram provider requires DEEPGRAM_API_KEY or ASR_API_KEY."
    );
  }

  const providerOptions = {
    apiKey,
    baseUrl: options.baseUrl ?? process.env.DEEPGRAM_BASE_URL ?? "wss://api.deepgram.com/v1/listen",
    model: options.model ?? process.env.DEEPGRAM_MODEL ?? "nova-3",
    interimResults: options.interimResults ?? true,
    punctuate: options.punctuate ?? true,
    smartFormat: options.smartFormat ?? true,
    endpointing: options.endpointing ?? process.env.DEEPGRAM_ENDPOINTING,
    noDelay: options.noDelay ?? false
  };

  return {
    name: "deepgram",
    providerId: "deepgram",
    createSessionState() {
      return {
        socket: null,
        connectingPromise: null,
        pendingDrafts: [],
        waiters: [],
        keepAliveTimer: null,
        closed: false,
        lastError: null
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
        provider: "deepgram-passthrough"
      };
    },
    async *transcribeAudioChunk(input) {
      const connectionOptions = {
        ...providerOptions,
        url: buildConnectionUrl(providerOptions.baseUrl, {
          ...providerOptions,
          language: input.metadata.sourceLanguage,
          channels: input.metadata.channels,
          encoding: mapEncoding(input.metadata),
          sampleRateHz: input.metadata.sampleRateHz
        })
      };

      const socket = await ensureConnection(input.sessionState, connectionOptions);

      if (input.body.length > 0) {
        socket.send(input.body);
      }

      if (input.metadata.isFinalChunk) {
        await finalizeConnection(input.sessionState);
      }

      const drafts = await collectDrafts(input.sessionState, {
        timeoutMs: input.metadata.isFinalChunk ? FINAL_DRAIN_WAIT_MS : PARTIAL_DRAIN_WAIT_MS,
        requireFinal: input.metadata.isFinalChunk
      });

      for (const draft of drafts) {
        yield draft;
      }
    }
  };
}
