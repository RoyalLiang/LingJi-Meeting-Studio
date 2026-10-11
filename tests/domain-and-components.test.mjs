import test from "node:test";
import assert from "node:assert/strict";
import {
  SessionAggregate,
  TranscriptSegmentEntity,
  TranslationEntity,
  AudioChunkStreamTracker,
  DomainError,
  normalizeSourceLanguage,
  normalizeTargetLanguages,
  detectLanguageFromText,
  resolveSegmentSourceLanguage,
  isSameLanguage,
  shouldTranslate,
  progressiveDraftEvents,
  calculateSegmentTiming,
  shapeReplayPayload,
  attachSessionMetrics
} from "@tts/domain";
import {
  runWithStack,
  createSession,
  ingestText,
  ingestAudioChunk,
  fetchReplay
} from "./helpers/stack.mjs";

test("SessionAggregate: manages lifecycle state transitions and invariants", () => {
  const session = SessionAggregate.create({
    title: "Initial Title",
    config: {
      sourceLanguage: "auto",
      targetLanguages: ["zh-CN", "en"]
    }
  });

  assert.equal(session.status, "created");
  assert.equal(session.title, "Initial Title");
  assert.equal(session.isLive(), false);
  assert.equal(session.isTerminated(), false);

  session.start();
  assert.equal(session.status, "live");
  assert.equal(session.isLive(), true);
  assert.ok(session.startedAt);

  session.rename("Updated Title");
  assert.equal(session.title, "Updated Title");

  assert.throws(() => {
    session.rename("   ");
  }, /empty/i);

  session.complete();
  assert.equal(session.status, "completed");
  assert.equal(session.isTerminated(), true);
  assert.ok(session.endedAt);

  // Cannot restart a completed session
  assert.throws(() => {
    session.start();
  }, /already in status/i);

  const snapshot = session.toSnapshot();
  assert.equal(snapshot.id, session.id);
  assert.equal(snapshot.title, "Updated Title");
  assert.equal(snapshot.status, "completed");
});

test("AudioChunkStreamTracker: strictly enforces sequence progression and invariants", () => {
  const tracker = new AudioChunkStreamTracker("sess-test");

  // Valid first chunk
  const ack1 = tracker.recordChunk({
    chunkId: "c1",
    sequence: 1,
    sampleRateHz: 16000,
    channels: 1,
    isFinalChunk: false
  }, Buffer.from("chunk-1-data"));

  assert.equal(ack1.accepted, true);
  assert.equal(tracker.totalChunksReceived, 1);
  assert.equal(tracker.lastSequence, 1);

  // Sequence <= lastSequence must throw 409
  assert.throws(() => {
    tracker.recordChunk({
      chunkId: "c1-dup",
      sequence: 1,
      sampleRateHz: 16000,
      channels: 1
    }, Buffer.from("data"));
  }, (err) => err instanceof DomainError && err.statusCode === 409 && err.errorCode === "audio_sequence_conflict");

  // Out-of-order lower sequence throws 409
  assert.throws(() => {
    tracker.recordChunk({
      chunkId: "c0",
      sequence: 0,
      sampleRateHz: 16000,
      channels: 1
    }, Buffer.from("data"));
  }, (err) => err instanceof DomainError && err.statusCode === 400 && err.errorCode === "invalid_audio_sequence");

  // Valid next chunk
  const ack2 = tracker.recordChunk({
    chunkId: "c2",
    sequence: 2,
    sampleRateHz: 16000,
    channels: 1,
    isFinalChunk: true
  }, Buffer.from("chunk-2-data"));

  assert.equal(ack2.accepted, true);
  assert.equal(tracker.totalChunksReceived, 2);
  assert.equal(tracker.lastSequence, 2);
});

test("Language domain rules: multi-lingual detection and same-language suppression", () => {
  // Detection tests
  assert.equal(detectLanguageFromText("こんにちは世界"), "ja");
  assert.equal(detectLanguageFromText("안녕하세요"), "ko");
  assert.equal(detectLanguageFromText("Привет мир"), "ru");
  assert.equal(detectLanguageFromText("مرحبا بالعالم"), "ar");
  assert.equal(detectLanguageFromText("नमस्ते दुनिया"), "hi");
  assert.equal(detectLanguageFromText("欢迎使用双语工作台"), "zh");
  assert.equal(detectLanguageFromText("Welcome to the platform"), "en");

  // Same language detection
  assert.equal(isSameLanguage("zh", "zh-CN"), true);
  assert.equal(isSameLanguage("en", "en-US"), true);
  assert.equal(isSameLanguage("zh-CN", "en"), false);

  // Domain rule: "当前语种默认不转译"
  assert.equal(
    shouldTranslate("zh", "zh-CN", { suppressSameLanguage: true }),
    false,
    "Same language translation should be suppressed when switch is enabled"
  );
  assert.equal(
    shouldTranslate("en", "en", { suppressSameLanguage: true }),
    false,
    "English to English translation should be suppressed"
  );
  assert.equal(
    shouldTranslate("en", "zh-CN", { suppressSameLanguage: true }),
    true,
    "Cross-language translation must proceed"
  );
  assert.equal(
    shouldTranslate("zh", "zh-CN", { suppressSameLanguage: false }),
    true,
    "When suppression is false, same-language translation is not blocked"
  );
});

