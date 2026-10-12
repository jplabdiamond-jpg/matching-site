-- プレミアム「シークレットモード」: 足跡を残さず、検索・一覧に出ない
ALTER TABLE profiles ADD COLUMN secret_mode INTEGER NOT NULL DEFAULT 0;
