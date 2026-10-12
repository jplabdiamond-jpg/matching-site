-- 「あなたに興味があるユーザー」機能: 閲覧回数と滞在時間を記録
ALTER TABLE footprints ADD COLUMN cnt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE footprints ADD COLUMN dwell_ms INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_footprints_interest ON footprints(owner_id, cnt, dwell_ms);
