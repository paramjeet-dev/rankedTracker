-- Where does request time go? queue_ms = waited in the gateway queue, ttfb_ms = gateway -> official API first byte.
-- status = 0 rows are failed attempts (err holds the error code).
ALTER TABLE fetch_log ADD COLUMN IF NOT EXISTS queue_ms int, ADD COLUMN IF NOT EXISTS ttfb_ms int, ADD COLUMN IF NOT EXISTS err text;
CREATE INDEX IF NOT EXISTS fetch_log_at ON fetch_log (at);
