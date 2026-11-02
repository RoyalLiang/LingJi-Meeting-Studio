CREATE TABLE encrypted_shares (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  revoke_hash TEXT NOT NULL,
  creator_hash TEXT NOT NULL,
  payload TEXT CHECK (payload IS NULL OR length(CAST(payload AS BLOB)) <= 1048576),
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX encrypted_shares_creator ON encrypted_shares(creator_hash, created_at);
CREATE INDEX encrypted_shares_expiry ON encrypted_shares(expires_at);
CREATE INDEX encrypted_shares_created ON encrypted_shares(created_at);
