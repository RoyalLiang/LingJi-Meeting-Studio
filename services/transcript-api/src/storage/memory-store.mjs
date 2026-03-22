import { randomUUID } from "node:crypto";

function ensureMap(map, key) {
  let value = map.get(key);

  if (!value) {
    value = new Map();
    map.set(key, value);
  }

  return value;
}

function defaultConfig(input = {}) {
  return {
    sourceLanguage: input.sourceLanguage ?? "en",
    targetLanguages: Array.isArray(input.targetLanguages) && input.targetLanguages.length > 0
      ? input.targetLanguages
      : ["zh-CN"],
    enableAudioStorage: Boolean(input.enableAudioStorage),
    enableLiveShare: input.enableLiveShare ?? true,
    glossaryIds: Array.isArray(input.glossaryIds) ? input.glossaryIds : [],
    referenceDocumentIds: Array.isArray(input.referenceDocumentIds) ? input.referenceDocumentIds : []
  };
}

function defaultDeviceSelection(input = {}) {
  return {
    microphoneDeviceId: input.microphoneDeviceId,
    systemDeviceId: input.systemDeviceId,
    sourceKind: input.sourceKind ?? "mixed"
  };
}

function applySessionUpdates(session, updates = {}) {
  const next = {
    ...session
  };

  if (Object.prototype.hasOwnProperty.call(updates, "title")) {
    const title = String(updates.title ?? "").trim();

    if (!title) {
      throw new Error("Session title is required.");
    }

    next.title = title;
  }

  return next;
}

