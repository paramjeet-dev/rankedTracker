-- Phase E: state for collecting the battles of finished seasons. Additive and idempotent.
ALTER TABLE league_group
  ADD COLUMN IF NOT EXISTS collected_at            timestamptz,   -- collection for this group finished (status settled)
  ADD COLUMN IF NOT EXISTS collect_fail_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS collect_next_attempt_at timestamptz;

-- Groups the old crawler already settled are not collected again.
UPDATE league_group SET collected_at = COALESCE(fetched_at, now())
 WHERE collected_at IS NULL AND status IN ('complete', 'incomplete');

-- Targets: newest season first.
CREATE INDEX IF NOT EXISTS league_group_uncollected_idx
  ON league_group (season_id DESC, group_tag DESC)
  WHERE collected_at IS NULL AND status <> 'complete';
