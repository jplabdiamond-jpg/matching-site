// ============================================================
// Matching app — Cloudflare Worker
// auth / explorer / likes+matches / messaging / R2 photos / verification / Stripe
// ============================================================

const INF = Infinity;
const PLANS = {
  free:     { likesPerMonth: 10,  msgPerMatch: 3,   gallery: 1,  footprints: 3,    advSearch: false, sortable: false, likesReveal: 1,   boost: false, paid: false },
  standard: { likesPerMonth: 30,  msgPerMatch: INF, gallery: 5,  footprints: 10,   advSearch: true,  sortable: true,  likesReveal: INF, boost: false, paid: true  },
  premium:  { likesPerMonth: INF, msgPerMatch: INF, gallery: 10, footprints: 1000, advSearch: true,  sortable: true,  likesReveal: INF, boost: true,  paid: true  },
};
function planLimits(plan) { return PLANS[plan] || PLANS.free; }
// Infinity を JSON 用に -1（無制限）へ
function limitsForClient(plan) {
  const l = planLimits(plan), out = {};
  for (const k in l) out[k] = (l[k] === INF ? -1 : l[k]);
  return out;
}
// 今月（JST）の開始エポックms
function monthStartMs() {
  const j = new Date(Date.now() + 9 * 3600000);
  return Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), 1) - 9 * 3600000;
}
// 「あなたに興味があるユーザー」判定: 閲覧2回以上 または 滞在5秒以上
const INTEREST_VISITS = 2, INTEREST_DWELL_MS = 5000;
// プラン切替を許可する管理用アカウント（logo / 管理）
const DEV_EMAILS = ['trustlogi2023@gmail.com', 'jp.lab.diamond@gmail.com'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url, ctx);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

async function route(request, env, url, ctx) {
  const p = url.pathname, m = request.method;

  if (p === '/api/signup'   && m === 'POST') return signup(request, env);
  if (p === '/api/login'    && m === 'POST') return login(request, env);
  if (p === '/api/logout'   && m === 'POST') return logout(request, env);
  if (p === '/api/me'       && m === 'GET')  return me(request, env);
  if (p === '/api/auth/google'          && m === 'GET') return googleStart(request, env);
  if (p === '/api/auth/google/callback' && m === 'GET') return googleCallback(request, env);
  if (p === '/api/onboard'  && m === 'POST') return onboard(request, env);
  if (p === '/api/profiles' && m === 'GET')  return listProfiles(request, env, url);
  if (p === '/api/like'     && m === 'POST') return like(request, env, ctx);
  if (p === '/api/pass'     && m === 'POST') return passProfile(request, env);
  if (p === '/api/favorite' && m === 'POST') return favorite(request, env);
  if (p === '/api/favorites'&& m === 'GET')  return favoritesList(request, env);
  if (p === '/api/matches'  && m === 'GET')  return listMatches(request, env);
  if (p === '/api/likes/received' && m === 'GET') return likesReceived(request, env);
  if (p === '/api/footprints'     && m === 'GET') return footprints(request, env);
  if (p === '/api/interested'     && m === 'GET') return interested(request, env);
  if (p === '/api/view/dwell'     && m === 'POST') return recordDwell(request, env);
  if (p === '/api/conversations'  && m === 'GET') return conversations(request, env);
  if (p === '/api/unread'         && m === 'GET') return unread(request, env);
  if (p === '/api/read'           && m === 'POST') return markRead(request, env);
  if (p === '/api/profile'         && m === 'GET')  return profileOne(request, env, url);
  if (p === '/api/unmatch'         && m === 'POST') return unmatch(request, env);
  if (p === '/api/report'          && m === 'POST') return report(request, env);
  if (p === '/api/messages/delete' && m === 'POST') return messagesDelete(request, env);
  if (p === '/api/profile/update'  && m === 'POST') return profileUpdate(request, env);
  if (p === '/api/photos/upload'   && m === 'POST') return photoUpload(request, env);
  if (p === '/api/photos/mine'     && m === 'GET')  return photosMine(request, env);
  if (p === '/api/photos/main'     && m === 'POST') return photoMain(request, env);
  if (p === '/api/photos/delete'   && m === 'POST') return photoDelete(request, env);
  if (p === '/api/block'           && m === 'POST') return block(request, env);
  if (p === '/api/unblock'         && m === 'POST') return unblock(request, env);
  if (p === '/api/blocks'          && m === 'GET')  return blocksList(request, env);
  if (p === '/api/privacy'         && m === 'POST') return privacy(request, env);
  if (p === '/api/secret'          && m === 'POST') return secretMode(request, env);
  if (p === '/api/dev/plan'        && m === 'POST') return devSetPlan(request, env);
  if (p === '/api/tags/set'        && m === 'POST') return tagsSet(request, env);
  if (p === '/api/gallery/upload'  && m === 'POST') return galleryUpload(request, env);
  if (p === '/api/gallery/mine'    && m === 'GET')  return galleryMine(request, env);
  if (p === '/api/gallery/delete'  && m === 'POST') return galleryRemove(request, env);
  if (p === '/api/gallery/share'   && m === 'POST') return galleryShare(request, env);
  if (p === '/api/gallery/status'  && m === 'GET')  return galleryStatus(request, env, url);
  if (p === '/api/gallery/view'    && m === 'GET')  return galleryView(request, env, url);
  if (p === '/api/gallery/photo'   && m === 'GET')  return galleryPhoto(request, env, url);
  if (p === '/api/vapid'           && m === 'GET')  return json({ publicKey: env.VAPID_PUBLIC_KEY || '' });
  if (p === '/api/push/subscribe'  && m === 'POST') return pushSubscribe(request, env);
  if (p === '/api/push/unsubscribe'&& m === 'POST') return pushUnsubscribe(request, env);
  if (p === '/api/admin/check'          && m === 'GET')  return adminCheck(request, env);
  if (p === '/api/admin/verifications'  && m === 'GET')  return adminVerifications(request, env);
  if (p === '/api/admin/doc'            && m === 'GET')  return adminDoc(request, env, url);
  if (p === '/api/admin/verify'         && m === 'POST') return adminVerify(request, env);
  if (p === '/api/admin/reports'        && m === 'GET')  return adminReports(request, env);
  if (p === '/api/admin/report/resolve' && m === 'POST') return adminReportResolve(request, env);
  if (p === '/api/admin/ban'            && m === 'POST') return adminBan(request, env);
  if (p === '/api/admin/seed'           && m === 'POST') return adminSeed(request, env);

  // messaging
  if (p === '/api/messages' && m === 'GET')  return listMessages(request, env, url);
  if (p === '/api/messages' && m === 'POST') return sendMessage(request, env, ctx);

  // photos (R2)
  if (p === '/api/upload'   && m === 'POST') return uploadPhoto(request, env);
  if (p === '/api/photo'    && m === 'GET')  return servePhoto(request, env, url);

  // verification
  if (p === '/api/verify'   && m === 'POST') return submitVerification(request, env);

  // billing
  if (p === '/api/checkout' && m === 'POST') return checkout(request, env);
  if (p === '/api/stripe/webhook' && m === 'POST') return stripeWebhook(request, env);

  return json({ error: 'not found' }, 404);
}

