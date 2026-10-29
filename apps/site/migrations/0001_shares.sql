CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('minutes','full')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(owner_id, request_id)
);
CREATE INDEX shares_owner ON shares(owner_id, created_at DESC);
CREATE INDEX shares_expiry ON shares(expires_at);
