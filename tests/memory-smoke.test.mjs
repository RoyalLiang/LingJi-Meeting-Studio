import test from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  fetchHealth,
  fetchReplay,
  ingestAudioChunk,
  ingestText,
  updateSession,
  runWithStack
} from "./helpers/stack.mjs";

test("memory backend supports text ingest flow", async () => {
  await runWithStack(
    {
      apiPort: 4520,
      gatewayPort: 4521,
      storageBackend: "memory"
    },
    async ({ apiBaseUrl, gatewayBaseUrl }) => {
      const health = await fetchHealth(apiBaseUrl);
      assert.equal(health.storage.backend, "memory");

      const session = await createSession(apiBaseUrl, {
        title: "Memory Text Flow"
      });

      const accepted = await ingestText(
        gatewayBaseUrl,
        session.id,
        "hello customer review the roadmap summary"
      );

      const replay = await fetchReplay(apiBaseUrl, session.id);

      assert.equal(accepted.accepted, true);
      assert.equal(replay.session.id, session.id);
      assert.equal(replay.segments.length, 1);
      assert.equal(replay.translations.length, 1);
      assert.equal(replay.segments[0].text, "hello customer review the roadmap summary");
      assert.match(replay.translations[0].text, /\[zh-CN\]/);
    }
  );
});

test("memory backend supports binary audio chunk flow", async () => {
  await runWithStack(
    {
      apiPort: 4530,
      gatewayPort: 4531,
      storageBackend: "memory"
    },
    async ({ apiBaseUrl, gatewayBaseUrl }) => {
      const session = await createSession(apiBaseUrl, {
        title: "Memory Audio Flow"
      });

      const firstChunk = await ingestAudioChunk(gatewayBaseUrl, session.id, {
        chunkId: "chunk-a",
        sequence: 1,
        isFinalChunk: false
      });
      const secondChunk = await ingestAudioChunk(gatewayBaseUrl, session.id, {
        chunkId: "chunk-b",
        sequence: 2,
        isFinalChunk: true,
        transcriptHint: "hello meeting launch summary",
        body: Buffer.alloc(0)
      });

      const replay = await fetchReplay(apiBaseUrl, session.id);

      assert.equal(firstChunk.transcriptAccepted, false);
      assert.equal(secondChunk.transcriptAccepted, true);
      assert.equal(secondChunk.totalChunksReceived, 2);
      assert.equal(replay.segments.length, 1);
      assert.equal(replay.translations.length, 1);
      assert.equal(replay.segments[0].text, "hello meeting launch summary");
      assert.match(replay.translations[0].text, /摘要/);
    }
  );
});

test("memory backend rejects invalid audio chunk metadata", async () => {
  await runWithStack(
    {
      apiPort: 4540,
      gatewayPort: 4541,
      storageBackend: "memory"
    },
    async ({ apiBaseUrl, gatewayBaseUrl }) => {
      const session = await createSession(apiBaseUrl, {
        title: "Memory Invalid Audio Flow"
      });

      const invalidSequenceResponse = await fetch(
        `${gatewayBaseUrl}/sessions/${session.id}/audio-chunks`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-audio-chunk-id": "invalid-sequence",
            "x-audio-sequence": "0",
            "x-audio-encoding": "wav",
            "x-audio-sample-rate": "16000",
            "x-audio-channels": "1",
            "x-audio-duration-ms": "500",
            "x-audio-final": "false",
            "x-source-language": "en",
            "x-target-languages": "zh-CN"
          },
          body: Buffer.from("RIFF-demo")
        }
      );
      const invalidSequence = await invalidSequenceResponse.json();

      assert.equal(invalidSequenceResponse.status, 400);
      assert.equal(invalidSequence.error, "invalid_audio_sequence");

      const firstChunk = await ingestAudioChunk(gatewayBaseUrl, session.id, {
        chunkId: "ordered-a",
        sequence: 1,
        isFinalChunk: false
      });
      const duplicateChunkResponse = await fetch(
        `${gatewayBaseUrl}/sessions/${session.id}/audio-chunks`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-audio-chunk-id": "ordered-b",
            "x-audio-sequence": "1",
            "x-audio-encoding": "wav",
            "x-audio-sample-rate": "16000",
            "x-audio-channels": "1",
            "x-audio-duration-ms": "500",
            "x-audio-final": "false",
            "x-source-language": "en",
            "x-target-languages": "zh-CN"
          },
          body: Buffer.from("RIFF-demo")
        }
      );
      const duplicateChunk = await duplicateChunkResponse.json();

      assert.equal(firstChunk.accepted, true);
      assert.equal(duplicateChunkResponse.status, 409);
      assert.equal(duplicateChunk.error, "audio_sequence_conflict");
    }
  );
});

test("memory backend supports session renaming and auto source language detection", async () => {
  await runWithStack(
    {
      apiPort: 4550,
      gatewayPort: 4551,
      storageBackend: "memory"
    },
    async ({ apiBaseUrl, gatewayBaseUrl }) => {
      const session = await createSession(apiBaseUrl, {
        title: "Rename Me",
        config: {
          sourceLanguage: "auto",
          targetLanguages: ["en"]
        }
      });

      const renamed = await updateSession(apiBaseUrl, session.id, {
        title: "Renamed Session"
      });

      const accepted = await ingestText(
        gatewayBaseUrl,
        session.id,
        "你好 会议 总结",
        {
          sourceLanguage: "auto",
          targetLanguages: ["en"]
        }
      );

      const replay = await fetchReplay(apiBaseUrl, session.id);

      assert.equal(renamed.title, "Renamed Session");
      assert.equal(accepted.accepted, true);
      assert.equal(replay.session.title, "Renamed Session");
      assert.equal(replay.segments.length, 1);
      assert.equal(replay.segments[0].sourceLanguage, "zh");
      assert.match(replay.translations[0].text, /\[en\]/);
    }
  );
});
