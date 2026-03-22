import { createMemoryStore } from "./storage/memory-store.mjs";
import { createPostgresStore } from "./storage/postgres-store.mjs";

export async function createStore(options = {}) {
  const storageBackend = options.storageBackend
    ?? process.env.TRANSCRIPT_API_STORAGE
    ?? "memory";

  if (storageBackend === "postgres") {
    return createPostgresStore({
      databaseUrl: options.databaseUrl ?? process.env.DATABASE_URL,
      autoMigrate: options.autoMigrate ?? process.env.TRANSCRIPT_API_AUTO_MIGRATE === "true"
    });
  }

  return createMemoryStore();
}
