import { migratePostgresDatabase } from "./storage/postgres-store.mjs";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run transcript-api migrations.");
}

await migratePostgresDatabase(databaseUrl);
console.log("[transcript-api] migrations applied");
