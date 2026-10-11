export class TranscriptApiClient {
  #baseUrl;

  constructor(baseUrl = process.env.TRANSCRIPT_API_BASE_URL ?? "http://127.0.0.1:3020") {
    this.#baseUrl = baseUrl;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  async postJson(path, body) {
    const url = `${this.#baseUrl}${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${detail}`);
    }

    return response.json();
  }

  async syncSessionStatus(sessionId, action) {
    try {
      await this.postJson(`/sessions/${sessionId}/${action}`, {});
      return true;
    } catch (error) {
      console.warn(
        `[session-gateway] failed to sync session ${action}`,
        error instanceof Error ? error.message : error
      );
      return false;
    }
  }

  async persistSegment(sessionId, segment) {
    try {
      return await this.postJson(`/sessions/${sessionId}/segments`, segment);
    } catch (error) {
      console.warn(
        "[session-gateway] failed to persist segment",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  async persistTranslation(sessionId, translation) {
    try {
      return await this.postJson(`/sessions/${sessionId}/translations`, translation);
    } catch (error) {
      console.warn(
        "[session-gateway] failed to persist translation artifact",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  async persistAudioClip(sessionId, audioClip) {
    try {
      return await this.postJson(`/sessions/${sessionId}/audio-clips`, audioClip);
    } catch (error) {
      console.warn(
        "[session-gateway] failed to persist audio clip artifact",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }
}
