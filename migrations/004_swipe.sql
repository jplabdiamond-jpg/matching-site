-- スワイプUI/お気に入り/メッセージ付きいいね
CREATE TABLE IF NOT EXISTS passes (
  user_id    TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'reject',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_id)
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id    TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_id)
);
ALTER TABLE likes ADD COLUMN message TEXT;
