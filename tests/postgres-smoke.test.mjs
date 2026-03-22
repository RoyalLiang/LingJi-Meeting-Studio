import test from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  fetchHealth,
  fetchReplay,
  ingestText,
  runTranscriptMigrations,
  runWithStack
} from "./helpers/stack.mjs";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/tts";

test(
  "postgres backend supports transcript persistence and replay",
  {
    skip: process.env.RUN_POSTGRES_SMOKE !== "true"
  },
  async () => {
    await runTranscriptMigrations(databaseUrl);

    await runWithStack(
      {
        apiPort: 4620,
        gatewayPort: 4621,
        storageBackend: "postgres",
        databaseUrl
      },
      async ({ apiBaseUrl, gatewayBaseUrl }) => {
        const health = await fetchHealth(apiBaseUrl);
        assert.equal(health.storage.backend, "postgres");
        assert.equal(health.storage.databaseName, "tts");

        const session = await createSession(apiBaseUrl, {
          title: "Postgres Smoke Flow"
        });

        await ingestText(
          gatewayBaseUrl,
          session.id,
          "hello launch meeting review the roadmap and summary"
        );

        const replay = await fetchReplay(apiBaseUrl, session.id);

        assert.equal(replay.session.id, session.id);
        assert.equal(replay.segments.length, 1);
        assert.equal(replay.translations.length, 1);
        assert.equal(replay.segments[0].text, "hello launch meeting review the roadmap and summary");
        assert.match(replay.translations[0].text, /路线图/);
      }
    );
  }
);
