import { randomUUID } from "node:crypto";
import {
  createAsrProviderSessionState,
  disposeAsrProviderSessionState
} from "../providers/index.mjs";
import {
  normalizeSourceLanguage,
  resolveSegmentSourceLanguage,
  normalizeDraftText,
  progressiveDraftEvents,
  createRealtimeEnvelope,
  createSegmentUpsertedEvent,
  createTranslationUpsertedEvent,
  createAudioClipReceivedEvent
} from "@tts/domain";

export class AsrOrchestratorComponent {
  #providerStateBySession = new Map();
  #sequenceBySession = new Map();
  #offsetBySession = new Map();
  #transcriptDraftStateBySession = new Map();
  #broadcaster;
  #translationService;
  #apiClient;

  constructor({ broadcaster, translationService, apiClient }) {
    this.#broadcaster = broadcaster;
    this.#translationService = translationService;
    this.#apiClient = apiClient;
  }

  getProviderSessionState(provider, sessionId) {
    let sessionState = this.#providerStateBySession.get(sessionId);
    if (!sessionState) {
      sessionState = createAsrProviderSessionState(provider, sessionId);
      this.#providerStateBySession.set(sessionId, sessionState);
    }
    return sessionState;
  }

  async disposeSession(provider, sessionId) {
    const sessionState = this.#providerStateBySession.get(sessionId);
    this.#providerStateBySession.delete(sessionId);
    this.#sequenceBySession.delete(sessionId);
    this.#offsetBySession.delete(sessionId);
    this.#transcriptDraftStateBySession.delete(sessionId);
    if (sessionState) {
      await disposeAsrProviderSessionState(provider, sessionState);
    }
  }

  nextSequence(sessionId) {
    const current = this.#sequenceBySession.get(sessionId) ?? 0;
    const next = current + 1;
    this.#sequenceBySession.set(sessionId, next);
    return next;
  }

  nextTiming(sessionId, wordCount) {
    const startMs = this.#offsetBySession.get(sessionId) ?? 0;
    const durationMs = Math.max(900, wordCount * 260);
    const endMs = startMs + durationMs;
    this.#offsetBySession.set(sessionId, endMs + 280);
    return {
      startMs,
      endMs
    };
  }

  ensureTranscriptDraftState(sessionId) {
    let state = this.#transcriptDraftStateBySession.get(sessionId);
    if (!state) {
      state = {
        byProviderSequence: new Map(),
        audioBuildersBySequence: new Map(),
        emittedTextByKey: new Map()
      };
      this.#transcriptDraftStateBySession.set(sessionId, state);
    }
    return state;
  }

  ensureSegmentRecord(sessionId, draft, input) {
    const transcriptState = this.ensureTranscriptDraftState(sessionId);
    const providerSequence =
      draft.sequenceHint ?? `${draft.channel ?? "source"}:${draft.providerMessageType ?? "default"}`;
    let record = transcriptState.byProviderSequence.get(providerSequence);

    if (!record) {
      const estimatedText = String(input.estimatedText ?? draft.text ?? "").trim() || "pending";
      const words = estimatedText.split(/\s+/);
      record = {
        providerSequence,
        segmentId: randomUUID(),
        sequence: this.nextSequence(sessionId),
        timing: this.nextTiming(sessionId, words.length)
      };
      transcriptState.byProviderSequence.set(providerSequence, record);
    }

    return record;
  }