// ---------- auth ----------
async function signup(request, env) {
  const { email, password, display_name, gender, age, area } = await request.json();
  if (!email || !password || !display_name || !gender || !age || !area)
    return json({ error: '必須項目が不足しています' }, 400);
  if (Number(age) < 18) return json({ error: '18歳未満はご利用いただけません' }, 400);
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first();
  if (exists) return json({ error: 'このメールは登録済みです' }, 409);

  const id = uuid(), now = Date.now(), hash = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id,email,pass_hash,plan,age_verified,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, email, hash, 'free', 0, now),
    env.DB.prepare(`INSERT INTO profiles (user_id,display_name,gender,age,area,verified,last_active,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).bind(id, display_name, gender, Number(age), area, 0, now, now),
  ]);
  return withSession(id, env, json({ id, email, plan: 'free' }));
}

async function login(request, env) {
  const { email, password } = await request.json();
  const u = await env.DB.prepare('SELECT id,pass_hash,plan FROM users WHERE email=?').bind(email).first();
  if (!u || !(await verifyPassword(password, u.pass_hash)))
    return json({ error: 'メールまたはパスワードが違います' }, 401);
  await env.DB.prepare('UPDATE profiles SET last_active=? WHERE user_id=?').bind(Date.now(), u.id).run();
  return withSession(u.id, env, json({ id: u.id, email, plan: u.plan }));
}

async function logout(request, env) {
  const sid = getCookie(request, 'sid');
  if (sid) await env.SESSIONS.delete('sess:' + sid);
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', 'sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  return res;
}

async function me(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  await env.DB.prepare('UPDATE profiles SET last_active=? WHERE user_id=?').bind(Date.now(), uid).run();
  const u = await env.DB.prepare(
    `SELECT u.id,u.email,u.plan,u.email_verified,u.banned,u.is_admin,p.display_name,p.gender,p.age,p.area,p.tagline,p.bio,p.verified,p.photo_key,p.private_mode,p.secret_mode,
            p.marital,p.children,p.job,p.income,p.education,p.height,p.body_type,p.drinking,p.smoking,p.holiday,p.avail,p.purpose
     FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=?`).bind(uid).first();
  if (u && u.banned) return json({ banned: true });
  if (u) {
    u.needs_onboarding = u.display_name ? 0 : 1;
    const ph = await env.DB.prepare('SELECT key FROM profile_photos WHERE user_id=? ORDER BY created_at ASC').bind(uid).all();
    u.photos = ph.results.map(r => r.key);
    const tg = await env.DB.prepare('SELECT tag FROM profile_tags WHERE user_id=?').bind(uid).all();
    u.tags = tg.results.map(r => r.tag);
    const vr = await env.DB.prepare('SELECT status FROM verifications WHERE user_id=?').bind(uid).first();
    u.verification_status = u.verified ? 'approved' : (vr ? vr.status : 'none');
    u.limits = limitsForClient(u.plan);
    u.can_switch_plan = DEV_EMAILS.includes(u.email) ? 1 : 0;
    const lc = await env.DB.prepare('SELECT COUNT(*) AS c FROM likes WHERE from_id=? AND created_at>=?').bind(uid, monthStartMs()).first();
    u.likes_used = lc.c || 0;
  }
  return json(u);
}

// ---------- Google OAuth ----------
async function googleStart(request, env) {
  const origin = new URL(request.url).origin;
  const state = uuid();
  await env.SESSIONS.put('oauth:' + state, '1', { expirationTtl: 600 });
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302);
}

async function googleCallback(request, env) {
  const url = new URL(request.url), origin = url.origin;
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (!code || !state || !(await env.SESSIONS.get('oauth:' + state)))
    return Response.redirect(`${origin}/?auth_error=1`, 302);
  await env.SESSIONS.delete('oauth:' + state);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/api/auth/google/callback`, grant_type: 'authorization_code',
    }),
  });
  const tok = await tokenRes.json();
  if (!tokenRes.ok || !tok.access_token) return Response.redirect(`${origin}/?auth_error=1`, 302);

  const uiRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  const gi = await uiRes.json();
  if (!uiRes.ok || !gi.email || gi.email_verified === false)
    return Response.redirect(`${origin}/?auth_error=1`, 302);

  let u = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(gi.email).first();
  let uid;
  if (u) {
    uid = u.id;
    await env.DB.prepare('UPDATE users SET email_verified=1 WHERE id=?').bind(uid).run();
  } else {
    uid = uuid();
    await env.DB.prepare(
      'INSERT INTO users (id,email,pass_hash,plan,age_verified,email_verified,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uid, gi.email, '', 'free', 0, 1, Date.now()).run();
  }
  const res = new Response(null, { status: 302, headers: { Location: `${origin}/` } });
  return withSession(uid, env, res);
}

async function onboard(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { display_name, gender, age, area } = await request.json();
  if (!display_name || !gender || !age || !area) return json({ error: '必須項目が不足しています' }, 400);
  if (Number(age) < 18) return json({ error: '18歳未満はご利用いただけません' }, 400);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO profiles (user_id,display_name,gender,age,area,verified,last_active,created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,gender=excluded.gender,age=excluded.age,area=excluded.area`)
    .bind(uid, display_name, gender, Number(age), area, 0, now, now).run();
  return json({ ok: true });
}

// ---------- explorer ----------
async function listProfiles(request, env, url) {
  const uid = await auth(request, env);
  const q = url.searchParams, where = ['1=1'], bind = [];
  let plan = 'free', meGender = null;
  if (uid) {
    const meRow = await env.DB.prepare('SELECT p.gender, u.plan FROM profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=?').bind(uid).first();
    meGender = meRow?.gender || null;
    plan = meRow?.plan || 'free';
  }
  const lim = planLimits(plan), adv = lim.advSearch;
  // 基本条件（全プラン）: エリア・年齢
  if (q.get('area')) { where.push('area=?'); bind.push(q.get('area')); }
  if (q.get('min'))  { where.push('age>=?'); bind.push(Number(q.get('min'))); }
  if (q.get('max'))  { where.push('age<=?'); bind.push(Number(q.get('max'))); }
  // 詳細条件（スタンダード以上のみ有効）
  if (adv) {
    if (q.get('q')) { const kw = '%' + q.get('q').slice(0, 50) + '%'; where.push('(display_name LIKE ? OR tagline LIKE ? OR bio LIKE ?)'); bind.push(kw, kw, kw); }
    if (q.get('verified') === '1') where.push('verified=1');
    if (q.get('online') === '1') { where.push('last_active>?'); bind.push(Date.now() - 60 * 60000); }
    const tags = q.getAll('tag').filter(Boolean);
    if (tags.length) {
      const ph = tags.map(() => '?').join(',');
      where.push(`EXISTS (SELECT 1 FROM profile_tags t WHERE t.user_id=profiles.user_id AND t.tag IN (${ph}))`);
      bind.push(...tags);
    }
    for (const f of ['purpose', 'marital', 'children', 'income', 'education', 'body_type', 'drinking', 'smoking', 'holiday']) {
      if (q.get(f)) { where.push(`${f}=?`); bind.push(q.get(f)); }
    }
    if (q.get('job'))  { where.push('job LIKE ?'); bind.push('%' + q.get('job').slice(0, 30) + '%'); }
    if (q.get('hmin')) { where.push('height>=?'); bind.push(Number(q.get('hmin'))); }
  }
  where.push('NOT EXISTS (SELECT 1 FROM users us WHERE us.id=profiles.user_id AND us.banned=1)');
  if (uid) {
    if (meGender === 'male') { where.push('gender=?'); bind.push('female'); }
    else if (meGender === 'female') { where.push('gender=?'); bind.push('male'); }
    else if (q.get('gender')) { where.push('gender=?'); bind.push(q.get('gender')); }
    where.push('user_id!=?'); bind.push(uid);
    where.push('NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=profiles.user_id) OR (b.blocker_id=profiles.user_id AND b.blocked_id=?))');
    bind.push(uid, uid);
    // 身バレ防止/シークレットモードの相手は、自分がいいねされている場合のみ表示
    where.push('((private_mode=0 AND secret_mode=0) OR EXISTS (SELECT 1 FROM likes l WHERE l.from_id=profiles.user_id AND l.to_id=?))');
    bind.push(uid);
    // 拒否した相手はどこでも表示しない
    where.push('NOT EXISTS (SELECT 1 FROM passes ps WHERE ps.user_id=? AND ps.target_id=profiles.user_id)');
    bind.push(uid);
    // スワイプデッキでは、すでにいいね済みの相手も除外
    if (q.get('deck') === '1') {
      where.push('NOT EXISTS (SELECT 1 FROM likes lk WHERE lk.from_id=? AND lk.to_id=profiles.user_id)');
      bind.push(uid);
    }
  } else {
    if (q.get('gender')) { where.push('gender=?'); bind.push(q.get('gender')); }
    where.push('private_mode=0 AND secret_mode=0');
  }
  const limit = Math.min(Number(q.get('limit') || 24), 48), offset = Number(q.get('offset') || 0);
  // 並べ替えはスタンダード以上のみ（フリーは常にアクティブ順）
  const sort = lim.sortable ? q.get('sort') : '';
  // 人気順 = お気に入りされた数 + 同じユーザーから2回以上見られた数 の合計ポイント
  const popExpr = '((SELECT COUNT(*) FROM favorites fv WHERE fv.target_id=profiles.user_id)+(SELECT COUNT(*) FROM footprints fpp WHERE fpp.owner_id=profiles.user_id AND fpp.cnt>=2))';
  let base;
  if (sort === 'popular')   base = `${popExpr} DESC, last_active DESC`;
  else if (sort === 'new')  base = 'created_at DESC';
  else                      base = 'last_active DESC';
  // プレミアム会員を常に上位表示
  const order = `(SELECT plan FROM users pu WHERE pu.id=profiles.user_id)='premium' DESC, ${base}`;
  const rows = await env.DB.prepare(
    `SELECT user_id,display_name,gender,age,area,tagline,photo_key,verified,last_active
     FROM profiles WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...bind, limit, offset).all();
  return json({ items: rows.results, offset, limit });
}

