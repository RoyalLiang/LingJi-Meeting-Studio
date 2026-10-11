import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function importFresh(relativePath) {
  const moduleUrl = pathToFileURL(path.join(rootDir, relativePath));
  moduleUrl.searchParams.set("v", `${Date.now()}-${Math.random()}`);
  return import(moduleUrl.href);
}

async function pathExists(relativePath) {
  try {
    await access(path.join(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function runWithStack(options, callback) {
  const apiPort = options.apiPort;
  const gatewayPort = options.gatewayPort;
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;

  process.env.TRANSCRIPT_API_BASE_URL = apiBaseUrl;

  const [{ createTranscriptApiServer }, { createSessionGatewayServer }] = await Promise.all([
    importFresh("services/transcript-api/src/server.mjs"),
    importFresh("services/session-gateway/src/server.mjs")
  ]);

  const api = await createTranscriptApiServer({
    host: "127.0.0.1",
    port: apiPort,
    storageBackend: options.storageBackend,
    databaseUrl: options.databaseUrl
  });
  const gateway = createSessionGatewayServer({
    host: "127.0.0.1",
    port: gatewayPort,
    ...(options.gatewayOptions ?? {})
  });

  await api.start();
  try {
    await gateway.start();
  } catch (startError) {
    await api.stop();
    throw startError;
  }

  try {
    await callback({
      apiBaseUrl,
      gatewayBaseUrl
    });
  } finally {
    await gateway.stop();
    await api.stop();
  }
}

export async function runTranscriptMigrations(databaseUrl) {
  const { migratePostgresDatabase } = await importFresh("services/transcript-api/src/storage/postgres-store.mjs");
  await migratePostgresDatabase(databaseUrl);
}

export async function createSession(apiBaseUrl, overrides = {}) {
  const response = await fetch(`${apiBaseUrl}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: overrides.title ?? "Smoke Test Session",
      config: {
        sourceLanguage: "en",
        targetLanguages: ["zh-CN"],
        enableAudioStorage: false,
        enableLiveShare: true,
        glossaryIds: [],
        referenceDocumentIds: [],
        ...overrides.config
      },
      deviceSelection: {
        sourceKind: "mixed",
        ...overrides.deviceSelection
      }
    })
  });

  return response.json();
}

export async function updateSession(apiBaseUrl, sessionId, updates = {}) {
  const response = await fetch(`${apiBaseUrl}/sessions/${sessionId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(updates)
  });

  return response.json();
}

export async function ingestText(gatewayBaseUrl, sessionId, text, overrides = {}) {
  const response = await fetch(`${gatewayBaseUrl}/sessions/${sessionId}/ingest-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      sourceLanguage: overrides.sourceLanguage ?? "en",
      targetLanguages: overrides.targetLanguages ?? ["zh-CN"]
    })
  });

  return response.json();
}

export async function ingestAudioChunk(gatewayBaseUrl, sessionId, options = {}) {
  const response = await fetch(`${gatewayBaseUrl}/sessions/${sessionId}/audio-chunks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-audio-chunk-id": options.chunkId ?? "chunk-1",
      "x-audio-sequence": String(options.sequence ?? 1),
      "x-audio-encoding": options.encoding ?? "wav",
      "x-audio-sample-rate": String(options.sampleRateHz ?? 16000),
      "x-audio-channels": String(options.channels ?? 1),
      "x-audio-duration-ms": String(options.durationMs ?? 500),
      "x-audio-final": options.isFinalChunk ? "true" : "false",
      "x-source-language": options.sourceLanguage ?? "en",
      "x-target-languages": (options.targetLanguages ?? ["zh-CN"]).join(","),
      ...(options.transcriptHint ? { "x-transcript-hint": options.transcriptHint } : {})
    },
    body: options.body ?? Buffer.from("RIFF-demo-chunk")
  });

  return response.json();
}

export async function fetchReplay(apiBaseUrl, sessionId) {
  const response = await fetch(`${apiBaseUrl}/sessions/${sessionId}/replay`);
  return response.json();
}

export async function fetchHealth(apiBaseUrl) {
  const response = await fetch(`${apiBaseUrl}/health`);
  return response.json();
}

export async function fetchGatewayHealth(gatewayBaseUrl) {
  const response = await fetch(`${gatewayBaseUrl}/health`);
  return response.json();
}

export async function createGatewayServer(options = {}) {
  const { createSessionGatewayServer } = await importFresh("services/session-gateway/src/server.mjs");

  return createSessionGatewayServer({
    host: "127.0.0.1",
    ...options
  });
}

export async function startDesktopPreviewServer(options = {}) {
  const candidates = [
    "apps/desktop/src/server.mjs",
    "apps/desktop/src/shell-server.mjs",
    "apps/desktop/src/preview-server.mjs"
  ];
  const relativePath = await (async () => {
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return candidate;
      }
    }

    return null;
  })();

  if (!relativePath) {
    return null;
  }

  const module = await importFresh(relativePath);
  const factoryEntry = Object.entries(module).find(([key, value]) => (
    typeof value === "function" && /create.*server/i.test(key)
  ));

  if (!factoryEntry) {
    throw new Error(`No server factory export found in ${relativePath}`);
  }

  const [, createServer] = factoryEntry;
  const app = createServer({
    host: "127.0.0.1",
    ...options
  });
  const startResult = await app.start();

  return {
    ...startResult,
    stop: app.stop,
    relativePath
  };
}

export async function startWebPreviewServer(options = {}) {
  const candidates = [
    "apps/web/src/server.mjs",
    "apps/web/src/web-server.mjs",
    "apps/web/src/preview-server.mjs"
  ];
  const relativePath = await (async () => {
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return candidate;
      }
    }

    return null;
  })();

  if (!relativePath) {
    return null;
  }

  const module = await importFresh(relativePath);
  const factoryEntry = Object.entries(module).find(([key, value]) => (
    typeof value === "function" && /create.*server/i.test(key)
  ));

  if (!factoryEntry) {
    throw new Error(`No server factory export found in ${relativePath}`);
  }

  const [, createServer] = factoryEntry;
  const app = createServer({
    host: "127.0.0.1",
    ...options
  });
  const startResult = await app.start();

  return {
    ...startResult,
    stop: app.stop,
    relativePath
  };
}
