import {
  SessionAggregate,
  TranscriptSegmentEntity,
  TranslationEntity,
  attachSessionMetrics,
  shapeReplayPayload
} from "@tts/domain";

export class SessionAppService {
  #store;

  constructor(store) {
    this.#store = store;
  }

  async listSessions() {
    return this.#store.listSessions();
  }

  async createSession(data) {
    const aggregate = SessionAggregate.create(data);
    return this.#store.createSession(aggregate.toSnapshot());
  }

  async getSession(sessionId) {
    const rawSession = await this.#store.getSession(sessionId);
    if (!rawSession) {
      return null;
    }
    const replay = await this.#store.buildReplay(sessionId);
    return attachSessionMetrics(rawSession, replay);
  }

  async updateSession(sessionId, updates) {
    const rawSession = await this.#store.updateSession(sessionId, updates);
    if (!rawSession) {
      return null;
    }
    const replay = await this.#store.buildReplay(sessionId);
    return attachSessionMetrics(rawSession, replay);
  }

  async updateStatus(sessionId, status) {
    return this.#store.updateSessionStatus(sessionId, status);
  }
}

export class TranscriptAppService {
  #store;

  constructor(store) {
    this.#store = store;
  }

  async upsertSegment(sessionId, segmentData) {
    const entity = TranscriptSegmentEntity.create({
      ...segmentData,
      sessionId
    });
    return this.#store.upsertSegment(sessionId, entity.toSnapshot());
  }

  async getSegments(sessionId) {
    const replay = await this.#store.buildReplay(sessionId);
    return replay?.segments ?? null;
  }

  async upsertTranslation(sessionId, translationData) {
    const entity = TranslationEntity.create(translationData);
    return this.#store.upsertTranslation(sessionId, entity.toSnapshot());
  }

  async upsertAudioClip(sessionId, clipData) {
    return this.#store.upsertAudioClip(sessionId, clipData);
  }

  async getAudioClips(sessionId) {
    const replay = await this.#store.buildReplay(sessionId);
    return replay?.audioClips ?? null;
  }

  async putSummary(sessionId, summaryData) {
    return this.#store.putSummary(sessionId, summaryData);
  }
}

export class ReplayAppService {
  #store;

  constructor(store) {
    this.#store = store;
  }

  async buildReplay(sessionId) {
    const rawReplay = await this.#store.buildReplay(sessionId);
    if (!rawReplay) {
      return null;
    }
    return shapeReplayPayload(
      rawReplay.session,
      rawReplay.segments,
      rawReplay.translations,
      rawReplay.audioClips,
      rawReplay.summary
    );
  }
}

export class ShareAppService {
  #store;

  constructor(store) {
    this.#store = store;
  }

  async createShareLink(sessionId, data) {
    return this.#store.createShareLink(sessionId, data);
  }

  async bootstrapShare(token) {
    const shareLink = await this.#store.getShareLinkByToken(token);
    if (!shareLink) {
      return null;
    }

    const replay = await this.#store.buildReplay(shareLink.sessionId);
    if (!replay) {
      return null;
    }

    return {
      shareLink,
      ...replay
    };
  }
}