// ---------- likes / matches ----------
async function like(request, env, ctx) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  if (await isBanned(env, uid)) return json({ error: 'アカウントが停止されています' }, 403);
  const { to_id, message } = await request.json();
  if (!to_id || to_id === uid) return json({ error: 'invalid target' }, 400);
  const msg = (message || '').toString().trim().slice(0, 200);
  const now = Date.now();
  const u = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(uid).first();
  // メッセージ付きいいねはスタンダード以上
  if (msg && !planLimits(u?.plan).paid)
    return json({ error: 'メッセージ付きいいねはスタンダードプラン以上でご利用いただけます', upgrade: true }, 402);
  const existed = await env.DB.prepare('SELECT 1 FROM likes WHERE from_id=? AND to_id=?').bind(uid, to_id).first();
  if (!existed) {
    const limit = planLimits(u?.plan).likesPerMonth;
    if (limit !== INF) {
      const used = await env.DB.prepare('SELECT COUNT(*) AS c FROM likes WHERE from_id=? AND created_at>=?').bind(uid, monthStartMs()).first();
      if ((used.c || 0) >= limit)
        return json({ error: `今月の「いいね」上限（${limit}回）に達しました。プランをアップグレードすると増やせます`, upgrade: true, limit }, 402);
    }
  }
  await env.DB.prepare('INSERT INTO likes (from_id,to_id,created_at,message) VALUES (?,?,?,?) ON CONFLICT(from_id,to_id) DO UPDATE SET message=COALESCE(excluded.message,message)')
    .bind(uid, to_id, now, msg || null).run();
  // いいね/メッセージ付きいいねをしたら拒否(pass)は解除
  await env.DB.prepare('DELETE FROM passes WHERE user_id=? AND target_id=?').bind(uid, to_id).run();
  if (!existed) notifyUser(env, ctx, to_id);
  const back = await env.DB.prepare('SELECT 1 FROM likes WHERE from_id=? AND to_id=?').bind(to_id, uid).first();
  if (back) {
    const [a, b] = [uid, to_id].sort();
    await env.DB.prepare('INSERT OR IGNORE INTO matches (id,a_id,b_id,created_at) VALUES (?,?,?,?)')
      .bind(uuid(), a, b, now).run();
    return json({ matched: true });
  }
  return json({ matched: false });
}

async function listMatches(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const rows = await env.DB.prepare(
    `SELECT m.id, p.user_id, p.display_name, p.age, p.area, p.photo_key, p.verified
     FROM matches m JOIN profiles p ON p.user_id = CASE WHEN m.a_id=? THEN m.b_id ELSE m.a_id END
     WHERE m.a_id=? OR m.b_id=? ORDER BY m.created_at DESC`).bind(uid, uid, uid).all();
  return json({ items: rows.results });
}

async function likesReceived(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const rows = await env.DB.prepare(
    `SELECT p.user_id,p.display_name,p.gender,p.age,p.area,p.tagline,p.photo_key,p.verified,l.created_at,l.message
     FROM likes l JOIN profiles p ON p.user_id = l.from_id
     WHERE l.to_id = ?
       AND NOT EXISTS (SELECT 1 FROM likes l2 WHERE l2.from_id = ? AND l2.to_id = l.from_id)
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=l.from_id) OR (b.blocker_id=l.from_id AND b.blocked_id=?))
       AND NOT EXISTS (SELECT 1 FROM users us WHERE us.id=l.from_id AND us.banned=1)
     ORDER BY l.created_at DESC LIMIT 100`).bind(uid, uid, uid, uid).all();
  const u = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(uid).first();
  const reveal = planLimits(u?.plan).likesReveal;
  let items = rows.results;
  if (reveal !== INF) {
    items = items.map((it, i) => i < reveal ? it
      : { blurred: true, age: it.age, area: it.area, created_at: it.created_at });
  }
  return json({ items, reveal: reveal === INF ? -1 : reveal, total: rows.results.length });
}

async function conversations(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const rows = await env.DB.prepare(
    `SELECT m.id AS match_id, m.created_at AS matched_at,
       p.user_id, p.display_name, p.age, p.area, p.photo_key, p.verified,
       (SELECT body FROM messages x WHERE x.match_id=m.id ORDER BY x.created_at DESC LIMIT 1) AS last_body,
       (SELECT created_at FROM messages x WHERE x.match_id=m.id ORDER BY x.created_at DESC LIMIT 1) AS last_at,
       (SELECT COUNT(*) FROM messages x WHERE x.match_id=m.id AND x.from_id<>?
          AND x.created_at > COALESCE((SELECT last_read_at FROM reads r WHERE r.user_id=? AND r.match_id=m.id),0)) AS unread
     FROM matches m
     JOIN profiles p ON p.user_id = CASE WHEN m.a_id=? THEN m.b_id ELSE m.a_id END
     WHERE m.a_id=? OR m.b_id=?
     ORDER BY COALESCE(last_at, m.created_at) DESC`).bind(uid, uid, uid, uid, uid).all();
  return json({ items: rows.results });
}

