-- ============================================================
-- Phase 1: 身バレ・プライバシー強化
-- Apply: wrangler d1 execute matching --remote --file=./migrations/001_phase1_privacy.sql
-- 一度だけ実行してください（カラム追加は再実行するとエラーになります）
-- ============================================================

-- 写真ぼかし（マッチするまで写真を非公開にする）/ 忍び足 / 休会
ALTER TABLE profiles ADD COLUMN photo_blur INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN stealth    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN suspended  INTEGER NOT NULL DEFAULT 0;

-- 知り合い回避：自分の電話番号ハッシュ（相手が避けている場合に使う）
ALTER TABLE users ADD COLUMN phone_hash TEXT;

-- 知り合い回避：避けたい相手の電話番号ハッシュ一覧
CREATE TABLE IF NOT EXISTS avoid_contacts (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_avoid_hash  ON avoid_contacts(hash);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_hash);
CREATE INDEX IF NOT EXISTS idx_profiles_suspended ON profiles(suspended);
