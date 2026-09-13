-- ============================================================
-- Matching app — Cloudflare D1 schema
-- Apply: wrangler d1 execute matching --file=./schema.sql
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---- users: 認証情報 ----------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,              -- uuid
  email         TEXT UNIQUE NOT NULL,
  pass_hash     TEXT NOT NULL,                 -- pbkdf2(salt:hash)
  plan          TEXT NOT NULL DEFAULT 'free',  -- free | standard | premium
  age_verified  INTEGER NOT NULL DEFAULT 0,    -- 0/1 年齢確認
  stripe_customer_id TEXT,
  created_at    INTEGER NOT NULL
);

-- ---- profiles: 公開プロフィール -----------------------------
CREATE TABLE IF NOT EXISTS profiles (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  gender      TEXT NOT NULL,                   -- male | female | other
  age         INTEGER NOT NULL,
  area        TEXT NOT NULL,                   -- 都道府県
  tagline     TEXT,                            -- 一言コメント
  bio         TEXT,
  photo_key   TEXT,                            -- R2 object key（無ければ初期アバター）
  verified    INTEGER NOT NULL DEFAULT 0,      -- 本人確認済みバッジ
  last_active INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_filter ON profiles(gender, area, age);
CREATE INDEX IF NOT EXISTS idx_profiles_active ON profiles(last_active DESC);

-- ---- likes: いいね -----------------------------------------
CREATE TABLE IF NOT EXISTS likes (
  from_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_to ON likes(to_id);

-- ---- matches: 相互いいね成立 --------------------------------
CREATE TABLE IF NOT EXISTS matches (
  id        TEXT PRIMARY KEY,
  a_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (a_id, b_id)
);

-- ---- messages: メッセージ（フェーズ2でDO化）-----------------
CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  match_id  TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  from_id   TEXT NOT NULL,
  body      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_match ON messages(match_id, created_at);

-- ---- subscriptions: 課金状態（Stripe Webhookで更新）---------
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_sub_id TEXT,
  plan       TEXT NOT NULL,
  status     TEXT NOT NULL,                    -- active | past_due | canceled
  current_period_end INTEGER,
  updated_at INTEGER NOT NULL
);

-- ============================================================
-- サンプル会員（Explorer 表示確認用・初期表示データ）
-- 実データ投入後は削除可
-- ============================================================
INSERT OR IGNORE INTO users (id,email,pass_hash,plan,age_verified,created_at) VALUES
 ('u_sample1','sample1@example.com','x','free',1,0),
 ('u_sample2','sample2@example.com','x','free',1,0),
 ('u_sample3','sample3@example.com','x','free',1,0),
 ('u_sample4','sample4@example.com','x','free',1,0),
 ('u_sample5','sample5@example.com','x','free',1,0),
 ('u_sample6','sample6@example.com','x','free',1,0);

INSERT OR IGNORE INTO profiles
 (user_id,display_name,gender,age,area,tagline,bio,verified,last_active,created_at) VALUES
 ('u_sample1','あおい','female',34,'東京都','静かなカフェで話せる人を探しています','同じ立場だからこそ、力を抜いて話せる関係が理想です。',1,1757700000,1757600000),
 ('u_sample2','はると','male',41,'神奈川県','週末に散歩やドライブを','聞き役が得意です。まずは気軽にメッセージから。',1,1757699000,1757600000),
 ('u_sample3','ゆい','female',29,'大阪府','映画とお酒が好き','無理のないペースで、心地よい距離感を大切にしたいです。',0,1757698000,1757600000),
 ('u_sample4','そうた','male',38,'愛知県','美術館めぐりが趣味','穏やかな時間を共有できたら嬉しいです。',1,1757697000,1757600000),
 ('u_sample5','みお','female',45,'福岡県','美味しいご飯とおしゃべり','日常の小さな話を分かち合える人と出会えたら。',1,1757696000,1757600000),
 ('u_sample6','けん','male',33,'北海道','アウトドアと読書','誠実にやり取りできる方を希望します。',0,1757695000,1757600000);