async function unread(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ messages: 0, likes: 0, footprints: 0 });
  await env.DB.prepare('UPDATE profiles SET last_active=? WHERE user_id=?').bind(Date.now(), uid).run();
  const mres = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM messages x JOIN matches m ON m.id=x.match_id
     WHERE (m.a_id=? OR m.b_id=?) AND x.from_id<>?
       AND x.created_at > COALESCE((SELECT last_read_at FROM reads r WHERE r.user_id=? AND r.match_id=x.match_id),0)`)
    .bind(uid, uid, uid, uid).first();
  const lres = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM likes l
     WHERE l.to_id=? AND NOT EXISTS (SELECT 1 FROM likes l2 WHERE l2.from_id=? AND l2.to_id=l.from_id)`)
    .bind(uid, uid).first();
  const fres = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM footprints f
     WHERE f.owner_id=? AND f.last_at > (SELECT COALESCE(footprints_seen_at,0) FROM profiles WHERE user_id=?)`)
    .bind(uid, uid).first();
  return json({ messages: mres.c || 0, likes: lres.c || 0, footprints: fres.c || 0 });
}

async function markRead(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { match_id } = await request.json();
  if (!match_id || !(await matchMember(env, match_id, uid))) return json({ error: 'not found' }, 404);
  await env.DB.prepare(
    `INSERT INTO reads (user_id,match_id,last_read_at) VALUES (?,?,?)
     ON CONFLICT(user_id,match_id) DO UPDATE SET last_read_at=excluded.last_read_at`)
    .bind(uid, match_id, Date.now()).run();
  return json({ ok: true });
}

async function profileOne(request, env, url) {
  const uid = await auth(request, env);
  const id = url.searchParams.get('user_id');
  if (!id) return json({ error: 'invalid' }, 400);
  const p = await env.DB.prepare(
    `SELECT user_id,display_name,gender,age,area,tagline,bio,photo_key,verified,last_active,
            marital,children,job,income,education,height,body_type,drinking,smoking,holiday,avail,purpose
     FROM profiles WHERE user_id=?`)
    .bind(id).first();
  if (!p) return json({ error: 'not found' }, 404);
  if (uid && uid !== id) {
    const vm = await env.DB.prepare('SELECT secret_mode FROM profiles WHERE user_id=?').bind(uid).first();
    if (!vm?.secret_mode) {  // シークレットモード中は足跡を残さない
      await env.DB.prepare(
        `INSERT INTO footprints (viewer_id,owner_id,last_at) VALUES (?,?,?)
         ON CONFLICT(viewer_id,owner_id) DO UPDATE SET last_at=excluded.last_at, cnt=cnt+1`)
        .bind(uid, id, Date.now()).run();
    }
  }
  const ph = await env.DB.prepare('SELECT key FROM profile_photos WHERE user_id=? ORDER BY created_at ASC').bind(id).all();
  let photos = ph.results.map(r => r.key);
  if (p.photo_key) photos = [p.photo_key, ...photos.filter(k => k !== p.photo_key)];
  p.photos = photos;
  const tg = await env.DB.prepare('SELECT tag FROM profile_tags WHERE user_id=?').bind(id).all();
  p.tags = tg.results.map(r => r.tag);
  return json(p);
}

// スワイプの「拒否」: 今後おすすめに出さない
async function passProfile(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { target_id, kind } = await request.json();
  if (!target_id || target_id === uid) return json({ error: 'invalid target' }, 400);
  await env.DB.prepare('INSERT OR REPLACE INTO passes (user_id,target_id,kind,created_at) VALUES (?,?,?,?)')
    .bind(uid, target_id, kind === 'skip' ? 'skip' : 'reject', Date.now()).run();
  return json({ ok: true });
}

// お気に入り（スタンダード以上）
async function favorite(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const u = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(uid).first();
  if (!planLimits(u?.plan).paid)
    return json({ error: 'お気に入り機能はスタンダードプラン以上でご利用いただけます', upgrade: true }, 402);
  const { target_id, on } = await request.json();
  if (!target_id || target_id === uid) return json({ error: 'invalid target' }, 400);
  if (on === 0 || on === false)
    await env.DB.prepare('DELETE FROM favorites WHERE user_id=? AND target_id=?').bind(uid, target_id).run();
  else
    await env.DB.prepare('INSERT OR IGNORE INTO favorites (user_id,target_id,created_at) VALUES (?,?,?)').bind(uid, target_id, Date.now()).run();
  return json({ ok: true, favorited: !(on === 0 || on === false) });
}

// お気に入り一覧（スタンダード以上）
async function favoritesList(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const u = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(uid).first();
  if (!planLimits(u?.plan).paid)
    return json({ error: 'お気に入り機能はスタンダードプラン以上でご利用いただけます', upgrade: true }, 402);
  const rows = await env.DB.prepare(
    `SELECT p.user_id,p.display_name,p.gender,p.age,p.area,p.tagline,p.photo_key,p.verified,p.last_active,f.created_at
     FROM favorites f JOIN profiles p ON p.user_id=f.target_id
     WHERE f.user_id=?
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=f.target_id) OR (b.blocker_id=f.target_id AND b.blocked_id=?))
       AND NOT EXISTS (SELECT 1 FROM users us WHERE us.id=f.target_id AND us.banned=1)
     ORDER BY f.created_at DESC LIMIT 200`).bind(uid, uid, uid).all();
  return json({ items: rows.results });
}

async function footprints(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const u = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(uid).first();
  const cap = planLimits(u?.plan).footprints; // free:3 / standard:10 / premium:1000
  const rows = await env.DB.prepare(
    `SELECT p.user_id,p.display_name,p.gender,p.age,p.area,p.photo_key,p.verified,p.last_active,f.last_at
     FROM footprints f JOIN profiles p ON p.user_id=f.viewer_id
     WHERE f.owner_id=?
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=f.viewer_id) OR (b.blocker_id=f.viewer_id AND b.blocked_id=?))
     ORDER BY f.last_at DESC LIMIT ?`).bind(uid, uid, uid, cap).all();
  await env.DB.prepare('UPDATE profiles SET footprints_seen_at=? WHERE user_id=?').bind(Date.now(), uid).run();
  return json({ items: rows.results, cap });
}

// プロフィール滞在時間を記録（最長値を保持）
async function recordDwell(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  let body = {};
  try { body = await request.json(); } catch {}
  const owner = body.owner_id;
  let ms = Number(body.ms);
  if (!owner || owner === uid || !Number.isFinite(ms)) return json({ ok: false });
  ms = Math.max(0, Math.min(Math.round(ms), 3600000)); // 上限1時間でクランプ
  await env.DB.prepare(
    `UPDATE footprints SET dwell_ms=MAX(dwell_ms,?) WHERE viewer_id=? AND owner_id=?`)
    .bind(ms, uid, owner).run();
  return json({ ok: true });
}

// あなたに興味があるユーザー（閲覧2回以上 または 滞在5秒以上）
async function interested(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const rows = await env.DB.prepare(
    `SELECT p.user_id,p.display_name,p.gender,p.age,p.area,p.tagline,p.photo_key,p.verified,p.last_active,
            f.last_at,f.cnt,f.dwell_ms
     FROM footprints f JOIN profiles p ON p.user_id=f.viewer_id
     WHERE f.owner_id=? AND (f.cnt>=? OR f.dwell_ms>=?)
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=f.viewer_id) OR (b.blocker_id=f.viewer_id AND b.blocked_id=?))
       AND NOT EXISTS (SELECT 1 FROM users us WHERE us.id=f.viewer_id AND us.banned=1)
     ORDER BY (f.cnt>=? AND f.dwell_ms>=?) DESC, f.dwell_ms DESC, f.cnt DESC, f.last_at DESC
     LIMIT 100`)
    .bind(uid, INTEREST_VISITS, INTEREST_DWELL_MS, uid, uid, INTEREST_VISITS, INTEREST_DWELL_MS).all();
  return json({ items: rows.results, visits: INTEREST_VISITS, dwellMs: INTEREST_DWELL_MS });
}

async function profileUpdate(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const b = await request.json();
  const fields = [], vals = [];
  if (b.display_name != null) { if (!String(b.display_name).trim()) return json({ error: 'ニックネームを入力してください' }, 400); fields.push('display_name=?'); vals.push(String(b.display_name).trim().slice(0, 40)); }
  if (b.tagline != null) { fields.push('tagline=?'); vals.push(String(b.tagline).slice(0, 120)); }
  if (b.bio != null) { fields.push('bio=?'); vals.push(String(b.bio).slice(0, 2000)); }
  if (b.area != null) { fields.push('area=?'); vals.push(String(b.area)); }
  if (b.gender != null) { fields.push('gender=?'); vals.push(String(b.gender)); }
  if (b.age != null) { const a = Number(b.age); if (!(a >= 18)) return json({ error: '18歳以上で入力してください' }, 400); fields.push('age=?'); vals.push(a); }
  for (const col of ['marital','children','job','income','education','body_type','drinking','smoking','holiday','avail','purpose']) {
    if (b[col] != null) { fields.push(col + '=?'); vals.push(String(b[col]).slice(0, 200)); }
  }
  if (b.height != null) { const h = Number(b.height); fields.push('height=?'); vals.push(h > 0 ? Math.min(h, 250) : null); }
  if (!fields.length) return json({ error: '変更がありません' }, 400);
  fields.push('last_active=?'); vals.push(Date.now());
  await env.DB.prepare(`UPDATE profiles SET ${fields.join(',')} WHERE user_id=?`).bind(...vals, uid).run();
  return json({ ok: true });
}

async function photoUpload(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const ct = request.headers.get('Content-Type') || '';
  if (!EXT[ct]) return json({ error: 'JPEG / PNG / WebP のみ対応しています' }, 400);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 5 * 1024 * 1024) return json({ error: '5MBまでにしてください' }, 400);
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM profile_photos WHERE user_id=?').bind(uid).first();
  if ((cnt.c || 0) >= 6) return json({ error: '写真は6枚までです' }, 400);
  const key = `photos/${uid}-${Date.now()}.${EXT[ct]}`;
  await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: ct } });
  const now = Date.now();
  await env.DB.prepare('INSERT INTO profile_photos (id,user_id,key,ord,created_at) VALUES (?,?,?,?,?)').bind(uuid(), uid, key, now, now).run();
  const p = await env.DB.prepare('SELECT photo_key FROM profiles WHERE user_id=?').bind(uid).first();
  if (!p || !p.photo_key) await env.DB.prepare('UPDATE profiles SET photo_key=? WHERE user_id=?').bind(key, uid).run();
  return json({ key });
}

async function photosMine(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const rows = await env.DB.prepare('SELECT key FROM profile_photos WHERE user_id=? ORDER BY created_at ASC').bind(uid).all();
  const p = await env.DB.prepare('SELECT photo_key FROM profiles WHERE user_id=?').bind(uid).first();
  return json({ items: rows.results.map(r => r.key), main: p ? p.photo_key : null });
}

async function photoMain(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { key } = await request.json();
  const own = await env.DB.prepare('SELECT 1 FROM profile_photos WHERE user_id=? AND key=?').bind(uid, key).first();
  if (!own) return json({ error: 'not found' }, 404);
  await env.DB.prepare('UPDATE profiles SET photo_key=? WHERE user_id=?').bind(key, uid).run();
  return json({ ok: true });
}

async function photoDelete(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { key } = await request.json();
  const own = await env.DB.prepare('SELECT 1 FROM profile_photos WHERE user_id=? AND key=?').bind(uid, key).first();
  if (!own) return json({ error: 'not found' }, 404);
  await env.DB.prepare('DELETE FROM profile_photos WHERE user_id=? AND key=?').bind(uid, key).run();
  try { await env.PHOTOS.delete(key); } catch (e) {}
  const p = await env.DB.prepare('SELECT photo_key FROM profiles WHERE user_id=?').bind(uid).first();
  if (p && p.photo_key === key) {
    const next = await env.DB.prepare('SELECT key FROM profile_photos WHERE user_id=? ORDER BY created_at ASC LIMIT 1').bind(uid).first();
    await env.DB.prepare('UPDATE profiles SET photo_key=? WHERE user_id=?').bind(next ? next.key : null, uid).run();
  }
  return json({ ok: true });
}

async function block(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { target_id } = await request.json();
  if (!target_id || target_id === uid) return json({ error: 'invalid' }, 400);
  await env.DB.prepare('INSERT OR IGNORE INTO blocks (blocker_id,blocked_id,created_at) VALUES (?,?,?)')
    .bind(uid, target_id, Date.now()).run();
  const [a, b] = [uid, target_id].sort();
  const mrow = await env.DB.prepare('SELECT id FROM matches WHERE a_id=? AND b_id=?').bind(a, b).first();
  const ops = [env.DB.prepare('DELETE FROM likes WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').bind(uid, target_id, target_id, uid)];
  if (mrow) {
    ops.push(env.DB.prepare('DELETE FROM messages WHERE match_id=?').bind(mrow.id));
    ops.push(env.DB.prepare('DELETE FROM reads WHERE match_id=?').bind(mrow.id));
    ops.push(env.DB.prepare('DELETE FROM matches WHERE id=?').bind(mrow.id));
  }
  await env.DB.batch(ops);
  return json({ ok: true });
}

async function unblock(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { target_id } = await request.json();
  await env.DB.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').bind(uid, target_id).run();
  return json({ ok: true });
}

async function blocksList(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const rows = await env.DB.prepare(
    `SELECT p.user_id,p.display_name,p.age,p.area,p.photo_key,b.created_at
     FROM blocks b JOIN profiles p ON p.user_id=b.blocked_id
     WHERE b.blocker_id=? ORDER BY b.created_at DESC`).bind(uid).all();
  return json({ items: rows.results });
}

async function privacy(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { private_mode } = await request.json();
  await env.DB.prepare('UPDATE profiles SET private_mode=? WHERE user_id=?').bind(private_mode ? 1 : 0, uid).run();
  return json({ ok: true });
}

// シークレットモード（プレミアム限定）: 足跡を残さず、検索・一覧に出ない
async function secretMode(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { on } = await request.json();
  const u = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(uid).first();
  if (u?.plan !== 'premium')
    return json({ error: 'シークレットモードはプレミアムプラン限定です', upgrade: true }, 402);
  await env.DB.prepare('UPDATE profiles SET secret_mode=? WHERE user_id=?').bind(on ? 1 : 0, uid).run();
  return json({ ok: true, secret_mode: on ? 1 : 0 });
}

// 管理用: 自分のプランを切り替え（DEV_EMAILSのアカウントのみ）
async function devSetPlan(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const u = await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(uid).first();
  if (!u || !DEV_EMAILS.includes(u.email)) return json({ error: 'forbidden' }, 403);
  const { plan } = await request.json();
  if (!['free', 'standard', 'premium'].includes(plan)) return json({ error: 'invalid plan' }, 400);
  await env.DB.prepare('UPDATE users SET plan=? WHERE id=?').bind(plan, uid).run();
  if (plan !== 'premium') await env.DB.prepare('UPDATE profiles SET secret_mode=0 WHERE user_id=?').bind(uid).run();
  return json({ ok: true, plan });
}

async function tagsSet(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { tags } = await request.json();
  if (!Array.isArray(tags)) return json({ error: 'invalid' }, 400);
  const clean = [...new Set(tags.map(t => String(t).trim()).filter(t => t && t.length <= 20))].slice(0, 15);
  await env.DB.prepare('DELETE FROM profile_tags WHERE user_id=?').bind(uid).run();
  if (clean.length) {
    await env.DB.batch(clean.map(t => env.DB.prepare('INSERT OR IGNORE INTO profile_tags (user_id,tag) VALUES (?,?)').bind(uid, t)));
  }
  await env.DB.prepare('UPDATE profiles SET last_active=? WHERE user_id=?').bind(Date.now(), uid).run();
  return json({ ok: true, tags: clean });
}

// ---------- gallery (per-match private) ----------
async function galleryUpload(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const ct = request.headers.get('Content-Type') || '';
  if (!EXT[ct]) return json({ error: 'JPEG / PNG / WebP のみ対応しています' }, 400);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 5 * 1024 * 1024) return json({ error: '5MBまでにしてください' }, 400);
  const gu = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(uid).first();
  const gcap = planLimits(gu?.plan).gallery;
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM gallery_photos WHERE user_id=?').bind(uid).first();
  if ((cnt.c || 0) >= gcap) return json({ error: `ギャラリー公開枠は${gcap}枚までです（プランで上限が変わります）`, upgrade: true }, 400);
  const key = `gallery/${uid}/${Date.now()}.${EXT[ct]}`;
  await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: ct } });
  await env.DB.prepare('INSERT INTO gallery_photos (id,user_id,key,created_at) VALUES (?,?,?,?)').bind(uuid(), uid, key, Date.now()).run();
  return json({ key });
}

async function galleryMine(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const rows = await env.DB.prepare('SELECT key FROM gallery_photos WHERE user_id=? ORDER BY created_at ASC').bind(uid).all();
  return json({ items: rows.results.map(r => r.key) });
}

async function galleryRemove(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { key } = await request.json();
  const own = await env.DB.prepare('SELECT 1 FROM gallery_photos WHERE user_id=? AND key=?').bind(uid, key).first();
  if (!own) return json({ error: 'not found' }, 404);
  await env.DB.prepare('DELETE FROM gallery_photos WHERE user_id=? AND key=?').bind(uid, key).run();
  try { await env.PHOTOS.delete(key); } catch (e) {}
  return json({ ok: true });
}

async function galleryShare(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { to_id, share } = await request.json();
  if (!to_id) return json({ error: 'invalid' }, 400);
  if (!(await areMatched(env, uid, to_id))) return json({ error: 'マッチした相手にのみ公開できます' }, 400);
  if (share) {
    await env.DB.prepare('INSERT OR IGNORE INTO gallery_shares (owner_id,viewer_id,created_at) VALUES (?,?,?)').bind(uid, to_id, Date.now()).run();
  } else {
    await env.DB.prepare('DELETE FROM gallery_shares WHERE owner_id=? AND viewer_id=?').bind(uid, to_id).run();
  }
  return json({ ok: true, shared: !!share });
}

async function galleryStatus(request, env, url) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const w = url.searchParams.get('with');
  if (!w) return json({ error: 'invalid' }, 400);
  const r = await env.DB.prepare('SELECT 1 FROM gallery_shares WHERE owner_id=? AND viewer_id=?').bind(uid, w).first();
  return json({ shared: !!r });
}

async function galleryView(request, env, url) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const owner = url.searchParams.get('user_id');
  if (!owner) return json({ error: 'invalid' }, 400);
  const shared = await env.DB.prepare('SELECT 1 FROM gallery_shares WHERE owner_id=? AND viewer_id=?').bind(owner, uid).first();
  if (!shared || !(await areMatched(env, uid, owner))) return json({ shared: false, items: [] });
  const rows = await env.DB.prepare('SELECT key FROM gallery_photos WHERE user_id=? ORDER BY created_at ASC').bind(owner).all();
  return json({ shared: true, items: rows.results.map(r => r.key) });
}

async function galleryPhoto(request, env, url) {
  const uid = await auth(request, env);
  const key = url.searchParams.get('key') || '';
  if (!key.startsWith('gallery/')) return new Response('not found', { status: 404 });
  if (!uid) return new Response('unauthorized', { status: 401 });
  const owner = key.split('/')[1];
  if (uid !== owner) {
    const shared = await env.DB.prepare('SELECT 1 FROM gallery_shares WHERE owner_id=? AND viewer_id=?').bind(owner, uid).first();
    if (!shared || !(await areMatched(env, uid, owner))) return new Response('forbidden', { status: 403 });
  }
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  const h = new Headers();
  h.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  h.set('Cache-Control', 'private, max-age=300');
  return new Response(obj.body, { headers: h });
}

// ---------- push notifications (Web Push, payloadless + VAPID) ----------
async function pushSubscribe(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { endpoint, keys } = await request.json();
  if (!endpoint) return json({ error: 'invalid' }, 400);
  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint,user_id,p256dh,auth,created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth`)
    .bind(endpoint, uid, keys?.p256dh || '', keys?.auth || '', Date.now()).run();
  return json({ ok: true });
}

