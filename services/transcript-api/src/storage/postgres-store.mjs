import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sqlDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../sql");

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

async function loadPool(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when TRANSCRIPT_API_STORAGE=postgres");
  }

  let pgModule;

  try {
    pgModule = await import("pg");
  } catch {
    throw new Error("Postgres backend requires the `pg` package. Run `npm.cmd install` in the workspace first.");
  }

  const Pool = pgModule.Pool ?? pgModule.default?.Pool;

  if (!Pool) {
    throw new Error("Unable to load `pg` Pool constructor.");
  }

  return new Pool({
    connectionString: databaseUrl
  });
}

function parseDatabaseName(databaseUrl) {
  const url = new URL(databaseUrl);
  const databaseName = url.pathname.replace(/^\//, "");

  if (!databaseName) {
    throw new Error("DATABASE_URL must include a database name.");
  }

  if (!/^[A-Za-z0-9_-]+$/.test(databaseName)) {
    throw new Error("Automatic database creation only supports simple database names.");
  }

  return databaseName;
}

function toAdminDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

async function runSchema(pool) {
  const schemaSql = await readFile(path.join(sqlDir, "schema.sql"), "utf8");
  await pool.query(schemaSql);
}

function mapSessionRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    folderId: row.folder_id ?? undefined,
    title: row.title,
    status: row.status,
    deviceSelection: row.device_selection,
    config: row.config,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString(),
    endedAt: row.ended_at?.toISOString()
  };
}

function mapSegmentRow(row) {
  return {
    segmentId: row.segment_id,
    sessionId: row.session_id,
    sequence: row.sequence,
    status: row.status,
    sourceLanguage: row.source_language,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    confidence: row.confidence ?? undefined,
    speakerId: row.speaker_id ?? undefined,
    provider: row.provider,
    glossaryHits: row.glossary_hits ?? [],
    receivedAt: row.received_at.toISOString()
  };
}

function mapTranslationRow(row) {
  return {
    segmentId: row.segment_id,
    targetLanguage: row.target_language,
    text: row.text,
    provider: row.provider,
    isFinal: row.is_final
  };
}

function mapShareLinkRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    token: row.token,
    access: row.access,
    expiresAt: row.expires_at?.toISOString(),
    revokedAt: row.revoked_at?.toISOString()
  };
}

function mapSummaryRow(row) {
  if (!row) {
    return null;
  }

  return {
    sessionId: row.session_id,
    summary: row.summary,
    topics: row.topics ?? [],
    actionItems: row.action_items ?? [],
    generatedAt: row.generated_at.toISOString()
  };
}

function mapAudioClipRow(row) {
  return {
    audioClipId: row.audio_clip_id,
    sessionId: row.session_id,
    segmentId: row.segment_id ?? undefined,
    sequence: row.sequence,
    targetLanguage: row.target_language ?? undefined,
    provider: row.provider,
    format: row.format,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    dataBase64: row.audio_data ? Buffer.from(row.audio_data).toString("base64") : "",
    createdAt: row.created_at.toISOString()
  };
}

