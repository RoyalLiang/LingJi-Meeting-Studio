function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function buildDraft(status, text, confidence) {
  return {
    status,
    text,
    confidence,
    provider: "mock-asr"
  };
}

export function createMockAsrProvider() {
  return {
    name: "mock",
    providerId: "mock-asr",
    createSessionState() {
      return {
        chunkCount: 0
      };
    },
    disposeSessionState() {
      return undefined;
    },
    async *transcribeText(input) {
      const trimmed = String(input.text ?? "").trim();

      if (!trimmed) {
        throw new Error("text is required");
      }

      const words = trimmed.split(/\s+/);
      const chunkSize = Math.max(1, Math.ceil(words.length / 3));

      for (let index = chunkSize; index < words.length; index += chunkSize) {
        await sleep(140);
        yield buildDraft("partial", words.slice(0, index).join(" "), 0.7);
      }

      yield buildDraft("final", trimmed, 0.95);
    },
    async *transcribeAudioChunk(input) {
      input.sessionState.chunkCount += 1;

      if (input.metadata.isFinalChunk && input.metadata.transcriptHint) {
        yield buildDraft("final", input.metadata.transcriptHint, 0.95);
      }
    }
  };
}
