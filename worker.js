// ============================================================
// Matching app — Cloudflare Worker
// auth / explorer / likes+matches / messaging / R2 photos / verification / Stripe
// ============================================================

const PLANS = {
  free:     { messaging: false, seeLikes: false },
  standard: { messaging: true,  seeLikes: false },
  premium:  { messaging: true,  seeLikes: true  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

async function route(request, env, url) {
  const p = url.pathname, m = request.method;

  if (p === '/api/signup'   && m === 'POST') return signup(request, env);
  if (p === '/api/login'    && m === 'POST') return login(request, env);
  if (p === '/api/logout'   && m === 'POST') return logout(request, env);
  if (p === '/api/me'       && m === 'GET')  return me(request, env);
  if (p === '/api/auth/google'          && m === 'GET') return googleStart(request, env);
  if (p === '/api/auth/google/callback' && m === 'GET') return googleCallback(request, env);
  if (p === '/api/onboard'  && m === 'POST') return onboard(request, env);
  if (p === '/api/profiles' && m === 'GET')  return listProfiles(request, env, url);
  if (p === '/api/like'     && m === 'POST') return like(request, env);
  if (p === '/api/matches'  && m === 'GET')  return listMatches(request, env);

  // messaging
  if (p === '/api/messages' && m === 'GET')  return listMessages(request, env, url);
  if (p === '/api/messages' && m === 'POST') return sendMessage(request, env);

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
  const u = await env.DB.prepare(
    `SELECT u.id,u.email,u.plan,u.email_verified,p.display_name,p.gender,p.age,p.area,p.verified,p.photo_key
     FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=?`).bind(uid).first();
  if (u) u.needs_onboarding = u.display_name ? 0 : 1;
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
  const res = Response.redirect(`${origin}/`, 302);
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
  if (q.get('gender')) { where.push('gender=?'); bind.push(q.get('gender')); }
  if (q.get('area'))   { where.push('area=?');   bind.push(q.get('area')); }
  if (q.get('min'))    { where.push('age>=?');   bind.push(Number(q.get('min'))); }
  if (q.get('max'))    { where.push('age<=?');   bind.push(Number(q.get('max'))); }
  if (uid)             { where.push('user_id!=?'); bind.push(uid); }
  const limit = Math.min(Number(q.get('limit') || 24), 48), offset = Number(q.get('offset') || 0);
  const rows = await env.DB.prepare(
    `SELECT user_id,display_name,gender,age,area,tagline,photo_key,verified,last_active
     FROM profiles WHERE ${where.join(' AND ')} ORDER BY last_active DESC LIMIT ? OFFSET ?`)
    .bind(...bind, limit, offset).all();
  return json({ items: rows.results, offset, limit });
}

// ---------- likes / matches ----------
async function like(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { to_id } = await request.json();
  if (!to_id || to_id === uid) return json({ error: 'invalid target' }, 400);
  const now = Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO likes (from_id,to_id,created_at) VALUES (?,?,?)')
    .bind(uid, to_id, now).run();
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

// ---------- messaging ----------
async function matchMember(env, matchId, uid) {
  const row = await env.DB.prepare('SELECT a_id,b_id FROM matches WHERE id=?').bind(matchId).first();
  if (!row) return null;
  if (row.a_id !== uid && row.b_id !== uid) return null;
  return row;
}

async function listMessages(request, env, url) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const matchId = url.searchParams.get('match_id');
  if (!matchId || !(await matchMember(env, matchId, uid))) return json({ error: 'not found' }, 404);
  const after = Number(url.searchParams.get('after') || 0);
  const rows = await env.DB.prepare(
    `SELECT id,from_id,body,created_at FROM messages
     WHERE match_id=? AND created_at>? ORDER BY created_at ASC LIMIT 200`)
    .bind(matchId, after).all();
  return json({ items: rows.results, me: uid });
}

async function sendMessage(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const u = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(uid).first();
  if (!PLANS[u.plan]?.messaging)
    return json({ error: 'メッセージの送信はスタンダードプラン以上でご利用いただけます', upgrade: true }, 402);
  const { match_id, body } = await request.json();
  const text = (body || '').trim();
  if (!text) return json({ error: '本文が空です' }, 400);
  if (text.length > 2000) return json({ error: '長すぎます' }, 400);
  if (!match_id || !(await matchMember(env, match_id, uid))) return json({ error: 'not found' }, 404);
  const id = uuid(), now = Date.now();
  await env.DB.prepare('INSERT INTO messages (id,match_id,from_id,body,created_at) VALUES (?,?,?,?,?)')
    .bind(id, match_id, uid, text, now).run();
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
