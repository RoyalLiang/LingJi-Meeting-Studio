export const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024;
export const MAX_TRANSCRIPT_HINT_CHARS = 4000;

export class DomainError extends Error {
  constructor(message, errorCode = "domain_error", statusCode = 400) {
    super(message);
    this.name = "DomainError";
    this.errorCode = errorCode;
    this.statusCode = statusCode;
  }
}

export class AudioChunkStreamTracker {
  #sessionId;
  #totalChunksReceived = 0;
  #totalBytesReceived = 0;
  #lastSequence = 0;

  constructor(sessionId) {
    this.#sessionId = sessionId;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get totalChunksReceived() {
    return this.#totalChunksReceived;
  }

  get totalBytesReceived() {
    return this.#totalBytesReceived;
  }

  get lastSequence() {
    return this.#lastSequence;
  }

  /**
   * Validates chunk constraints and advances stream sequence & statistics.
   * Throws DomainError with proper errorCode and statusCode on violation.
   */
  recordChunk(metadata, bodyBuffer = Buffer.alloc(0)) {
    const sequence = Number(metadata.sequence);
    const sampleRateHz = Number(metadata.sampleRateHz ?? 16000);
    const channels = Number(metadata.channels ?? 1);
    const byteLength = bodyBuffer.length;
    const isFinalChunk = Boolean(metadata.isFinalChunk);
    const transcriptHint = metadata.transcriptHint ? String(metadata.transcriptHint) : undefined;

    if (!Number.isFinite(sequence) || sequence < 1) {
      throw new DomainError(
        "x-audio-sequence must be greater than or equal to 1.",
        "invalid_audio_sequence",
        400
      );
    }

    if (sampleRateHz < 8000 || sampleRateHz > 192000) {
      throw new DomainError(
        "x-audio-sample-rate must be between 8000 and 192000.",
        "invalid_audio_sample_rate",
        400
      );
    }

    if (channels < 1 || channels > 8) {
      throw new DomainError(
        "x-audio-channels must be between 1 and 8.",
        "invalid_audio_channels",
        400
      );
    }

    if (byteLength > MAX_AUDIO_CHUNK_BYTES) {
      throw new DomainError(
        `Audio chunk exceeds ${MAX_AUDIO_CHUNK_BYTES} bytes.`,
        "audio_chunk_too_large",
        413
      );
    }

    if (!byteLength && !isFinalChunk) {
      throw new DomainError(
        "Audio chunk body cannot be empty unless it is a finalization chunk.",
        "empty_audio_chunk",
        400
      );
    }

    if (transcriptHint && transcriptHint.length > MAX_TRANSCRIPT_HINT_CHARS) {
      throw new DomainError(
        `x-transcript-hint must be shorter than ${MAX_TRANSCRIPT_HINT_CHARS} characters.`,
        "transcript_hint_too_large",
        400
      );
    }

    if (this.#lastSequence > 0 && sequence <= this.#lastSequence) {
      throw new DomainError(
        "x-audio-sequence must be strictly increasing within a session.",
        "audio_sequence_conflict",
        409
      );
    }

    this.#totalChunksReceived += 1;
    this.#totalBytesReceived += byteLength;
    this.#lastSequence = sequence;

    return {
      accepted: true,
      sessionId: this.#sessionId,
      chunkId: metadata.chunkId,
      sequence,
      byteLength,
      totalChunksReceived: this.#totalChunksReceived,
      totalBytesReceived: this.#totalBytesReceived
    };
  }

  reset() {
    this.#totalChunksReceived = 0;
    this.#totalBytesReceived = 0;
    this.#lastSequence = 0;
  }
}
