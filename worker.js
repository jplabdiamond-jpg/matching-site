// ============================================================
// Matching app — Cloudflare Worker (dependency-free)
// 静的配信 + /api/*。DB=D1, session=KV, 写真=R2, 課金=Stripe(fetch直叩き)
// ============================================================

const PLANS = {
  free:     { messaging: false, seeLikes: false },
  standard: { messaging: true,  seeLikes: false },
  premium:  { messaging: true,  seeLikes: true  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request); // 静的ファイル
    }
    try {
      return await route(request, env, url);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

async function route(request, env, url) {
  const p = url.pathname;
  const m = request.method;

  if (p === '/api/signup'   && m === 'POST') return signup(request, env);
  if (p === '/api/login'    && m === 'POST') return login(request, env);
  if (p === '/api/logout'   && m === 'POST') return logout(request, env);
  if (p === '/api/me'       && m === 'GET')  return me(request, env);
  if (p === '/api/profiles' && m === 'GET')  return listProfiles(request, env, url);
  if (p === '/api/like'     && m === 'POST') return like(request, env);
  if (p === '/api/matches'  && m === 'GET')  return listMatches(request, env);
  if (p === '/api/checkout' && m === 'POST') return checkout(request, env);
  if (p === '/api/stripe/webhook' && m === 'POST') return stripeWebhook(request, env);

  return json({ error: 'not found' }, 404);
}

// ---------- 認証 -------------------------------------------------
async function signup(request, env) {
  const { email, password, display_name, gender, age, area } = await request.json();
  if (!email || !password || !display_name || !gender || !age || !area)
    return json({ error: '必須項目が不足しています' }, 400);
  if (Number(age) < 18) return json({ error: '18歳未満はご利用いただけません' }, 400);

  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first();
  if (exists) return json({ error: 'このメールは登録済みです' }, 409);

  const id = uuid();
  const now = Date.now();
  const hash = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id,email,pass_hash,plan,age_verified,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, email, hash, 'free', 0, now),
    env.DB.prepare(`INSERT INTO profiles
        (user_id,display_name,gender,age,area,verified,last_active,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, display_name, gender, Number(age), area, 0, now, now),
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
    `SELECT u.id,u.email,u.plan,p.display_name,p.gender,p.age,p.area,p.verified
     FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=?`).bind(uid).first();
  return json(u);
}

// ---------- Explorer（一覧・フィルタ・ページング）---------------
async function listProfiles(request, env, url) {
  const uid = await auth(request, env); // 未ログインでも閲覧可（いいねは要ログイン）
  const q = url.searchParams;
  const where = ['1=1'];
  const bind = [];
  if (q.get('gender')) { where.push('gender=?'); bind.push(q.get('gender')); }
  if (q.get('area'))   { where.push('area=?');   bind.push(q.get('area')); }
  if (q.get('min'))    { where.push('age>=?');    bind.push(Number(q.get('min'))); }
  if (q.get('max'))    { where.push('age<=?');    bind.push(Number(q.get('max'))); }
  if (uid)             { where.push('user_id!=?'); bind.push(uid); }

  const limit = Math.min(Number(q.get('limit') || 24), 48);
  const offset = Number(q.get('offset') || 0);
  const rows = await env.DB.prepare(
    `SELECT user_id,display_name,gender,age,area,tagline,photo_key,verified,last_active
     FROM profiles WHERE ${where.join(' AND ')}
     ORDER BY last_active DESC LIMIT ? OFFSET ?`)
    .bind(...bind, limit, offset).all();

  return json({ items: rows.results, offset, limit });
}

// ---------- いいね → 相互でマッチ成立 --------------------------
async function like(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { to_id } = await request.json();
  if (!to_id || to_id === uid) return json({ error: 'invalid target' }, 400);

  const now = Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO likes (from_id,to_id,created_at) VALUES (?,?,?)')
    .bind(uid, to_id, now).run();

  const back = await env.DB.prepare('SELECT 1 FROM likes WHERE from_id=? AND to_id=?')
    .bind(to_id, uid).first();
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
     FROM matches m
     JOIN profiles p ON p.user_id = CASE WHEN m.a_id=? THEN m.b_id ELSE m.a_id END
     WHERE m.a_id=? OR m.b_id=? ORDER BY m.created_at DESC`)
    .bind(uid, uid, uid).all();
  return json({ items: rows.results });
}

// ---------- Stripe 課金（Cloudflare完結・SDK不要）--------------
async function checkout(request, env) {
  const uid = await auth(request, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const { plan } = await request.json();
  const price = plan === 'premium' ? env.STRIPE_PRICE_PREMIUM : env.STRIPE_PRICE_STANDARD;
  const u = await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(uid).first();

  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    success_url: `${env.APP_URL}/?upgraded=1`,
    cancel_url: `${env.APP_URL}/?canceled=1`,
    client_reference_id: uid,
    customer_email: u.email,
    'metadata[user_id]': uid,
    'metadata[plan]': plan,
  });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
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

  const event = JSON.parse(body);
  const now = Date.now();
  const obj = event.data.object;

  if (event.type === 'checkout.session.completed') {
    const uid = obj.metadata?.user_id || obj.client_reference_id;
    const plan = obj.metadata?.plan || 'standard';
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET plan=?, stripe_customer_id=? WHERE id=?')
        .bind(plan, obj.customer, uid),
      env.DB.prepare(`INSERT INTO subscriptions (user_id,stripe_sub_id,plan,status,updated_at)
          VALUES (?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET stripe_sub_id=excluded.stripe_sub_id,
          plan=excluded.plan,status='active',updated_at=excluded.updated_at`)
        .bind(uid, obj.subscription, plan, 'active', now),
    ]);
  }

  if (event.type === 'customer.subscription.deleted') {
    await env.DB.prepare(
      `UPDATE users SET plan='free' WHERE id=(SELECT user_id FROM subscriptions WHERE stripe_sub_id=?)`)
      .bind(obj.id).run();
    await env.DB.prepare('UPDATE subscriptions SET status=?, updated_at=? WHERE stripe_sub_id=?')
      .bind('canceled', now, obj.id).run();
  }

  return json({ received: true });
}

// ---------- ヘルパー -------------------------------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function uuid() { return crypto.randomUUID(); }

async function withSession(uid, env, res) {
  const sid = uuid();
  await env.SESSIONS.put('sess:' + sid, uid, { expirationTtl: 60 * 60 * 24 * 30 });
  res.headers.append('Set-Cookie',
    `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
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

// PBKDF2（Web Crypto）— salt:hash を保存
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt);
  return `${b64(salt)}:${b64(new Uint8Array(bits))}`;
}
async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;
  const salt = fromB64(saltB64);
  const bits = await pbkdf2(password, salt);
  return b64(new Uint8Array(bits)) === hashB64;
}
async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
    'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
}
function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function fromB64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

// Stripe 署名検証（t + v1 の HMAC-SHA256）
async function verifyStripeSig(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')));
  const signed = `${parts.t}.${payload}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, parts.v1 || '');
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
