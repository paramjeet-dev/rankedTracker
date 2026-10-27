-- Phase B: retry/invalid state for clan roster discovery.
-- Additive and idempotent: safe to run more than once, and the old crawler ignores the new columns.
ALTER TABLE clan
  ADD COLUMN IF NOT EXISTS fail_count      integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS invalid_at      timestamptz,
  ADD COLUMN IF NOT EXISTS member_count    integer;

-- Targets for the "new" pool: clans whose roster was never crawled.
CREATE INDEX IF NOT EXISTS clan_never_crawled_idx
  ON clan (clan_tag)
  WHERE members_crawled_at IS NULL AND invalid_at IS NULL;
