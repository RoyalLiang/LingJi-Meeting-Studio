CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  payload TEXT CHECK (payload IS NULL OR length(CAST(payload AS BLOB)) <= 1048576),
  payload_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('minutes','full')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(owner_id, request_id),
  CHECK (revoked_at IS NOT NULL OR payload IS NOT NULL)
);
CREATE INDEX shares_owner ON shares(owner_id, created_at DESC);
CREATE INDEX shares_expiry ON shares(expires_at);
