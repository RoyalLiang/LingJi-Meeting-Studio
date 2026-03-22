import http from "node:http";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.mjs";

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

function withSegmentCount(session, replay) {
  return {
    ...session,
    segmentCount: replay.segments.length,
    translationCount: replay.translations.length
  };
}

function createRequestRouter(store) {
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
    const health = await store.health();
    sendJson(response, 200, {
      ok: true,
      service: "transcript-api",
      storage: health
    });
    return;
  }

  if (request.method === "GET" && pathname === "/sessions") {
    sendJson(response, 200, {
      sessions: await store.listSessions()
    });
    return;
  }

  if (request.method === "POST" && pathname === "/sessions") {
    try {
      const body = await readJson(request);
      const session = await store.createSession(body);
      sendJson(response, 201, session);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);

  if (request.method === "GET" && sessionMatch) {
    const session = await store.getSession(sessionMatch[1]);

    if (!session) {
      notFound(response);
      return;
    }

    const replay = await store.buildReplay(session.id);
    sendJson(response, 200, withSegmentCount(session, replay));
    return;
  }

  if (request.method === "PATCH" && sessionMatch) {
    try {
      const sessionId = sessionMatch[1];
      const body = await readJson(request);
      const session = await store.updateSession(sessionId, body);

      if (!session) {
        notFound(response);
        return;
      }

      const replay = await store.buildReplay(session.id);
      sendJson(response, 200, withSegmentCount(session, replay));
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
    const session = await store.updateSessionStatus(sessionId, status);

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
      const segment = await store.upsertSegment(sessionId, body);

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
    const replay = await store.buildReplay(segmentsMatch[1]);

    if (!replay) {
      notFound(response);
      return;
    }

    sendJson(response, 200, {
      segments: replay.segments
    });
    return;
  }

  const translationsMatch = pathname.match(/^\/sessions\/([^/]+)\/translations$/);

  if (request.method === "POST" && translationsMatch) {
    try {
      const sessionId = translationsMatch[1];
      const body = await readJson(request);
      const translation = await store.upsertTranslation(sessionId, body);

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
    const replay = await store.buildReplay(replayMatch[1]);

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
      const audioClip = await store.upsertAudioClip(sessionId, body);

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
    const replay = await store.buildReplay(audioClipsMatch[1]);

    if (!replay) {
      notFound(response);
      return;
    }

    sendJson(response, 200, {
      audioClips: replay.audioClips ?? []
    });
    return;
  }

  const shareLinksMatch = pathname.match(/^\/sessions\/([^/]+)\/share-links$/);

  if (request.method === "POST" && shareLinksMatch) {
    try {
      const sessionId = shareLinksMatch[1];
      const body = await readJson(request);
      const shareLink = await store.createShareLink(sessionId, body);

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
    const shareLink = await store.getShareLinkByToken(shareBootstrapMatch[1]);

    if (!shareLink) {
      notFound(response);
      return;
    }

    const replay = await store.buildReplay(shareLink.sessionId);

    if (!replay) {
      notFound(response);
      return;
    }

    sendJson(response, 200, {
      shareLink,
      ...replay
    });
    return;
  }

  const summaryMatch = pathname.match(/^\/sessions\/([^/]+)\/summary$/);

  if (request.method === "POST" && summaryMatch) {
    try {
      const sessionId = summaryMatch[1];
      const body = await readJson(request);
      const summary = await store.putSummary(sessionId, body);

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
}
}

export async function createTranscriptApiServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.TRANSCRIPT_API_PORT ?? 3020);
  const store = options.store ?? await createStore(options);
  const routeRequest = createRequestRouter(store);
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
  const app = await createTranscriptApiServer();
  const { host, port } = await app.start();
  console.log(`[transcript-api] listening on http://${host}:${port}`);
}
