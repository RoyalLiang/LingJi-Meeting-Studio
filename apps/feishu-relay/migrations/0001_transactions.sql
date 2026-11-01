CREATE TABLE IF NOT EXISTS oauth_transactions (
 state_hash TEXT PRIMARY KEY,
 client_id TEXT NOT NULL,
 challenge TEXT NOT NULL,
 claim_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 result_expires_at INTEGER,
 result TEXT,
 status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_transactions(expires_at);
CREATE TABLE IF NOT EXISTS oauth_rate_limits (bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS oauth_rate_expiry ON oauth_rate_limits(expires_at);
