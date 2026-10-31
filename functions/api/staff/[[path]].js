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
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) fail('Use a password between 6 and 128 characters.');
  return value;
};
const ceoTitle = 'Group Chief Executive Officer';
const reservedOwnerName = name => ['chairman','ceo','group ceo','chief executive officer','group chief executive officer'].includes(name.trim().toLowerCase());
const publicUser = user => ({ id: user.id, name: user.name, email: user.email, role: user.role, rank: user.role === 'chairman' ? ceoTitle : (user.rank || 'Holdings Staff'), department: user.department || '', management: user.role === 'chairman' || !!user.management });

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/api\/staff\/?/, '').replace(/\/$/, '');
    const method = request.method;
    if (!['GET', 'POST'].includes(method)) return response({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
    if (method === 'POST' && request.headers.get('Origin') !== url.origin) fail('Please submit from the Altaş Staff Hub.', 403);
    if (!env.STAFF_DB) fail('The staff hub is awaiting Cloudflare database activation. Please contact the Group CEO.', 503);
    const db = env.STAFF_DB;
    const now = Date.now();
    const setupHash = /^[a-f0-9]{64}$/.test(env.STAFF_SETUP_KEY_HASH || '') ? env.STAFF_SETUP_KEY_HASH : typeof env.STAFF_SETUP_KEY === 'string' && env.STAFF_SETUP_KEY.length >= 32 ? await digest(env.STAFF_SETUP_KEY) : null;
    const query = (sql, ...args) => db.prepare(sql).bind(...args);
    const profile = async account => {
      const data = await query("SELECT r.name AS rank,r.management,p.department FROM staff_users u LEFT JOIN staff_profiles p ON p.user_id=u.id LEFT JOIN staff_ranks r ON r.id=COALESCE(p.rank_id,'staff') WHERE u.id=?", account.id).first();
      return { ...account, ...data };
    };
    const audit = (action, detail, actor) => query('INSERT INTO staff_activity(id,actor_id,action,detail,created_at) VALUES (?,?,?,?,?)', crypto.randomUUID(), actor, action, detail, now);

    if (method === 'GET' && action === 'status') {
      const admin = await query("SELECT id FROM staff_users WHERE role='chairman'").first();
      return response({ ready: true, setup: !admin && !!setupHash });
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
    if (method === 'POST' && ['check-reset', 'reset-password'].includes(action)) {
      await rate('recovery', 15, 15);
      const invalid = () => fail('This recovery link has expired or has already been used. Ask your administrator for a new link.', 410);
      if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) invalid();
      const resetHash = await digest(body.token);
      const reset = await query('SELECT r.user_id FROM staff_password_resets r JOIN staff_users u ON u.id=r.user_id WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND u.active=1', resetHash, now).first();
      if (!reset) invalid();
      if (action === 'check-reset') return response({ ready: true });
      const salt = random(), hash = await passwordHash(passField(body.password), salt);
      // The token stays unconsumed until all credential, session and audit changes
      // commit together. The conditional update prevents concurrent token reuse.
      const valid = 'EXISTS (SELECT 1 FROM staff_password_resets r JOIN staff_users u ON u.id=r.user_id WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND u.active=1)';
      const changed = await db.batch([
        query('UPDATE staff_users SET password_hash=?,salt=? WHERE id=? AND active=1 AND ' + valid, hash, salt, reset.user_id, resetHash, now),
        query('DELETE FROM staff_sessions WHERE user_id=? AND ' + valid, reset.user_id, resetHash, now),
        query('INSERT INTO staff_activity(id,actor_id,action,detail,created_at) SELECT ?,user_id,?,?,? FROM staff_password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at>?', crypto.randomUUID(), 'Password recovered', 'Private recovery link used; previous sessions signed out.', now, resetHash, now),
        query('UPDATE staff_password_resets SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?', now, resetHash, now)
      ]);
      if (Number(changed[0]?.meta?.changes ?? changed[0]?.changes) !== 1) invalid();
      return response({ ok: true }, 200, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
    if (method === 'POST' && ['setup', 'login', 'accept-invite'].includes(action)) {
      await rate('auth', 25, 15);
      if (action === 'setup') {
        if (!setupHash || typeof body.setupKey !== 'string' || body.setupKey.length > 256 || !same(await digest(body.setupKey), setupHash)) fail('Setup is unavailable or the setup key is incorrect.', 403);
        if (await query("SELECT id FROM staff_users WHERE role='chairman'").first()) fail('The CEO account has already been created.', 409);
        const email = emailField(body.email), name = field(body.name, 2, 80, 'Name');
        const salt = random(), hash = await passwordHash(passField(body.password), salt), id = crypto.randomUUID();
        await db.batch([
          query("INSERT INTO staff_users(id,email,name,password_hash,salt,role,created_at) VALUES (?,?,?,?,?,'chairman',?)", id, email, name, hash, salt, now),
          query("INSERT INTO staff_profiles(user_id,rank_id,department) VALUES (?,'group-ceo','Executive Office')", id)
        ]);
        return response({ user: publicUser({ id, email, name, role: 'chairman', department: 'Executive Office' }) }, 201, { 'Set-Cookie': await newSession(id, false) });
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
        return response({ user: publicUser(await profile(user)) }, 201, { 'Set-Cookie': await newSession(id, false) });
      }
      const email = emailField(body.email);
      await rate('account', 10, 15, email);
      const password = typeof body.password === 'string' && body.password.length <= 128 ? body.password : '';
      const user = await query('SELECT * FROM staff_users WHERE email=?', email).first();
      const check = await passwordHash(password, user?.salt || 'altas-dummy-salt-for-timing-check');
      if (!user || !same(check, user.password_hash) || !user.active) fail('Email or password is incorrect.', 401);
      await query('DELETE FROM staff_rate_limits WHERE expires_at<?', now).run();
      await query('DELETE FROM staff_sessions WHERE expires_at<?', now).run();
      return response({ user: publicUser(await profile(user)) }, 200, { 'Set-Cookie': await newSession(user.id, body.remember === true) });
    }
    const token = request.headers.get('Cookie')?.split(';').map(c => c.trim()).find(c => c.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
    if (!/^[a-f0-9]{64}$/.test(token)) fail('Please sign in to your Altaş account.', 401);
    const tokenHash = await digest(token);
    let user = await query('SELECT u.* FROM staff_users u JOIN staff_sessions s ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1', tokenHash, now).first();
    if (!user) fail('Your session has ended. Please sign in again.', 401);
    user = await profile(user);
    const manager = user.role === 'chairman' || !!user.management;
    if (method === 'GET' && action === 'me') return response({ user: publicUser(await profile(user)) });
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
      const tasks = await query(`SELECT t.*,u.name AS assignee FROM staff_tasks t JOIN staff_users u ON u.id=t.assignee_id ${manager ? '' : 'WHERE t.assignee_id=?'} ORDER BY CASE t.status WHEN 'done' THEN 1 ELSE 0 END, t.created_at DESC LIMIT 200`, ...(manager ? [] : [user.id])).all();
      return response({ announcements: announcements.results, resources: resources.results, tasks: tasks.results });
    }
    if (method === 'POST' && action === 'task-status') {
      const id = field(body.id, 1, 100, 'Task ID');
      if (!['todo','in_progress','done'].includes(body.status)) fail('Choose a valid task status.');
      const task = await query('SELECT * FROM staff_tasks WHERE id=?', id).first();
      if (!task) fail('Task not found.', 404);
      if (!manager && task.assignee_id !== user.id) fail('You can only update your own tasks.', 403);
      await db.batch([query('UPDATE staff_tasks SET status=?,updated_at=? WHERE id=?', body.status, now, id), audit('Task status updated', task.title + ' → ' + body.status, user.id)]);
      return response({ ok: true });
    }
    if (!manager) fail('Management access is required.', 403);
    const ownerActions = ['staff','invite','staff-access','staff-profile','rank','activity','revoke-invite'];
    if (ownerActions.includes(action) && user.role !== 'chairman') fail('Only the Group CEO can manage ranks and staff access.', 403);
    if (method === 'GET' && action === 'directory') {
      const result = await query("SELECT u.id,u.name,u.email,u.role,u.active,COALESCE(r.name,'Holdings Staff') AS rank,COALESCE(p.department,'') AS department,COALESCE(p.rank_id,'staff') AS rank_id,COALESCE(r.management,0) AS management FROM staff_users u LEFT JOIN staff_profiles p ON p.user_id=u.id LEFT JOIN staff_ranks r ON r.id=COALESCE(p.rank_id,'staff') ORDER BY u.name").all();
      const ranks = await query('SELECT * FROM staff_ranks ORDER BY sort_order,name').all();
      return response({ staff: result.results.map(person => ({ ...person, rank: person.role === 'chairman' ? ceoTitle : person.rank, management: person.role === 'chairman' ? 1 : person.management })), ranks: ranks.results.filter(rank => rank.id !== 'group-ceo' && !reservedOwnerName(rank.name)) });
    }
    if (method === 'GET' && action === 'activity') {
      const result = await query('SELECT a.action,a.detail,a.created_at,u.name AS actor FROM staff_activity a JOIN staff_users u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 100').all();
      return response({ activity: result.results });
    }
    if (method === 'POST' && action === 'rank') {
      const name = field(body.name,2,60,'Rank name');
      if (typeof body.management !== 'boolean') fail('Choose rank permissions.');
      if (reservedOwnerName(name) || body.id === 'group-ceo') fail('Group Chief Executive Officer is the protected owner position.');
      const id = body.id ? field(body.id,1,100,'Rank ID') : crypto.randomUUID();
      const old = await query('SELECT * FROM staff_ranks WHERE id=?', id).first();
      if (body.id && !old) fail('Rank not found.',404);
      const duplicate = await query('SELECT id FROM staff_ranks WHERE name=? AND id<>?',name,id).first();
      if (duplicate) fail('A rank already uses this name.',409);
      // The fallback rank cannot gain management permissions.
      if (id === 'staff' && body.management) fail('The default staff rank must keep standard permissions.');
      await db.batch([query('INSERT INTO staff_ranks(id,name,management,sort_order) VALUES (?,?,?,50) ON CONFLICT(id) DO UPDATE SET name=excluded.name,management=excluded.management',id,name,body.management?1:0),audit(old?'Rank updated':'Rank created',name + (body.management?' · management':' · standard'),user.id)]);
      return response({ok:true});
    }
    if (method === 'POST' && action === 'staff-profile') {
      const id = field(body.id,1,100,'Staff ID'), rank = field(body.rank_id,1,100,'Rank');
      const department = typeof body.department === 'string' ? body.department.trim() : '';
      if (department.length > 80) fail('Department must be at most 80 characters.');
      const target = await query("SELECT * FROM staff_users WHERE id=? AND role='staff'",id).first();
      if (!target) fail('Staff member not found.',404);
      const selected = await query('SELECT * FROM staff_ranks WHERE id=?',rank).first();
      if (!selected) fail('Rank not found.',404);
      if (selected.id === 'group-ceo' || reservedOwnerName(selected.name)) fail('The Group CEO position belongs to the owner account.');
      await db.batch([query('INSERT INTO staff_profiles(user_id,rank_id,department) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET rank_id=excluded.rank_id,department=excluded.department',id,rank,department),audit('Staff rank updated',target.name + ' · ' + selected.name + (department?' · '+department:''),user.id)]);
      return response({ok:true});
    }
    if (method === 'POST' && action === 'revoke-invite') {
      const email = emailField(body.email);
      await db.batch([query('DELETE FROM staff_invites WHERE email=? AND used_at IS NULL',email),audit('Invitation revoked',email,user.id)]);
      return response({ok:true});
    }
    if (method === 'POST' && action === 'task') {
      const title = field(body.title,3,120,'Task title');
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (description.length > 4000) fail('Task description is too long.');
      const assignee = field(body.assignee_id,1,100,'Assignee');
      if (!await query('SELECT id FROM staff_users WHERE id=? AND active=1',assignee).first()) fail('Choose an active staff member.');
      if (!['normal','high'].includes(body.priority)) fail('Choose a valid priority.');
      const due = body.due_date || '';
      if (typeof due !== 'string' || (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due+'T00:00:00Z')) || new Date(due+'T00:00:00Z').toISOString().slice(0,10)!==due))) fail('Enter a valid due date.');
      await db.batch([query('INSERT INTO staff_tasks(id,title,description,assignee_id,created_by,priority,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',crypto.randomUUID(),title,description,assignee,user.id,body.priority,due,now,now),audit('Task assigned',title,user.id)]);
      return response({ok:true},201);
    }

    if (method === 'GET' && action === 'staff') {
      const result = await query('SELECT id,email,name,role,active,created_at FROM staff_users ORDER BY created_at').all();
      const invites = await query('SELECT email,name,expires_at FROM staff_invites WHERE used_at IS NULL AND expires_at>? ORDER BY expires_at DESC', now).all();
      return response({ staff: result.results, invites: invites.results });
    }
    if (method === 'POST' && action === 'invite') {
      const email = emailField(body.email), name = field(body.name, 2, 80, 'Name');
      if (await query('SELECT id FROM staff_users WHERE email=?', email).first()) fail('An account already exists for this email.', 409);
      const token = random(), expires = now + 48 * 3600000;
      await db.batch([query('DELETE FROM staff_invites WHERE email=?', email), query('INSERT INTO staff_invites(token_hash,email,name,expires_at,created_by) VALUES (?,?,?,?,?)', await digest(token), email, name, expires, user.id),audit('Invitation created',name+' · '+email,user.id)]);
      return response({ link: `${url.origin}/staff/#invite=${token}`, expires_at: expires }, 201);
    }
    if (method === 'POST' && action === 'staff-access') {
      const id = field(body.id, 1, 100, 'Staff ID');
      if (id === user.id) fail('You cannot suspend your own account.');
      const target = await query("SELECT id,name FROM staff_users WHERE id=? AND role='staff'", id).first();
      if (!target) fail('Staff member not found.', 404);
      if (typeof body.active !== 'boolean') fail('Choose an access status.');
      await db.batch([query('UPDATE staff_users SET active=? WHERE id=?', body.active ? 1 : 0, id), query('DELETE FROM staff_sessions WHERE user_id=?', id),audit(body.active?'Staff access restored':'Staff access suspended',target.name,user.id)]);
      return response({ ok: true });
    }
    if (method === 'POST' && action === 'announcement') {
      const title = field(body.title, 3, 120, 'Title'), text = field(body.body, 5, 8000, 'Announcement');
      await db.batch([query('INSERT INTO staff_announcements(id,title,body,author_id,created_at) VALUES (?,?,?,?,?)', crypto.randomUUID(), title, text, user.id, now),audit('Announcement published',title,user.id)]);
      return response({ ok: true }, 201);
    }
    if (method === 'POST' && action === 'resource') {
      const title = field(body.title, 2, 120, 'Title'), value = field(body.url, 8, 2000, 'Link');
      let link;
      try { link = new URL(value); } catch { fail('Enter a valid HTTPS link.'); }
      if (link.protocol !== 'https:' || link.username || link.password) fail('Use an HTTPS link without embedded credentials.');
      await db.batch([query('INSERT INTO staff_resources(id,title,url,created_at) VALUES (?,?,?,?)', crypto.randomUUID(), title, link.href, now),audit('Resource added',title,user.id)]);
      return response({ ok: true }, 201);
    }
    if (method === 'POST' && action === 'delete-content') {
      const id = field(body.id, 1, 100, 'Item ID');
      if (!['announcement', 'resource'].includes(body.kind)) fail('Unknown content type.');
      const table = body.kind === 'announcement' ? 'staff_announcements' : 'staff_resources';
      await db.batch([query(`DELETE FROM ${table} WHERE id=?`, id),audit('Content deleted',body.kind+' · '+id,user.id)]);
      return response({ ok: true });
    }
    return response({ error: 'Not found.' }, 404);
  } catch (error) {
    return response({ error: error.status ? error.message : 'The staff service is unavailable. Please try again or contact the Group CEO.' }, error.status || 503);
  }
}

