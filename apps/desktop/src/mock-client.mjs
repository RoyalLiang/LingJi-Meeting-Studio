import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";

const apiBaseUrl = process.env.TRANSCRIPT_API_BASE_URL ?? "http://127.0.0.1:3020";
const gatewayBaseUrl = process.env.SESSION_GATEWAY_BASE_URL ?? "http://127.0.0.1:3010";
const audioChunkSizeBytes = Number(process.env.DESKTOP_AUDIO_CHUNK_SIZE_BYTES ?? 32 * 1024);

async function createSession(title) {
  const response = await fetch(`${apiBaseUrl}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title,
      config: {
        sourceLanguage: "en",
        targetLanguages: ["zh-CN"],
        enableAudioStorage: false,
        enableLiveShare: true,
        glossaryIds: [],
        referenceDocumentIds: []
      },
      deviceSelection: {
        sourceKind: "mixed"
      }
    })
  });

  return response.json();
}

async function ingestText(sessionId, text) {
  const response = await fetch(`${gatewayBaseUrl}/sessions/${sessionId}/ingest-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      sourceLanguage: "en",
      targetLanguages: ["zh-CN"]
    })
  });

  return response.json();
}

async function uploadAudioChunk(sessionId, chunk, metadata) {
  const response = await fetch(`${gatewayBaseUrl}/sessions/${sessionId}/audio-chunks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-audio-chunk-id": metadata.chunkId,
      "x-audio-sequence": String(metadata.sequence),
      "x-audio-encoding": metadata.encoding,
      "x-audio-sample-rate": String(metadata.sampleRateHz),
      "x-audio-channels": String(metadata.channels),
      "x-audio-duration-ms": String(metadata.durationMs),
      "x-audio-final": metadata.isFinalChunk ? "true" : "false",
      "x-source-language": metadata.sourceLanguage,
      "x-target-languages": metadata.targetLanguages.join(","),
      ...(metadata.transcriptHint ? { "x-transcript-hint": metadata.transcriptHint } : {})
    },
    body: chunk
  });

  return response.json();
}

async function streamAudioFile(sessionId, filePath, transcriptHint) {
  const absolutePath = path.resolve(filePath);
  const fileInfo = await stat(absolutePath);
  const durationMs = Math.max(250, Math.round((fileInfo.size / 32000) * 1000));
  const stream = createReadStream(absolutePath, {
    highWaterMark: audioChunkSizeBytes
  });
  let sequence = 0;
  let chunkCount = 0;

  for await (const chunk of stream) {
    sequence += 1;
    chunkCount += 1;
    const isFinalChunk = sequence * audioChunkSizeBytes >= fileInfo.size;
    const result = await uploadAudioChunk(sessionId, chunk, {
      chunkId: randomUUID(),
      sequence,
      encoding: absolutePath.toLowerCase().endsWith(".wav") ? "wav" : "unknown",
      sampleRateHz: 16000,
      channels: 1,
      durationMs,
      isFinalChunk,
      sourceLanguage: "en",
      targetLanguages: ["zh-CN"],
      transcriptHint: isFinalChunk ? transcriptHint : undefined
    });

    console.log(`[desktop-mock] audio chunk #${sequence} accepted (${result.byteLength} bytes)`);
  }

  return {
    chunkCount,
    filePath: absolutePath,
    transcriptHint
  };
}

async function stopSession(sessionId) {
  await fetch(`${gatewayBaseUrl}/sessions/${sessionId}/stop`, {
    method: "POST"
  });
}

function parseFileCommand(line) {
  const payload = line.slice("/file".length).trim();

  if (!payload) {
    return null;
  }

  const separatorIndex = payload.indexOf("|");

  if (separatorIndex === -1) {
    return {
      filePath: payload.trim(),
      transcriptHint: path.basename(payload.trim())
    };
  }

  return {
    filePath: payload.slice(0, separatorIndex).trim(),
    transcriptHint: payload.slice(separatorIndex + 1).trim()
  };
}

const cli = readline.createInterface({
  input,
  output
});

console.log("[desktop-mock] creating session...");
const session = await createSession("Desktop Mock Session");
console.log(`[desktop-mock] session: ${session.id}`);
console.log("[desktop-mock] 输入英文句子走文本链路；输入 /file <path>|<transcript hint> 走音频 chunk 链路；输入 /stop 结束；输入 /exit 退出。");

while (true) {
  const line = (await cli.question("say> ")).trim();

  if (!line) {
    continue;
  }

  if (line === "/stop") {
    await stopSession(session.id);
    console.log("[desktop-mock] session stopped");
    continue;
  }

  if (line === "/exit") {
    await stopSession(session.id);
    break;
  }

  if (line.startsWith("/file")) {
    const parsed = parseFileCommand(line);

    if (!parsed) {
      console.log("[desktop-mock] 用法: /file C:\\path\\sample.wav|hello world");
      continue;
    }

    const result = await streamAudioFile(session.id, parsed.filePath, parsed.transcriptHint);
    console.log(`[desktop-mock] streamed ${result.chunkCount} chunks from ${result.filePath}`);
    continue;
  }

  const result = await ingestText(session.id, line);
  console.log(`[desktop-mock] accepted segment ${result.segmentId}`);
}

cli.close();