async function pushUnsubscribe(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { endpoint } = await request.json();
  if (endpoint) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?').bind(endpoint, uid).run();
  return json({ ok: true });
}

function notifyUser(env, ctx, userId) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return;
  const run = async () => {
    const subs = await env.DB.prepare('SELECT endpoint FROM push_subs WHERE user_id=?').bind(userId).all();
    for (const s of subs.results) await sendPush(env, s.endpoint);
  };
  if (ctx && ctx.waitUntil) ctx.waitUntil(run()); else run();
}

async function sendPush(env, endpoint) {
  try {
    const auth = await vapidAuth(env, endpoint);
    const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: auth, TTL: '86400' } });
    if (r.status === 404 || r.status === 410) {
      await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(endpoint).run();
    }
    return r.ok;
  } catch (e) { return false; }
}

async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' }));
  const unsigned = `${header}.${payload}`;
  const key = await importVapidKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64urlBytes(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function importVapidKey(pub, priv) {
  const raw = b64urlToBytes(pub);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64urlBytes(raw.slice(1, 33)), y: b64urlBytes(raw.slice(33, 65)), d: priv, ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
function b64url(str) { return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlBytes(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlToBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

// ---------- admin ----------
async function isBanned(env, uid) {
  const u = await env.DB.prepare('SELECT banned FROM users WHERE id=?').bind(uid).first();
  return !!(u && u.banned);
}
async function requireAdmin(request, env) {
  const uid = await auth(request, env);
  if (!uid) return null;
  const u = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(uid).first();
  return u && u.is_admin ? uid : null;
}
async function adminCheck(request, env) {
  return json({ admin: !!(await requireAdmin(request, env)) });
}
async function adminVerifications(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare(
    `SELECT v.user_id,v.doc_key,v.status,v.created_at,p.display_name,p.gender,p.age,p.area
     FROM verifications v JOIN profiles p ON p.user_id=v.user_id
     WHERE v.status='pending' ORDER BY v.created_at ASC`).all();
  return json({ items: rows.results });
}
async function adminDoc(request, env, url) {
  if (!(await requireAdmin(request, env))) return new Response('forbidden', { status: 403 });
  const key = url.searchParams.get('key') || '';
  if (!key.startsWith('verify/')) return new Response('not found', { status: 404 });
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  const h = new Headers();
  h.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  h.set('Cache-Control', 'private, no-store');
  return new Response(obj.body, { headers: h });
}
async function adminVerify(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'forbidden' }, 403);
  const { user_id, action } = await request.json();
  if (!user_id) return json({ error: 'invalid' }, 400);
  if (action === 'approve') {
    await env.DB.batch([
      env.DB.prepare("UPDATE verifications SET status='approved' WHERE user_id=?").bind(user_id),
      env.DB.prepare('UPDATE profiles SET verified=1 WHERE user_id=?').bind(user_id),
    ]);
  } else {
    await env.DB.prepare("UPDATE verifications SET status='rejected' WHERE user_id=?").bind(user_id).run();
  }
  return json({ ok: true });
}
async function adminReports(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare(
    `SELECT r.id,r.reporter_id,r.target_id,r.reason,r.created_at,
       tp.display_name AS target_name, rp.display_name AS reporter_name,
       (SELECT banned FROM users WHERE id=r.target_id) AS target_banned
     FROM reports r
     LEFT JOIN profiles tp ON tp.user_id=r.target_id
     LEFT JOIN profiles rp ON rp.user_id=r.reporter_id
     WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 200`).all();
  return json({ items: rows.results });
}
async function adminReportResolve(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'forbidden' }, 403);
  const { id } = await request.json();
  if (!id) return json({ error: 'invalid' }, 400);
  await env.DB.prepare("UPDATE reports SET status='resolved' WHERE id=?").bind(id).run();
  return json({ ok: true });
}
async function adminBan(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'forbidden' }, 403);
  const { user_id, ban } = await request.json();
  if (!user_id) return json({ error: 'invalid' }, 400);
  await env.DB.prepare('UPDATE users SET banned=? WHERE id=?').bind(ban ? 1 : 0, user_id).run();
  return json({ ok: true, banned: !!ban });
}