export function createMemoryStore() {
  const sessions = new Map();
  const segmentsBySession = new Map();
  const translationsBySession = new Map();
  const audioClipsBySession = new Map();
  const shareLinksByToken = new Map();
  const summariesBySession = new Map();

  function getSession(sessionId) {
    return sessions.get(sessionId) ?? null;
  }

  function getSegments(sessionId) {
    const collection = segmentsBySession.get(sessionId);

    if (!collection) {
      return [];
    }

    return Array.from(collection.values()).sort((left, right) => left.sequence - right.sequence);
  }

  function getTranslations(sessionId) {
    const collection = translationsBySession.get(sessionId);

    if (!collection) {
      return [];
    }

    const segments = getSegments(sessionId);
    const sequenceBySegmentId = new Map(segments.map((segment) => [segment.segmentId, segment.sequence]));

    return Array.from(collection.values()).sort((left, right) => {
      const leftSequence = sequenceBySegmentId.get(left.segmentId) ?? Number.MAX_SAFE_INTEGER;
      const rightSequence = sequenceBySegmentId.get(right.segmentId) ?? Number.MAX_SAFE_INTEGER;

      if (leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }

      return left.targetLanguage.localeCompare(right.targetLanguage);
    });
  }

  function getSummary(sessionId) {
    return summariesBySession.get(sessionId) ?? null;
  }

  function getAudioClips(sessionId) {
    const collection = audioClipsBySession.get(sessionId);

    if (!collection) {
      return [];
    }

    return Array.from(collection.values()).sort((left, right) => {
      if (left.sequence !== right.sequence) {
        return left.sequence - right.sequence;
      }

      return left.createdAt.localeCompare(right.createdAt);
    });
  }

  return {
    kind: "memory",
    async health() {
      return {
        ok: true,
        backend: "memory"
      };
    },
    async close() {
      return undefined;
    },
    async createSession(input = {}) {
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        workspaceId: input.workspaceId ?? "demo-workspace",
        folderId: input.folderId,
        title: input.title ?? `Session ${new Date(now).toLocaleString("zh-CN")}`,
        status: "created",
        deviceSelection: defaultDeviceSelection(input.deviceSelection),
        config: defaultConfig(input.config),
        createdAt: now,
        startedAt: undefined,
        endedAt: undefined
      };

      sessions.set(session.id, session);
      return session;
    },
    async listSessions() {
      return Array.from(sessions.values())
        .map((session) => ({
          ...session,
          segmentCount: getSegments(session.id).length,
          translationCount: getTranslations(session.id).length
        }))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async getSession(sessionId) {
      return getSession(sessionId);
    },
    async updateSession(sessionId, updates = {}) {
      const session = getSession(sessionId);

      if (!session) {
        return null;
      }

      const next = applySessionUpdates(session, updates);
      sessions.set(sessionId, next);
      return next;
    },
    async updateSessionStatus(sessionId, status) {
      const session = getSession(sessionId);

      if (!session) {
        return null;
      }

      const next = {
        ...session,
        status
      };

      if (status === "live" && !next.startedAt) {
        next.startedAt = new Date().toISOString();
      }

      if ((status === "completed" || status === "failed") && !next.endedAt) {
        next.endedAt = new Date().toISOString();
      }

      sessions.set(sessionId, next);
      return next;
    },
    async upsertSegment(sessionId, segment) {
      if (!getSession(sessionId)) {
        return null;
      }

      const collection = ensureMap(segmentsBySession, sessionId);
      collection.set(segment.segmentId, {
        ...segment,
        sessionId
      });

      return collection.get(segment.segmentId);
    },
    async getSegments(sessionId) {
      return getSegments(sessionId);
    },
    async upsertTranslation(sessionId, translation) {
      if (!getSession(sessionId)) {
        return null;
      }

      const collection = ensureMap(translationsBySession, sessionId);
      const key = `${translation.segmentId}:${translation.targetLanguage}`;

      collection.set(key, {
        ...translation
      });

      return collection.get(key);
    },
    async getTranslations(sessionId) {
      return getTranslations(sessionId);
    },
    async upsertAudioClip(sessionId, audioClip) {
      if (!getSession(sessionId)) {
        return null;
      }

      const collection = ensureMap(audioClipsBySession, sessionId);
      const persistedClip = {
        audioClipId: audioClip.audioClipId ?? randomUUID(),
        sessionId,
        segmentId: audioClip.segmentId,
        sequence: audioClip.sequence ?? 0,
        targetLanguage: audioClip.targetLanguage,
        provider: audioClip.provider,
        format: audioClip.format,
        mimeType: audioClip.mimeType,
        byteLength: audioClip.byteLength,
        dataBase64: audioClip.dataBase64,
        createdAt: audioClip.createdAt ?? new Date().toISOString()
      };

      collection.set(persistedClip.audioClipId, persistedClip);
      return persistedClip;
    },
    async getAudioClips(sessionId) {
      return getAudioClips(sessionId);
    },
    async createShareLink(sessionId, input = {}) {
      if (!getSession(sessionId)) {
        return null;
      }

      const now = Date.now();
      const expiresInHours = Number(input.expiresInHours ?? 24);
      const shareLink = {
        id: randomUUID(),
        sessionId,
        token: randomUUID(),
        access: input.access ?? "anonymous_view",
        expiresAt: new Date(now + expiresInHours * 60 * 60 * 1000).toISOString(),
        revokedAt: undefined
      };

      shareLinksByToken.set(shareLink.token, shareLink);
      return shareLink;
    },
    async getShareLinkByToken(token) {
      const link = shareLinksByToken.get(token);

      if (!link) {
        return null;
      }

      if (link.revokedAt) {
        return null;
      }

      if (link.expiresAt && Date.now() > Date.parse(link.expiresAt)) {
        return null;
      }

      return link;
    },
    async putSummary(sessionId, summary) {
      if (!getSession(sessionId)) {
        return null;
      }

      summariesBySession.set(sessionId, summary);
      return summary;
    },
    async getSummary(sessionId) {
      return getSummary(sessionId);
    },
    async buildReplay(sessionId) {
      const session = getSession(sessionId);

      if (!session) {
        return null;
      }

      return {
        session,
        segments: getSegments(sessionId),
        translations: getTranslations(sessionId),
        audioClips: getAudioClips(sessionId),
        summary: getSummary(sessionId)
      };
    }
  };
}