export async function createPostgresStore(options = {}) {
  const pool = await loadPool(options.databaseUrl);

  if (options.autoMigrate) {
    await runSchema(pool);
  }

  const store = {
    kind: "postgres",
    async health() {
      const result = await pool.query("select current_database() as database_name");
      return {
        ok: true,
        backend: "postgres",
        databaseName: result.rows[0]?.database_name ?? null
      };
    },
    async close() {
      await pool.end();
    },
    async createSession(input = {}) {
      const now = new Date();
      const session = {
        id: randomUUID(),
        workspaceId: input.workspaceId ?? "demo-workspace",
        folderId: input.folderId ?? null,
        title: input.title ?? `Session ${now.toLocaleString("zh-CN")}`,
        status: "created",
        deviceSelection: defaultDeviceSelection(input.deviceSelection),
        config: defaultConfig(input.config),
        createdAt: now.toISOString()
      };

      const result = await pool.query(
        `insert into sessions (
          id, workspace_id, folder_id, title, status, device_selection, config, created_at
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
        returning *`,
        [
          session.id,
          session.workspaceId,
          session.folderId,
          session.title,
          session.status,
          JSON.stringify(session.deviceSelection),
          JSON.stringify(session.config),
          session.createdAt
        ]
      );

      return mapSessionRow(result.rows[0]);
    },
    async listSessions() {
      const result = await pool.query(
        `select
          s.*,
          (select count(*)::int from segments seg where seg.session_id = s.id) as segment_count,
          (select count(*)::int from translations tr where tr.session_id = s.id) as translation_count
        from sessions s
        order by s.created_at desc`
      );

      return result.rows.map((row) => ({
        ...mapSessionRow(row),
        segmentCount: row.segment_count,
        translationCount: row.translation_count
      }));
    },
    async getSession(sessionId) {
      const result = await pool.query("select * from sessions where id = $1", [sessionId]);
      return mapSessionRow(result.rows[0]);
    },
    async updateSession(sessionId, updates = {}) {
      const session = await store.getSession(sessionId);

      if (!session) {
        return null;
      }

      if (!Object.prototype.hasOwnProperty.call(updates, "title")) {
        return session;
      }

      const title = String(updates.title ?? "").trim();

      if (!title) {
        throw new Error("Session title is required.");
      }

      const result = await pool.query(
        `update sessions
         set title = $2
         where id = $1
         returning *`,
        [sessionId, title]
      );

      return mapSessionRow(result.rows[0]);
    },
    async updateSessionStatus(sessionId, status) {
      const result = await pool.query(
        `update sessions
         set
           status = $2,
           started_at = case
             when $2 = 'live' and started_at is null then now()
             else started_at
           end,
           ended_at = case
             when $2 in ('completed', 'failed') and ended_at is null then now()
             else ended_at
           end
         where id = $1
         returning *`,
        [sessionId, status]
      );

      return mapSessionRow(result.rows[0]);
    },
    async upsertSegment(sessionId, segment) {
      const session = await store.getSession(sessionId);

      if (!session) {
        return null;
      }

      const result = await pool.query(
        `insert into segments (
          segment_id, session_id, sequence, status, source_language, start_ms, end_ms,
          text, confidence, speaker_id, provider, glossary_hits, received_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[], $13)
        on conflict (segment_id) do update set
          sequence = excluded.sequence,
          status = excluded.status,
          source_language = excluded.source_language,
          start_ms = excluded.start_ms,
          end_ms = excluded.end_ms,
          text = excluded.text,
          confidence = excluded.confidence,
          speaker_id = excluded.speaker_id,
          provider = excluded.provider,
          glossary_hits = excluded.glossary_hits,
          received_at = excluded.received_at
        returning *`,
        [
          segment.segmentId,
          sessionId,
          segment.sequence,
          segment.status,
          segment.sourceLanguage,
          segment.startMs,
          segment.endMs,
          segment.text,
          segment.confidence ?? null,
          segment.speakerId ?? null,
          segment.provider,
          segment.glossaryHits ?? [],
          segment.receivedAt
        ]
      );

      return mapSegmentRow(result.rows[0]);
    },
    async getSegments(sessionId) {
      const result = await pool.query(
        "select * from segments where session_id = $1 order by sequence asc",
        [sessionId]
      );
      return result.rows.map(mapSegmentRow);
    },
    async upsertTranslation(sessionId, translation) {
      const session = await store.getSession(sessionId);

      if (!session) {
        return null;
      }

      const result = await pool.query(
        `insert into translations (
          session_id, segment_id, target_language, text, provider, is_final
        ) values ($1, $2, $3, $4, $5, $6)
        on conflict (segment_id, target_language) do update set
          text = excluded.text,
          provider = excluded.provider,
          is_final = excluded.is_final
        returning *`,
        [
          sessionId,
          translation.segmentId,
          translation.targetLanguage,
          translation.text,
          translation.provider,
          translation.isFinal
        ]
      );

      return mapTranslationRow(result.rows[0]);
    },
    async getTranslations(sessionId) {
      const result = await pool.query(
        `select tr.*
         from translations tr
         join segments seg on seg.segment_id = tr.segment_id
         where tr.session_id = $1
         order by seg.sequence asc, tr.target_language asc`,
        [sessionId]
      );
      return result.rows.map(mapTranslationRow);
    },
    async upsertAudioClip(sessionId, audioClip) {
      const session = await store.getSession(sessionId);

      if (!session) {
        return null;
      }

      const result = await pool.query(
        `insert into session_audio_clips (
          audio_clip_id, session_id, segment_id, sequence, target_language,
          provider, format, mime_type, byte_length, audio_data, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        on conflict (audio_clip_id) do update set
          segment_id = excluded.segment_id,
          sequence = excluded.sequence,
          target_language = excluded.target_language,
          provider = excluded.provider,
          format = excluded.format,
          mime_type = excluded.mime_type,
          byte_length = excluded.byte_length,
          audio_data = excluded.audio_data,
          created_at = excluded.created_at
        returning *`,
        [
          audioClip.audioClipId ?? randomUUID(),
          sessionId,
          audioClip.segmentId ?? null,
          audioClip.sequence ?? 0,
          audioClip.targetLanguage ?? null,
          audioClip.provider,
          audioClip.format,
          audioClip.mimeType,
          audioClip.byteLength,
          audioClip.dataBase64 ? Buffer.from(audioClip.dataBase64, "base64") : Buffer.alloc(0),
          audioClip.createdAt ?? new Date().toISOString()
        ]
      );

      return mapAudioClipRow(result.rows[0]);
    },
    async getAudioClips(sessionId) {
      const result = await pool.query(
        "select * from session_audio_clips where session_id = $1 order by sequence asc, created_at asc",
        [sessionId]
      );
      return result.rows.map(mapAudioClipRow);
    },
    async createShareLink(sessionId, input = {}) {
      const session = await store.getSession(sessionId);

      if (!session) {
        return null;
      }

      const expiresInHours = Number(input.expiresInHours ?? 24);
      const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
      const result = await pool.query(
        `insert into share_links (
          id, session_id, token, access, expires_at, revoked_at
        ) values ($1, $2, $3, $4, $5, null)
        returning *`,
        [randomUUID(), sessionId, randomUUID(), input.access ?? "anonymous_view", expiresAt]
      );

      return mapShareLinkRow(result.rows[0]);
    },
    async getShareLinkByToken(token) {
      const result = await pool.query(
        `select * from share_links
         where token = $1
           and revoked_at is null
           and (expires_at is null or expires_at > now())`,
        [token]
      );

      return mapShareLinkRow(result.rows[0]);
    },
    async putSummary(sessionId, summary) {
      const session = await store.getSession(sessionId);

      if (!session) {
        return null;
      }

      const generatedAt = summary.generatedAt ?? new Date().toISOString();
      const result = await pool.query(
        `insert into ai_summaries (
          session_id, summary, topics, action_items, generated_at
        ) values ($1, $2, $3::jsonb, $4::jsonb, $5)
        on conflict (session_id) do update set
          summary = excluded.summary,
          topics = excluded.topics,
          action_items = excluded.action_items,
          generated_at = excluded.generated_at
        returning *`,
        [
          sessionId,
          summary.summary,
          JSON.stringify(summary.topics ?? []),
          JSON.stringify(summary.actionItems ?? []),
          generatedAt
        ]
      );

      return mapSummaryRow(result.rows[0]);
    },
    async getSummary(sessionId) {
      const result = await pool.query(
        "select * from ai_summaries where session_id = $1",
        [sessionId]
      );
      return mapSummaryRow(result.rows[0]);
    },
    async buildReplay(sessionId) {
      const [session, segments, translations, audioClips, summary] = await Promise.all([
        store.getSession(sessionId),
        store.getSegments(sessionId),
        store.getTranslations(sessionId),
        store.getAudioClips(sessionId),
        store.getSummary(sessionId)
      ]);

      if (!session) {
        return null;
      }

      return {
        session,
        segments,
        translations,
        audioClips,
        summary
      };
    }
  };

  return store;
}

export async function migratePostgresDatabase(databaseUrl) {
  try {
    const pool = await loadPool(databaseUrl);

    try {
      await runSchema(pool);
    } finally {
      await pool.end();
    }
  } catch (error) {
    if (error?.code !== "3D000") {
      throw error;
    }

    const databaseName = parseDatabaseName(databaseUrl);
    const adminPool = await loadPool(toAdminDatabaseUrl(databaseUrl));

    try {
      const existsResult = await adminPool.query(
        "select 1 from pg_database where datname = $1",
        [databaseName]
      );

      if (existsResult.rowCount === 0) {
        await adminPool.query(`create database "${databaseName}"`);
      }
    } finally {
      await adminPool.end();
    }

    const targetPool = await loadPool(databaseUrl);

    try {
      await runSchema(targetPool);
    } finally {
      await targetPool.end();
    }
  }
}