  async persistFinalArtifacts(sessionId, segment, targetLanguages) {
    await this.#apiClient.persistSegment(sessionId, segment);

    for (const targetLanguage of targetLanguages) {
      const translatedText = this.#translationService.translate(
        segment.text,
        targetLanguage,
        segment.sourceLanguage
      );

      if (translatedText !== null) {
        const translation = {
          segmentId: segment.segmentId,
          targetLanguage,
          text: translatedText,
          provider: "mock-translate",
          isFinal: true
        };

        await this.#apiClient.persistTranslation(sessionId, translation);
        this.#broadcaster.broadcast(
          sessionId,
          createTranslationUpsertedEvent(sessionId, translation)
        );
      }
    }
  }

  async persistAudioClipArtifact(sessionId, audioClip) {
    const persistedAudioClip = await this.#apiClient.persistAudioClip(sessionId, audioClip);
    if (persistedAudioClip) {
      this.#broadcaster.broadcast(
        sessionId,
        createAudioClipReceivedEvent(sessionId, persistedAudioClip)
      );
    }
  }

  async emitTranscriptDrafts(sessionId, input, drafts) {
    const requestedSourceLanguage = normalizeSourceLanguage(input.sourceLanguage, "en");
    const targetLanguages =
      Array.isArray(input.targetLanguages) && input.targetLanguages.length > 0
        ? input.targetLanguages
        : ["zh-CN"];
    let usingStructuredDrafts = false;
    let segmentId = null;
    let sequence = null;
    let timing = null;
    let finalSegment = null;

    for await (const draft of drafts) {
      if (draft.kind === "audio_start") {
        const transcriptState = this.ensureTranscriptDraftState(sessionId);
        const record = this.ensureSegmentRecord(
          sessionId,
          {
            ...draft,
            channel: "translation"
          },
          input
        );
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
        const transcriptState = this.ensureTranscriptDraftState(sessionId);
        const record = this.ensureSegmentRecord(
          sessionId,
          {
            ...draft,
            channel: "translation"
          },
          input
        );
        const builder =
          transcriptState.audioBuildersBySequence.get(record.providerSequence) ?? {
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
        const transcriptState = this.ensureTranscriptDraftState(sessionId);
        const record = this.ensureSegmentRecord(
          sessionId,
          {
            ...draft,
            channel: "translation"
          },
          input
        );
        const builder = transcriptState.audioBuildersBySequence.get(record.providerSequence);

        if (builder && builder.chunks.length > 0) {
          const audioBuffer = Buffer.concat(builder.chunks);
          await this.persistAudioClipArtifact(sessionId, {
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
        const record = this.ensureSegmentRecord(sessionId, draft, input);
        const transcriptState = this.ensureTranscriptDraftState(sessionId);
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

          this.#broadcaster.broadcast(
            sessionId,
            createTranslationUpsertedEvent(sessionId, translation)
          );

          if (translation.isFinal) {
            await this.#apiClient.persistTranslation(sessionId, translation);
          }
        }

        transcriptState.emittedTextByKey.set(progressKey, normalizeDraftText(draft.text));
        continue;
      }

      if (draft.kind === "transcript" && (draft.channel || draft.sequenceHint !== undefined)) {
        usingStructuredDrafts = true;
        const record = this.ensureSegmentRecord(sessionId, draft, input);
        const transcriptState = this.ensureTranscriptDraftState(sessionId);
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

          this.#broadcaster.broadcast(sessionId, createSegmentUpsertedEvent(sessionId, segment));

          if (update.status === "final") {
            finalSegment = segment;
            await this.persistFinalArtifacts(sessionId, segment, []);
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
        sequence = this.nextSequence(sessionId);
        timing = this.nextTiming(sessionId, words.length);
      }

      const transcriptState = this.ensureTranscriptDraftState(sessionId);
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

        this.#broadcaster.broadcast(sessionId, createSegmentUpsertedEvent(sessionId, segment));

        if (!draft.channel) {
          for (const targetLanguage of targetLanguages) {
            const translationKey = `translation:${segmentId}:${targetLanguage}`;
            const previousTranslationText =
              transcriptState.emittedTextByKey.get(translationKey) ?? "";
            const nextTranslationText = this.#translationService.mockTranslate(
              update.text,
              targetLanguage
            );
            const translationUpdates = progressiveDraftEvents(
              previousTranslationText,
              nextTranslationText,
              update.status
            );

            for (const translationUpdate of translationUpdates) {
              this.#broadcaster.broadcast(
                sessionId,
                createTranslationUpsertedEvent(sessionId, {
                  segmentId,
                  targetLanguage,
                  text: translationUpdate.text,
                  provider: "mock-translate",
                  isFinal: translationUpdate.status === "final"
                })
              );
            }

            transcriptState.emittedTextByKey.set(
              translationKey,
              normalizeDraftText(nextTranslationText)
            );
          }
        }

        if (update.status === "final") {
          finalSegment = segment;
        }
      }

      transcriptState.emittedTextByKey.set(progressKey, normalizeDraftText(draft.text));
    }

    if (finalSegment && !usingStructuredDrafts) {
      await this.persistFinalArtifacts(sessionId, finalSegment, targetLanguages);
    }

    return finalSegment;
  }
}