async function unmatch(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { match_id } = await request.json();
  const row = match_id ? await matchMember(env, match_id, uid) : null;
  if (!row) return json({ error: 'not found' }, 404);
  const other = row.a_id === uid ? row.b_id : row.a_id;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE match_id=?').bind(match_id),
    env.DB.prepare('DELETE FROM reads WHERE match_id=?').bind(match_id),
    env.DB.prepare('DELETE FROM matches WHERE id=?').bind(match_id),
    env.DB.prepare('DELETE FROM likes WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)')
      .bind(uid, other, other, uid),
  ]);
  return json({ ok: true });
}

async function report(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { target_id, reason } = await request.json();
  if (!target_id) return json({ error: 'invalid' }, 400);
  await env.DB.prepare('INSERT INTO reports (id,reporter_id,target_id,reason,created_at) VALUES (?,?,?,?,?)')
    .bind(uuid(), uid, target_id, (reason || '').slice(0, 1000), Date.now()).run();
  return json({ ok: true });
}

async function messagesDelete(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { ids } = await request.json();
  if (!Array.isArray(ids) || !ids.length) return json({ error: 'invalid' }, 400);
  const clean = ids.slice(0, 200);
  const ph = clean.map(() => '?').join(',');
  await env.DB.prepare(`DELETE FROM messages WHERE from_id=? AND id IN (${ph})`).bind(uid, ...clean).run();
  return json({ ok: true, deleted: clean.length });
}

// ---------- messaging ----------
async function matchMember(env, matchId, uid) {
  const row = await env.DB.prepare('SELECT a_id,b_id FROM matches WHERE id=?').bind(matchId).first();
  if (!row) return null;
  if (row.a_id !== uid && row.b_id !== uid) return null;
  return row;
}
async function areMatched(env, x, y) {
  const [a, b] = [x, y].sort();
  const r = await env.DB.prepare('SELECT 1 FROM matches WHERE a_id=? AND b_id=?').bind(a, b).first();
  return !!r;
}

async function listMessages(request, env, url) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const matchId = url.searchParams.get('match_id');
  const row = matchId ? await matchMember(env, matchId, uid) : null;
  if (!row) return json({ error: 'not found' }, 404);
  const after = Number(url.searchParams.get('after') || 0);
  const rows = await env.DB.prepare(
    `SELECT id,from_id,body,created_at FROM messages
     WHERE match_id=? AND created_at>? ORDER BY created_at ASC LIMIT 200`)
    .bind(matchId, after).all();
  const partner = row.a_id === uid ? row.b_id : row.a_id;
  const rd = await env.DB.prepare('SELECT last_read_at FROM reads WHERE user_id=? AND match_id=?')
    .bind(partner, matchId).first();
  return json({ items: rows.results, me: uid, read_at: rd?.last_read_at || 0 });
}

async function sendMessage(request, env, ctx) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  if (await isBanned(env, uid)) return json({ error: 'アカウントが停止されています' }, 403);
  const { match_id, body } = await request.json();
  const text = (body || '').trim();
  if (!text) return json({ error: '本文が空です' }, 400);
  if (text.length > 2000) return json({ error: '長すぎます' }, 400);
  const row = match_id ? await matchMember(env, match_id, uid) : null;
  if (!row) return json({ error: 'not found' }, 404);
  const u = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(uid).first();
  const cap = planLimits(u?.plan).msgPerMatch;
  if (cap !== INF) {
    const sent = await env.DB.prepare('SELECT COUNT(*) AS c FROM messages WHERE match_id=? AND from_id=?').bind(match_id, uid).first();
    if ((sent.c || 0) >= cap)
      return json({ error: `フリープランは1人につき${cap}通までです。続けるにはプランをアップグレードしてください`, upgrade: true, limit: cap }, 402);
  }
  const id = uuid(), now = Date.now();
  await env.DB.prepare('INSERT INTO messages (id,match_id,from_id,body,created_at) VALUES (?,?,?,?,?)')
    .bind(id, match_id, uid, text, now).run();
  const other = row.a_id === uid ? row.b_id : row.a_id;
  notifyUser(env, ctx, other);
  return json({ id, from_id: uid, body: text, created_at: now });
}

// ---------- photos (R2) ----------
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function uploadPhoto(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const ct = request.headers.get('Content-Type') || '';
  if (!EXT[ct]) return json({ error: 'JPEG / PNG / WebP のみ対応しています' }, 400);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 5 * 1024 * 1024) return json({ error: '5MBまでにしてください' }, 400);
  const key = `photos/${uid}-${Date.now()}.${EXT[ct]}`;
  await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: ct } });
  await env.DB.prepare('UPDATE profiles SET photo_key=? WHERE user_id=?').bind(key, uid).run();
  return json({ photo_key: key });
}

async function servePhoto(request, env, url) {
  const key = url.searchParams.get('key') || '';
  if (!key.startsWith('photos/')) return new Response('not found', { status: 404 });
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  const h = new Headers();
  h.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  h.set('Cache-Control', 'public, max-age=86400');
  return new Response(obj.body, { headers: h });
}

