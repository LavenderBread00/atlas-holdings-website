const enc = new TextEncoder();
const cookieName = '__Host-altas_staff';
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => hex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
const passwordHash = async (password, salt) => {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
};
const same = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
const response = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', ...extra
} });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const field = (value, min, max, label) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(`${label} must be ${min}–${max} characters.`);
  return value.trim();
};
const emailField = value => {
  const email = field(value, 5, 254, 'Email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email address.');
  return email;
};
const passField = value => {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) fail('Use a password between 12 and 128 characters.');
  return value;
};
const publicUser = user => ({ id: user.id, name: user.name, email: user.email, role: user.role });

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/api\/staff\/?/, '').replace(/\/$/, '');
    const method = request.method;
    if (!['GET', 'POST'].includes(method)) return response({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
    if (method === 'POST' && request.headers.get('Origin') !== url.origin) fail('Please submit from the Altaş Staff Hub.', 403);
    if (!env.STAFF_DB) fail('The staff hub is awaiting Cloudflare database activation. Please contact the chairman.', 503);
    const db = env.STAFF_DB;
    const now = Date.now();
    const query = (sql, ...args) => db.prepare(sql).bind(...args);
    if (method === 'GET' && action === 'status') {
      const admin = await query("SELECT id FROM staff_users WHERE role='chairman'").first();
      return response({ ready: true, setup: !admin && typeof env.STAFF_SETUP_KEY === 'string' && env.STAFF_SETUP_KEY.length >= 32 });
    }
    let body = {};
    if (method === 'POST') {
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail('JSON required.', 415);
      const raw = await request.text();
      if (raw.length > 20000) fail('Request too large.', 413);
      try { body = JSON.parse(raw); } catch { fail('Invalid request.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid request.');
    }
    const rate = async (scope, limit, minutes, identifier = '') => {
      const key = await digest(`${scope}:${request.headers.get('CF-Connecting-IP') || 'unknown'}:${identifier}`);
      const row = await query('INSERT INTO staff_rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count', key, now + minutes * 60000, now, now).first();
      if (row.count > limit) fail('Too many attempts. Please try again later.', 429);
    };
    const newSession = async (id, remember) => {
      const token = random();
      const age = (remember ? 30 * 24 : 12) * 3600;
      await query('INSERT INTO staff_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)', await digest(token), id, now + age * 1000).run();
      return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
    };
    if (method === 'POST' && ['setup', 'login', 'accept-invite'].includes(action)) {
      await rate('auth', 25, 15);
      if (action === 'setup') {
        if (typeof env.STAFF_SETUP_KEY !== 'string' || env.STAFF_SETUP_KEY.length < 32 || typeof body.setupKey !== 'string' || !same(await digest(body.setupKey), await digest(env.STAFF_SETUP_KEY))) fail('Setup is unavailable or the setup key is incorrect.', 403);
        if (await query("SELECT id FROM staff_users WHERE role='chairman'").first()) fail('The chairman account has already been created.', 409);
        const email = emailField(body.email), name = field(body.name, 2, 80, 'Name');
        const salt = random(), hash = await passwordHash(passField(body.password), salt), id = crypto.randomUUID();
        await query("INSERT INTO staff_users(id,email,name,password_hash,salt,role,created_at) VALUES (?,?,?,?,?,'chairman',?)", id, email, name, hash, salt, now).run();
        return response({ user: { id, email, name, role: 'chairman' } }, 201, { 'Set-Cookie': await newSession(id, false) });
      }
      if (action === 'accept-invite') {
        const token = field(body.token, 64, 64, 'Invitation');
        const tokenHash = await digest(token);
        const invite = await query('SELECT * FROM staff_invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?', tokenHash, now).first();
        if (!invite) fail('This invitation has expired or has already been used.', 410);
        const salt = random(), hash = await passwordHash(passField(body.password), salt), id = crypto.randomUUID();
        // D1 batches are transactional; the unique email and invite claim prevent duplicate registration.
        await db.batch([
          query("INSERT INTO staff_users(id,email,name,password_hash,salt,role,created_at) SELECT ?,email,name,?,?,'staff',? FROM staff_invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?", id, hash, salt, now, tokenHash, now),
          query('UPDATE staff_invites SET used_at=? WHERE token_hash=? AND used_at IS NULL', now, tokenHash)
        ]);
        const user = await query('SELECT * FROM staff_users WHERE id=?', id).first();
        if (!user) fail('This invitation is no longer available.', 410);
        return response({ user: publicUser(user) }, 201, { 'Set-Cookie': await newSession(id, false) });
      }
      const email = emailField(body.email);
      await rate('account', 10, 15, email);
      const password = typeof body.password === 'string' && body.password.length <= 128 ? body.password : '';
      const user = await query('SELECT * FROM staff_users WHERE email=?', email).first();
      const check = await passwordHash(password, user?.salt || 'altas-dummy-salt-for-timing-check');
      if (!user || !same(check, user.password_hash) || !user.active) fail('Email or password is incorrect.', 401);
      await query('DELETE FROM staff_rate_limits WHERE expires_at<?', now).run();
      await query('DELETE FROM staff_sessions WHERE expires_at<?', now).run();
      return response({ user: publicUser(user) }, 200, { 'Set-Cookie': await newSession(user.id, body.remember === true) });
    }
    const token = request.headers.get('Cookie')?.split(';').map(c => c.trim()).find(c => c.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
    if (!/^[a-f0-9]{64}$/.test(token)) fail('Please sign in to your Altaş account.', 401);
    const tokenHash = await digest(token);
    const user = await query('SELECT u.* FROM staff_users u JOIN staff_sessions s ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1', tokenHash, now).first();
    if (!user) fail('Your session has ended. Please sign in again.', 401);
    if (method === 'GET' && action === 'me') return response({ user: publicUser(user) });
    if (method === 'POST') await rate('writes', 60, 5, user.id);
    if (method === 'POST' && action === 'logout') {
      await query('DELETE FROM staff_sessions WHERE token_hash=?', tokenHash).run();
      return response({ ok: true }, 200, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
    if (method === 'POST' && action === 'password') {
      const password = passField(body.password);
      const current = typeof body.currentPassword === 'string' && body.currentPassword.length <= 128 ? body.currentPassword : '';
      if (!same(await passwordHash(current, user.salt), user.password_hash)) fail('Current password is incorrect.', 403);
      const salt = random(), hash = await passwordHash(password, salt);
      await db.batch([query('UPDATE staff_users SET password_hash=?,salt=? WHERE id=?', hash, salt, user.id), query('DELETE FROM staff_sessions WHERE user_id=?', user.id)]);
      return response({ ok: true }, 200, { 'Set-Cookie': await newSession(user.id, false) });
    }
    if (method === 'GET' && action === 'dashboard') {
      const announcements = await query('SELECT a.id,a.title,a.body,a.created_at,u.name AS author FROM staff_announcements a JOIN staff_users u ON u.id=a.author_id ORDER BY a.created_at DESC LIMIT 100').all();
      const resources = await query('SELECT id,title,url FROM staff_resources ORDER BY created_at DESC LIMIT 100').all();
      return response({ announcements: announcements.results, resources: resources.results });
    }
    if (user.role !== 'chairman') fail('Only the chairman can manage Holdings staff and content.', 403);
    if (method === 'GET' && action === 'staff') {
      const result = await query('SELECT id,email,name,role,active,created_at FROM staff_users ORDER BY created_at').all();
      const invites = await query('SELECT email,name,expires_at FROM staff_invites WHERE used_at IS NULL AND expires_at>? ORDER BY expires_at DESC', now).all();
      return response({ staff: result.results, invites: invites.results });
    }
    if (method === 'POST' && action === 'invite') {
      const email = emailField(body.email), name = field(body.name, 2, 80, 'Name');
      if (await query('SELECT id FROM staff_users WHERE email=?', email).first()) fail('An account already exists for this email.', 409);
      const token = random(), expires = now + 48 * 3600000;
      await db.batch([query('DELETE FROM staff_invites WHERE email=?', email), query('INSERT INTO staff_invites(token_hash,email,name,expires_at,created_by) VALUES (?,?,?,?,?)', await digest(token), email, name, expires, user.id)]);
      return response({ link: `${url.origin}/staff/#invite=${token}`, expires_at: expires }, 201);
    }
    if (method === 'POST' && action === 'staff-access') {
      const id = field(body.id, 1, 100, 'Staff ID');
      if (id === user.id) fail('You cannot suspend your own account.');
      const target = await query("SELECT id FROM staff_users WHERE id=? AND role='staff'", id).first();
      if (!target) fail('Staff member not found.', 404);
      if (typeof body.active !== 'boolean') fail('Choose an access status.');
      await db.batch([query('UPDATE staff_users SET active=? WHERE id=?', body.active ? 1 : 0, id), query('DELETE FROM staff_sessions WHERE user_id=?', id)]);
      return response({ ok: true });
    }
    if (method === 'POST' && action === 'announcement') {
      const title = field(body.title, 3, 120, 'Title'), text = field(body.body, 5, 8000, 'Announcement');
      await query('INSERT INTO staff_announcements(id,title,body,author_id,created_at) VALUES (?,?,?,?,?)', crypto.randomUUID(), title, text, user.id, now).run();
      return response({ ok: true }, 201);
    }
    if (method === 'POST' && action === 'resource') {
      const title = field(body.title, 2, 120, 'Title'), value = field(body.url, 8, 2000, 'Link');
      let link;
      try { link = new URL(value); } catch { fail('Enter a valid HTTPS link.'); }
      if (link.protocol !== 'https:' || link.username || link.password) fail('Use an HTTPS link without embedded credentials.');
      await query('INSERT INTO staff_resources(id,title,url,created_at) VALUES (?,?,?,?)', crypto.randomUUID(), title, link.href, now).run();
      return response({ ok: true }, 201);
    }
    if (method === 'POST' && action === 'delete-content') {
      const id = field(body.id, 1, 100, 'Item ID');
      if (!['announcement', 'resource'].includes(body.kind)) fail('Unknown content type.');
      const table = body.kind === 'announcement' ? 'staff_announcements' : 'staff_resources';
      await query(`DELETE FROM ${table} WHERE id=?`, id).run();
      return response({ ok: true });
    }
    return response({ error: 'Not found.' }, 404);
  } catch (error) {
    return response({ error: error.status ? error.message : 'The staff service is unavailable. Please try again or contact the chairman.' }, error.status || 503);
  }
}
