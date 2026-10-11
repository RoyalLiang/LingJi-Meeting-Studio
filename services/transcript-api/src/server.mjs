import http from "node:http";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.mjs";
import {
  SessionAppService,
  TranscriptAppService,
  ReplayAppService,
  ShareAppService
} from "./application/services.mjs";

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
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
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function notFound(response) {
  sendJson(response, 404, {
    error: "not_found"
  });
}

function badRequest(response, error) {
  sendJson(response, 400, {
    error: "bad_request",
    detail: error instanceof Error ? error.message : String(error)
  });
}

export class TranscriptApiApp {
  #store;
  #sessions;
  #transcripts;
  #replays;
  #shares;

  constructor(store) {
    this.#store = store;
    this.#sessions = new SessionAppService(store);
    this.#transcripts = new TranscriptAppService(store);
    this.#replays = new ReplayAppService(store);
    this.#shares = new ShareAppService(store);
  }

  get store() {
    return this.#store;
  }

  get sessions() {
    return this.#sessions;
  }

  get transcripts() {
    return this.#transcripts;
  }

  get replays() {
    return this.#replays;
  }

  get shares() {
    return this.#shares;
  }
}

function createRequestRouter(app) {
  return async function routeRequest(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && pathname === "/health") {
      const health = await app.store.health();
      sendJson(response, 200, {
        ok: true,
        service: "transcript-api",
        storage: health
      });
      return;
    }

    if (request.method === "GET" && pathname === "/sessions") {
      sendJson(response, 200, {
        sessions: await app.sessions.listSessions()
      });
      return;
    }

    if (request.method === "POST" && pathname === "/sessions") {
      try {
        const body = await readJson(request);
        const session = await app.sessions.createSession(body);
        sendJson(response, 201, session);
      } catch (error) {
        badRequest(response, error);
      }
      return;
    }

    const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);

    if (request.method === "GET" && sessionMatch) {
      const session = await app.sessions.getSession(sessionMatch[1]);
      if (!session) {
        notFound(response);
        return;
      }
      sendJson(response, 200, session);
      return;
    }

    if (request.method === "PATCH" && sessionMatch) {
      try {
        const sessionId = sessionMatch[1];
        const body = await readJson(request);
        const session = await app.sessions.updateSession(sessionId, body);

        if (!session) {
          notFound(response);
          return;
        }

        sendJson(response, 200, session);
      } catch (error) {
        badRequest(response, error);
      }
      return;
    }

    const sessionActionMatch = pathname.match(/^\/sessions\/([^/]+)\/(start|stop)$/);

    if (request.method === "POST" && sessionActionMatch) {
      const sessionId = sessionActionMatch[1];
      const action = sessionActionMatch[2];
      const status = action === "start" ? "live" : "completed";
      const session = await app.sessions.updateStatus(sessionId, status);

      if (!session) {
        notFound(response);
        return;
      }

      sendJson(response, 200, session);
      return;
    }

    const segmentsMatch = pathname.match(/^\/sessions\/([^/]+)\/segments$/);

    if (request.method === "POST" && segmentsMatch) {
      try {
        const sessionId = segmentsMatch[1];
        const body = await readJson(request);
        const segment = await app.transcripts.upsertSegment(sessionId, body);

        if (!segment) {
          notFound(response);
          return;
        }

        sendJson(response, 201, segment);
      } catch (error) {
        badRequest(response, error);
      }
      return;
    }

    if (request.method === "GET" && segmentsMatch) {
      const segments = await app.transcripts.getSegments(segmentsMatch[1]);
      if (!segments) {
        notFound(response);
        return;
      }

      sendJson(response, 200, {
        segments
      });
      return;
    }

    const translationsMatch = pathname.match(/^\/sessions\/([^/]+)\/translations$/);

    if (request.method === "POST" && translationsMatch) {
      try {
        const sessionId = translationsMatch[1];
        const body = await readJson(request);
        const translation = await app.transcripts.upsertTranslation(sessionId, body);

        if (!translation) {
          notFound(response);
          return;
        }

        sendJson(response, 201, translation);
      } catch (error) {
        badRequest(response, error);
      }
      return;
    }

    const replayMatch = pathname.match(/^\/sessions\/([^/]+)\/replay$/);

    if (request.method === "GET" && replayMatch) {
      const replay = await app.replays.buildReplay(replayMatch[1]);
      if (!replay) {
        notFound(response);
        return;
      }

      sendJson(response, 200, replay);
      return;
    }

    const audioClipsMatch = pathname.match(/^\/sessions\/([^/]+)\/audio-clips$/);

    if (request.method === "POST" && audioClipsMatch) {
      try {
        const sessionId = audioClipsMatch[1];
        const body = await readJson(request);
        const audioClip = await app.transcripts.upsertAudioClip(sessionId, body);

        if (!audioClip) {
          notFound(response);
          return;
        }

        sendJson(response, 201, audioClip);
      } catch (error) {
        badRequest(response, error);
      }
      return;
    }

    if (request.method === "GET" && audioClipsMatch) {
      const audioClips = await app.transcripts.getAudioClips(audioClipsMatch[1]);
      if (!audioClips) {
        notFound(response);
        return;
      }

      sendJson(response, 200, {
        audioClips
      });
      return;
    }

    const shareLinksMatch = pathname.match(/^\/sessions\/([^/]+)\/share-links$/);

    if (request.method === "POST" && shareLinksMatch) {
      try {
        const sessionId = shareLinksMatch[1];
        const body = await readJson(request);
        const shareLink = await app.shares.createShareLink(sessionId, body);

        if (!shareLink) {
          notFound(response);
          return;
        }

        sendJson(response, 201, shareLink);
      } catch (error) {
        badRequest(response, error);
      }
      return;
    }

    const shareBootstrapMatch = pathname.match(/^\/share\/([^/]+)\/bootstrap$/);

    if (request.method === "GET" && shareBootstrapMatch) {
      const bootstrap = await app.shares.bootstrapShare(shareBootstrapMatch[1]);
      if (!bootstrap) {
        notFound(response);
        return;
      }

      sendJson(response, 200, bootstrap);
      return;
    }

    const summaryMatch = pathname.match(/^\/sessions\/([^/]+)\/summary$/);

    if (request.method === "POST" && summaryMatch) {
      try {
        const sessionId = summaryMatch[1];
        const body = await readJson(request);
        const summary = await app.transcripts.putSummary(sessionId, body);

        if (!summary) {
          notFound(response);
          return;
        }

        sendJson(response, 201, summary);
      } catch (error) {
        badRequest(response, error);
      }
      return;
    }

    notFound(response);
  };
}

export async function createTranscriptApiServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.TRANSCRIPT_API_PORT ?? 3020);
  const store = options.store ?? (await createStore(options));
  const app = new TranscriptApiApp(store);
  const routeRequest = createRequestRouter(app);

  const server = http.createServer((request, response) => {
    routeRequest(request, response).catch((error) => {
      sendJson(response, 500, {
        error: "internal_error",
        detail: error instanceof Error ? error.message : String(error)
      });
    });
  });

  return {
    server,
    app,
    start() {
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

          Promise.resolve(store.close?.()).then(resolve).catch(reject);
        });
      });
    }
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const apiApp = await createTranscriptApiServer();
  const { host, port } = await apiApp.start();
  console.log(`[transcript-api] listening on http://${host}:${port}`);
}
