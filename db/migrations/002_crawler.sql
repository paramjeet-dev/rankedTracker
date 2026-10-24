-- Phase 1/2: crawler support columns. Idempotent, safe to run on an existing DB.
BEGIN;
ALTER TABLE job          ADD COLUMN IF NOT EXISTS locked_at  TIMESTAMPTZ;
ALTER TABLE job          ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE job          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE player       ADD COLUMN IF NOT EXISTS profiled_at TIMESTAMPTZ;
ALTER TABLE player       ADD COLUMN IF NOT EXISTS tier_id BIGINT;
ALTER TABLE clan         ADD COLUMN IF NOT EXISTS members_crawled_at TIMESTAMPTZ;
ALTER TABLE group_member ADD COLUMN IF NOT EXISTS logs_fetched_at TIMESTAMPTZ;
ALTER TABLE season       ADD COLUMN IF NOT EXISTS swept_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS job_group_idx
  ON job ((payload->>'groupTag'), (payload->>'seasonId')) WHERE kind = 'group_fetch';
CREATE INDEX IF NOT EXISTS group_member_pending_idx
  ON group_member (group_tag, season_id) WHERE logs_fetched_at IS NULL;
COMMIT;