test("TranscriptDraftService: computes progressive draft steps and timing", () => {
  const steps = progressiveDraftEvents("hello", "hello world review", "final");
  assert.ok(steps.length >= 1);
  assert.equal(steps[steps.length - 1].text, "hello world review");
  assert.equal(steps[steps.length - 1].status, "final");

  const timing = calculateSegmentTiming(1000, 5);
  assert.equal(timing.startMs, 1000);
  assert.ok(timing.endMs > timing.startMs);
  assert.ok(timing.nextOffsetMs > timing.endMs);
});

test("ReplayShapingService: shapes structured replay payload and metrics", () => {
  const session = { id: "sess-1", title: "Test" };
  const segments = [
    { segmentId: "s2", sequence: 2, text: "second" },
    { segmentId: "s1", sequence: 1, text: "first" }
  ];
  const translations = [
    { segmentId: "s1", targetLanguage: "zh-CN", text: "第一" }
  ];

  const replay = shapeReplayPayload(session, segments, translations);
  assert.equal(replay.segments[0].sequence, 1);
  assert.equal(replay.segments[1].sequence, 2);

  const sessionWithMetrics = attachSessionMetrics(session, replay);
  assert.equal(sessionWithMetrics.segmentCount, 2);
  assert.equal(sessionWithMetrics.translationCount, 1);
});

test("End-to-end componentized stack: verifies domain integration with SSE and audio chunks", async () => {
  await runWithStack(
    {
      apiPort: 4850,
      gatewayPort: 4851,
      storageBackend: "memory"
    },
    async ({ apiBaseUrl, gatewayBaseUrl }) => {
      // 1. Create a session
      const session = await createSession(apiBaseUrl, {
        title: "DDD Componentized Session",
        config: {
          sourceLanguage: "auto",
          targetLanguages: ["zh-CN"]
        }
      });

      assert.equal(session.title, "DDD Componentized Session");
      assert.equal(session.status, "created");

      // 2. Connect to SSE stream
      const streamResponse = await fetch(`${gatewayBaseUrl}/sessions/${session.id}/stream`);
      assert.equal(streamResponse.status, 200);
      assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);

      // Reader setup
      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();

      // Read initial connection event
      const { value: initialChunk } = await reader.read();
      assert.match(decoder.decode(initialChunk), /: connected/);

      // 3. Ingest text to trigger live status and segment events
      const ingestResult = await ingestText(
        gatewayBaseUrl,
        session.id,
        "hello roadmap launch summary",
        { sourceLanguage: "en", targetLanguages: ["zh-CN"] }
      );
      assert.equal(ingestResult.accepted, true);

      // 4. Ingest audio chunk
      const audioResult = await ingestAudioChunk(gatewayBaseUrl, session.id, {
        chunkId: "chunk-ddd-1",
        sequence: 1,
        isFinalChunk: true,
        transcriptHint: "action meeting",
        body: Buffer.from("audio-data-payload")
      });
      assert.equal(audioResult.accepted, true);
      assert.equal(audioResult.sequence, 1);
      assert.equal(audioResult.totalChunksReceived, 1);

      // 5. Verify replay data from transcript-api
      const replay = await fetchReplay(apiBaseUrl, session.id);
      assert.equal(replay.session.id, session.id);
      assert.equal(replay.segments.length, 2);
      assert.equal(replay.translations.length, 2);

      // Check session status became live
      const updatedSessionResponse = await fetch(`${apiBaseUrl}/sessions/${session.id}`);
      const updatedSession = await updatedSessionResponse.json();
      assert.equal(updatedSession.status, "live");
      assert.equal(updatedSession.segmentCount, 2);
      assert.equal(updatedSession.translationCount, 2);

      // 6. Stop session
      const stopResponse = await fetch(`${gatewayBaseUrl}/sessions/${session.id}/stop`, {
        method: "POST"
      });
      const stopResult = await stopResponse.json();
      assert.equal(stopResult.ok, true);

      const stoppedSessionResponse = await fetch(`${apiBaseUrl}/sessions/${session.id}`);
      const stoppedSession = await stoppedSessionResponse.json();
      assert.equal(stoppedSession.status, "completed");

      await reader.cancel();
    }
  );
});
