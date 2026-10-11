import http from "node:http";
import { fileURLToPath } from "node:url";
import { createAsrProvider } from "./providers/index.mjs";
import { AudioIngestComponent } from "./components/audio-ingest-component.mjs";
import { BroadcasterComponent } from "./components/broadcaster-component.mjs";
import { TranslationComponent } from "./components/translation-component.mjs";
import { TranscriptApiClient } from "./components/transcript-api-client.mjs";
import { AsrOrchestratorComponent } from "./components/asr-orchestrator-component.mjs";
import {
  DomainError,
  createSessionStatusChangedEvent,
  createAudioChunkReceivedEvent
} from "@tts/domain";

const ENABLE_AUDIO_CHUNK_EVENTS = process.env.ENABLE_AUDIO_CHUNK_EVENTS === "true";

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

function handleError(response, error) {
  const statusCode = error.statusCode ?? 400;
  const errorCode = error.errorCode ?? "bad_request";
  sendJson(response, statusCode, {
    error: errorCode,
    detail: error instanceof Error ? error.message : String(error)
  });
}

export class SessionGatewayApp {
  #audioIngest;
  #broadcaster;
  #translationService;
  #apiClient;
  #orchestrator;
  #liveSessionIds = new Set();

  constructor(options = {}) {
    this.#audioIngest = new AudioIngestComponent();
    this.#broadcaster = new BroadcasterComponent();
    this.#translationService = new TranslationComponent();
    this.#apiClient = new TranscriptApiClient(options.transcriptApiBaseUrl);
    this.#orchestrator = new AsrOrchestratorComponent({
      broadcaster: this.#broadcaster,
      translationService: this.#translationService,
      apiClient: this.#apiClient
    });
  }

  get audioIngest() {
    return this.#audioIngest;
  }

  get broadcaster() {
    return this.#broadcaster;
  }

  get translationService() {
    return this.#translationService;
  }

  get apiClient() {
    return this.#apiClient;
  }

  get orchestrator() {
    return this.#orchestrator;
  }

  async ensureLiveSession(sessionId) {
    if (this.#liveSessionIds.has(sessionId)) {
      return;
    }

    const started = await this.#apiClient.syncSessionStatus(sessionId, "start");
    if (!started) {
      throw new DomainError(`Unable to start session ${sessionId}.`, "session_not_found", 404);
    }

    this.#liveSessionIds.add(sessionId);
    this.#broadcaster.broadcast(
      sessionId,
      createSessionStatusChangedEvent(sessionId, "live")
    );
  }

  async stopSession(provider, sessionId) {
    await this.#apiClient.syncSessionStatus(sessionId, "stop");
    this.#liveSessionIds.delete(sessionId);
    this.#audioIngest.deleteSession(sessionId);
    await this.#orchestrator.disposeSession(provider, sessionId);
    this.#broadcaster.broadcast(
      sessionId,
      createSessionStatusChangedEvent(sessionId, "completed")
    );
  }
}

function createRequestRouter(app, getProvider) {
  return async function routeRequest(request, response) {
    const provider = getProvider();
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
        asrProvider: provider?.name,
        providerId: provider?.providerId,
        activeProvider: provider?.activeProviderName ?? provider?.name,
        fallbackProvider: provider?.fallbackProviderName ?? null,
        startupError: provider?.startupError ?? null
      });
      return;
    }

    const streamMatch = pathname.match(/^\/sessions\/([^/]+)\/stream$/);
    if (request.method === "GET" && streamMatch) {
      app.broadcaster.openEventStream(streamMatch[1], response, setCorsHeaders);
      return;
    }

    const ingestMatch = pathname.match(/^\/sessions\/([^/]+)\/ingest-text$/);
    if (request.method === "POST" && ingestMatch) {
      try {
        const sessionId = ingestMatch[1];
        const body = await readJson(request);
        await app.ensureLiveSession(sessionId);
        const sessionState = app.orchestrator.getProviderSessionState(provider, sessionId);
        const segment = await app.orchestrator.emitTranscriptDrafts(
          sessionId,
          {
            estimatedText: body.text,
            sourceLanguage: body.sourceLanguage,
            targetLanguages: body.targetLanguages
          },
          provider.transcribeText({
            sessionId,
            text: body.text,
            sourceLanguage: body.sourceLanguage,
            targetLanguages: body.targetLanguages,
            sessionState
          })
        );

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
        handleError(response, error);
      }
      return;
    }

    const audioChunkMatch = pathname.match(/^\/sessions\/([^/]+)\/audio-chunks$/);
    if (request.method === "POST" && audioChunkMatch) {
      try {
        const sessionId = audioChunkMatch[1];
        const body = await readBuffer(request);
        const { metadata, ack } = app.audioIngest.ingestChunk(sessionId, request.headers, body);

        await app.ensureLiveSession(sessionId);

        if (ENABLE_AUDIO_CHUNK_EVENTS) {
          app.broadcaster.broadcast(
            sessionId,
            createAudioChunkReceivedEvent(sessionId, metadata)
          );
        }

        const sessionState = app.orchestrator.getProviderSessionState(provider, sessionId);
        const segment = await app.orchestrator.emitTranscriptDrafts(
          sessionId,
          {
            estimatedText: metadata.transcriptHint,
            sourceLanguage: metadata.sourceLanguage,
            targetLanguages: metadata.targetLanguages
          },
          provider.transcribeAudioChunk({
            sessionId,
            metadata,
            body,
            sessionState
          })
        );

        sendJson(response, 202, {
          ...ack,
          transcriptAccepted: Boolean(segment)
        });
      } catch (error) {
        handleError(response, error);
      }
      return;
    }

    const stopMatch = pathname.match(/^\/sessions\/([^/]+)\/stop$/);
    if (request.method === "POST" && stopMatch) {
      const sessionId = stopMatch[1];
      await app.stopSession(provider, sessionId);
      sendJson(response, 200, {
        ok: true,
        sessionId
      });
      return;
    }

    sendJson(response, 404, {
      error: "not_found"
    });
  };
}

export function createSessionGatewayServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.SESSION_GATEWAY_PORT ?? 3010);
  let provider = null;
  const app = new SessionGatewayApp(options);
  const routeRequest = createRequestRouter(app, () => provider);

  const server = http.createServer((request, response) => {
    routeRequest(request, response).catch((error) => {
      sendJson(response, error.statusCode ?? 500, {
        error: error.errorCode ?? "internal_error",
        detail: error instanceof Error ? error.message : String(error)
      });
    });
  });

  return {
    server,
    app,
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
  const gateway = createSessionGatewayServer();
  const { host, port } = await gateway.start();
  console.log(`[session-gateway] listening on http://${host}:${port}`);
}