// ---------- verification ----------
async function submitVerification(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const ct = request.headers.get('Content-Type') || '';
  const okType = EXT[ct] || ct === 'application/pdf';
  if (!okType) return json({ error: 'JPEG / PNG / WebP / PDF のみ対応しています' }, 400);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) return json({ error: '8MBまでにしてください' }, 400);
  const ext = EXT[ct] || 'pdf';
  const key = `verify/${uid}-${Date.now()}.${ext}`;
  await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: ct } });
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO verifications (user_id,doc_key,status,created_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET doc_key=excluded.doc_key,status='pending',created_at=excluded.created_at`)
    .bind(uid, key, 'pending', now).run();
  return json({ status: 'pending' });
}

// ---------- billing ----------
async function checkout(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { plan } = await request.json();
  const price = plan === 'premium' ? env.STRIPE_PRICE_PREMIUM : env.STRIPE_PRICE_STANDARD;
  const u = await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(uid).first();
  const form = new URLSearchParams({
    mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1',
    success_url: `${env.APP_URL}/?upgraded=1`, cancel_url: `${env.APP_URL}/?canceled=1`,
    client_reference_id: uid, customer_email: u.email, 'metadata[user_id]': uid, 'metadata[plan]': plan,
  });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data = await r.json();
  if (!r.ok) return json({ error: data.error?.message || 'stripe error' }, 400);
  return json({ url: data.url });
}

async function stripeWebhook(request, env) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  if (!(await verifyStripeSig(body, sig, env.STRIPE_WEBHOOK_SECRET)))
    return json({ error: 'bad signature' }, 400);
  const event = JSON.parse(body), now = Date.now(), obj = event.data.object;
  if (event.type === 'checkout.session.completed') {
    const u2 = obj.metadata?.user_id || obj.client_reference_id;
    const plan = obj.metadata?.plan || 'standard';
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET plan=?, stripe_customer_id=? WHERE id=?').bind(plan, obj.customer, u2),
      env.DB.prepare(`INSERT INTO subscriptions (user_id,stripe_sub_id,plan,status,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET stripe_sub_id=excluded.stripe_sub_id,plan=excluded.plan,status='active',updated_at=excluded.updated_at`)
        .bind(u2, obj.subscription, plan, 'active', now),
    ]);
  }
  if (event.type === 'customer.subscription.deleted') {
    await env.DB.prepare(`UPDATE users SET plan='free' WHERE id=(SELECT user_id FROM subscriptions WHERE stripe_sub_id=?)`)
      .bind(obj.id).run();
    // プレミアム限定のシークレットモードを解除
    await env.DB.prepare(`UPDATE profiles SET secret_mode=0 WHERE user_id=(SELECT user_id FROM subscriptions WHERE stripe_sub_id=?)`)
      .bind(obj.id).run();
    await env.DB.prepare('UPDATE subscriptions SET status=?, updated_at=? WHERE stripe_sub_id=?')
      .bind('canceled', now, obj.id).run();
  }
  return json({ received: true });
}

// ---------- helpers ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function uuid() { return crypto.randomUUID(); }
async function withSession(uid, env, res) {
  const sid = uuid();
  await env.SESSIONS.put('sess:' + sid, uid, { expirationTtl: 60 * 60 * 24 * 30 });
  res.headers.append('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
  return res;
}
async function auth(request, env) {
  const sid = getCookie(request, 'sid');
  if (!sid) return null;
  return await env.SESSIONS.get('sess:' + sid);
}
function getCookie(request, name) {
  const c = request.headers.get('Cookie') || '';
  const hit = c.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt);
  return `${b64(salt)}:${b64(new Uint8Array(bits))}`;
}
async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;
  const bits = await pbkdf2(password, fromB64(saltB64));
  return b64(new Uint8Array(bits)) === hashB64;
}
async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
}
function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function fromB64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function verifyStripeSig(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')));
  const signed = `${parts.t}.${payload}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, parts.v1 || '');
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ============================================================
// サンプル女性会員シード（管理者のみ・冪等）/ 投入後にこのブロックは削除可
// ============================================================
const SEED_MEMBERS = [
  { id:'seed_01', img:'01.jpg', name:'綾乃', age:34, area:'東京都', height:158,
    tagline:'静かなカフェで、ゆっくりお話しできたら',
    bio:'はじめまして、綾乃です。都内で事務の仕事をしています。平日は仕事、休日は家のことが中心で、ふと「大人同士、肩の力を抜いて話せる人がいたらいいな」と思い登録しました。派手なことは得意ではないけれど、美味しいコーヒーのあるお店で、本や映画の話をのんびりできる時間が好きです。お互いの生活を大切にしながら、心地よい距離で続けられる関係が理想です。メッセージはゆっくりでも大丈夫なので、気負わずお話しできたら嬉しいです。',
    purpose:'食事・お茶から', marital:'既婚', children:'なし', job:'事務', income:'400〜600万円', education:'大学卒',
    body_type:'やや細め', drinking:'ときどき飲む', smoking:'吸わない', holiday:'土日',
    avail:['wd_evening','we_day','we_evening'], tags:['カフェ巡り','読書','映画','音楽'],
    verified:1, active_min:20, created_day:30 },

  { id:'seed_02', img:'02.jpg', name:'美咲', age:42, area:'東京都', height:164,
    tagline:'上質なワインと、落ち着いた会話を楽しめる方と',
    bio:'美咲と申します。インテリア関連の仕事をしており、気づけば毎日があっという間に過ぎていきます。家庭はありますが、心のどこかで「本音で語り合える相手」を求めている自分がいました。美術館やギャラリーをめぐったり、静かなバーで一杯いただきながら他愛ない話をしたり…そんな大人の時間を分かち合えたら。誠実で、お互いの事情を尊重できる方とお会いしたいです。遊びではなく、心が通う関係を少しずつ築ければと思っています。',
    purpose:'真剣な関係', marital:'既婚', children:'あり（同居）', job:'インテリアコーディネーター', income:'600〜800万円', education:'大学卒',
    body_type:'スリム', drinking:'よく飲む', smoking:'電子タバコ', holiday:'不定期',
    avail:['wd_day','wd_evening'], tags:['美術・アート','お酒','グルメ','映画'],
    verified:1, active_min:120, created_day:50 },

  { id:'seed_03', img:'03.jpg', name:'莉子', age:29, area:'神奈川県', height:160,
    tagline:'一緒に楽しいこと見つけてくれる人、募集中◎',
    bio:'りこです！アパレル系で働いていて、新しいお店とか流行りのスポット巡りが大好き♪ 結婚はしてるけど、刺激というか…一緒にワクワクできる人ともっと出会いたくて登録しました。ライブやフェスに行ったり、週末はドライブで海までとか、そういうアクティブなの好きな人だと話が合うかも。ノリと勢い大事にしてるタイプだけど、ちゃんと相手のことも考えられる人がいいな。まずは気軽にメッセージください〜！',
    purpose:'気軽な関係', marital:'既婚', children:'なし', job:'アパレル販売', income:'〜400万円', education:'専門・短大卒',
    body_type:'普通', drinking:'よく飲む', smoking:'相手が嫌なら吸わない', holiday:'シフト制',
    avail:['wd_late','we_day','we_late'], tags:['ライブ・フェス','ドライブ','旅行','グルメ','音楽'],
    verified:0, active_min:5, created_day:9 },

  { id:'seed_04', img:'04.jpg', name:'志保', age:46, area:'埼玉県', height:156,
    tagline:'日々の小さな幸せを、分かち合える方と',
    bio:'志保です。パートで医療事務の仕事をしながら、家庭を切り盛りしています。子どもも大きくなり、ふと自分の時間ができたときに「誰かと何気ない話がしたいな」と感じるようになりました。料理を作るのが好きで、温泉でのんびりするのが一番の楽しみです。見栄を張るのは苦手なので、等身大のままお付き合いできる方だと安心します。急がず、お互いの生活を大事にしながら、ゆっくり仲良くなれたら嬉しいです。',
    purpose:'まずは友達から', marital:'既婚', children:'あり（同居）', job:'医療事務（パート）', income:'〜400万円', education:'専門・短大卒',
    body_type:'ぽっちゃり', drinking:'ときどき飲む', smoking:'吸わない', holiday:'シフト制',
    avail:['wd_morning','wd_day'], tags:['料理','温泉','カフェ巡り','散歩'],
    verified:1, active_min:1440, created_day:70 },

  { id:'seed_05', img:'05.jpg', name:'遥', age:37, area:'東京都', height:167,
    tagline:'対等に話せる、知的な時間を',
    bio:'遥です。外資系の会社でマーケティングをしています。仕事にはやりがいを感じていますが、プライベートでは心を許せる相手がなかなかおらず…。恋愛というより、まずは価値観の合う方と対等に話せる関係を求めています。週末は一人で映画館に行ったり、カメラ片手に街を歩いたり。知的な刺激をもらえる会話が何より好きです。お互いを束縛せず、それぞれの世界を尊重しながら、大人の関係を築ける方と出会えたら。',
    purpose:'食事・お茶から', marital:'既婚', children:'なし', job:'マーケティング職', income:'800〜1000万円', education:'大学院卒',
    body_type:'スリム', drinking:'ときどき飲む', smoking:'吸わない', holiday:'土日',
    avail:['wd_evening','we_morning','we_day'], tags:['映画','読書','カメラ','美術・アート'],
    verified:1, active_min:35, created_day:40 },

  { id:'seed_06', img:'06.jpg', name:'由美子', age:53, area:'大阪府', height:159,
    tagline:'いくつになっても、ときめきを忘れたくない',
    bio:'由美子です。大阪でエステ関係の仕事をしています。歳は重ねましたが、気持ちはまだまだ若いつもり（笑）。子どもも独立して、これからは自分の人生も楽しみたいなと思うようになりました。美味しいものを食べに行ったり、好きなアーティストのライブに遠征したり、旅行も大好きです。明るくお話しできる方、人生を一緒に面白がってくれる方だと嬉しいな。年齢は気にしないので、気軽に声をかけてくださいね。',
    purpose:'まずは友達から', marital:'既婚', children:'あり（別居）', job:'エステティシャン', income:'400〜600万円', education:'高校卒',
    body_type:'普通', drinking:'よく飲む', smoking:'ときどき吸う', holiday:'不定期',
    avail:['wd_day','wd_evening','we_evening'], tags:['ライブ・フェス','旅行','グルメ','音楽','温泉'],
    verified:1, active_min:180, created_day:20 },

  { id:'seed_07', img:'07.jpg', name:'七海', age:33, area:'京都府', height:161,
    tagline:'感性が合う人と、静かに惹かれ合えたら',
    bio:'七海です。フリーでイラストやデザインの仕事をしています。一人で黙々と制作する時間が多いぶん、心が動くような出会いにずっと憧れていました。古い喫茶店や小さなギャラリー、レコード屋さんをめぐるのが好きで、感性の近い人と「いいね」を言い合える関係って素敵だなと思います。言葉より空気感を大事にするタイプなので、ゆっくり距離を縮められたら。既婚ですが、心の拠り所になれるような、穏やかで深いつながりを求めています。',
    purpose:'秘密の関係', marital:'既婚', children:'なし', job:'イラストレーター', income:'〜400万円', education:'大学卒',
    body_type:'やや細め', drinking:'ときどき飲む', smoking:'相手が嫌なら吸わない', holiday:'不定期',
    avail:['wd_evening','wd_late','we_late'], tags:['美術・アート','カメラ','音楽','カフェ巡り','読書'],
    verified:0, active_min:300, created_day:15 },

  { id:'seed_08', img:'08.jpg', name:'千尋', age:50, area:'兵庫県', height:162,
    tagline:'大人だからこそ味わえる、静かな時間を',
    bio:'千尋です。神戸で暮らしています。髪を自分らしいグレージュに染めてから、少し気持ちが軽くなりました。長く家庭を守ってきましたが、人生の後半は「自分の心が満たされる時間」も大切にしたいと思うようになりました。美術館やお茶、季節ごとの温泉旅行が好きです。落ち着いた方と、上品に、でも心を開いてお話しできたら。恋愛の形にこだわらず、お互いを思いやれる穏やかな関係を望んでいます。',
    purpose:'食事・お茶から', marital:'既婚', children:'あり（別居）', job:'専業主婦', income:'〜400万円', education:'大学卒',
    body_type:'普通', drinking:'ときどき飲む', smoking:'吸わない', holiday:'平日',
    avail:['wd_morning','wd_day'], tags:['美術・アート','温泉','読書','カフェ巡り'],
    verified:1, active_min:2880, created_day:90 },

  { id:'seed_09', img:'09.jpg', name:'結衣', age:31, area:'福岡県', height:155,
    tagline:'穏やかな人と、ほっとできる関係を',
    bio:'結衣です。福岡で保育士をしています。毎日子どもたちに囲まれて賑やかですが、ふとした時に自分の気持ちを話せる相手がいたらいいなと思って…。おうちで猫と過ごす時間や、お気に入りのカフェでまったりするのが好きです。料理も得意なほうかな。派手さはないけれど、一緒にいて安心できる、優しい方と出会えたら嬉しいです。焦らず、少しずつお互いを知っていけたらと思っています。どうぞよろしくお願いします。',
    purpose:'食事・お茶から', marital:'既婚', children:'なし', job:'保育士', income:'〜400万円', education:'専門・短大卒',
    body_type:'普通', drinking:'飲まない', smoking:'吸わない', holiday:'土日',
    avail:['wd_evening','we_morning','we_day'], tags:['料理','カフェ巡り','ペット','散歩','映画'],
    verified:1, active_min:50, created_day:25 },

  { id:'seed_10', img:'10.jpg', name:'真理', age:44, area:'愛知県', height:160,
    tagline:'美味しいお酒とごはんを、笑って楽しめる方と',
    bio:'真理です。名古屋で事務の仕事をしています。よく笑うとまわりから言われる、わりと社交的なタイプです。家庭はありますが、やっぱり「ときめき」って大事だなと思って勇気を出して登録しました。美味しいお店を開拓したり、ドライブがてら小旅行したり、美味しいお酒を飲みながら語り合う時間が大好きです。重たい関係は望んでいませんが、会ったときに心から楽しいと思える、そんな大人の関係を築ける方と出会えたら嬉しいです。',
    purpose:'気軽な関係', marital:'既婚', children:'あり（同居）', job:'事務', income:'400〜600万円', education:'大学卒',
    body_type:'グラマー', drinking:'よく飲む', smoking:'吸わない', holiday:'土日',
    avail:['wd_evening','we_day','we_evening'], tags:['グルメ','お酒','旅行','ドライブ'],
    verified:1, active_min:240, created_day:35 },
];

async function adminSeed(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'forbidden' }, 403);
  const now = Date.now();
  const results = [];
  for (const s of SEED_MEMBERS) {
    const uid = s.id;
    const last_active = now - s.active_min * 60000;
    const created_at = now - s.created_day * 86400000;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id,email,pass_hash,plan,age_verified,email_verified,created_at)
       VALUES (?,?,?,?,?,?,?)`)
      .bind(uid, `${uid}@seed.re-lovers.local`, 'x', 'free', 1, 1, created_at).run();
    await env.DB.prepare(
      `INSERT INTO profiles
        (user_id,display_name,gender,age,area,tagline,bio,purpose,marital,children,job,income,education,height,body_type,drinking,smoking,holiday,avail,verified,last_active,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
        display_name=excluded.display_name,age=excluded.age,area=excluded.area,tagline=excluded.tagline,bio=excluded.bio,
        purpose=excluded.purpose,marital=excluded.marital,children=excluded.children,job=excluded.job,income=excluded.income,
        education=excluded.education,height=excluded.height,body_type=excluded.body_type,drinking=excluded.drinking,
        smoking=excluded.smoking,holiday=excluded.holiday,avail=excluded.avail,verified=excluded.verified,last_active=excluded.last_active`)
      .bind(uid, s.name, 'female', s.age, s.area, s.tagline, s.bio, s.purpose, s.marital, s.children, s.job, s.income,
            s.education, s.height, s.body_type, s.drinking, s.smoking, s.holiday, s.avail.join(','), s.verified, last_active, created_at).run();
    await env.DB.prepare('DELETE FROM profile_tags WHERE user_id=?').bind(uid).run();
    if (s.tags.length)
      await env.DB.batch(s.tags.map(t => env.DB.prepare('INSERT OR IGNORE INTO profile_tags (user_id,tag) VALUES (?,?)').bind(uid, t)));
    const cur = await env.DB.prepare('SELECT photo_key FROM profiles WHERE user_id=?').bind(uid).first();
    if (!cur || !cur.photo_key) {
      const imgRes = await env.ASSETS.fetch(new Request(new URL('/seed/' + s.img, request.url).toString()));
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        const key = `photos/${uid}-${Date.now()}.jpg`;
        await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
        await env.DB.prepare('INSERT INTO profile_photos (id,user_id,key,ord,created_at) VALUES (?,?,?,?,?)')
          .bind(uuid(), uid, key, Date.now(), Date.now()).run();
        await env.DB.prepare('UPDATE profiles SET photo_key=? WHERE user_id=?').bind(key, uid).run();
        results.push({ uid, name: s.name, photo: key });
      } else {
        results.push({ uid, name: s.name, photo: 'FETCH_FAIL_' + imgRes.status });
      }
    } else {
      results.push({ uid, name: s.name, photo: 'kept' });
    }
  }
  return json({ ok: true, count: results.length, results });
}
