import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { onRequest } from '../functions/api/staff/[[path]].js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_staff.sql', import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...values) => wrap(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: sqlite.prepare(sql).run(...args) }),
    execute: () => sqlite.prepare(sql).run(...args)
  });
  return { prepare: sql => wrap(sql), batch: async statements => {
    sqlite.exec('BEGIN');
    try { const result = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}
function client(env, ip) {
  let cookie = '';
  return async (action, data, options = {}) => {
    const method = data === undefined ? 'GET' : 'POST';
    const headers = { 'CF-Connecting-IP': ip, Cookie: cookie };
    if (method === 'POST') { headers.Origin = options.origin || 'https://altas.example'; headers['Content-Type'] = 'application/json'; }
    const res = await onRequest({ env, request: new Request('https://altas.example/api/staff/' + action, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }) });
    const setCookie = res.headers.get('Set-Cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json(), cookie: setCookie };
  };
}

test('hashed one-time setup keys cannot be used as bearer setup credentials', async () => {
  const key = 'private-test-setup-key-at-least-32-characters';
  const hash = createHash('sha256').update(key).digest('hex');
  const call = client({ STAFF_DB: database(), STAFF_SETUP_KEY_HASH: hash }, '192.0.2.15');
  const setup = { name: 'Chairman', email: 'chairman@example.com', password: 'long test password for chairman' };
  assert.equal((await call('status')).body.setup, true);
  assert.equal((await call('setup', { ...setup, setupKey: hash })).status, 403);
  assert.equal((await call('setup', { ...setup, setupKey: key })).status, 201);
  assert.equal((await call('status')).body.setup, false);
  assert.equal((await call('setup', { ...setup, setupKey: key })).status, 409);
});

test('secure separate accounts, invitation lifecycle, access controls and session revocation', async () => {
  const env = { STAFF_DB: database(), STAFF_SETUP_KEY: 'test-only-private-setup-key-at-least-32-characters' };
  const chairman = client(env, '192.0.2.1'), anonymous = client(env, '192.0.2.2'), staff = client(env, '192.0.2.3');
  assert.equal((await client({}, '192.0.2.4')('status')).status, 503);
  assert.equal((await anonymous('dashboard')).status, 401);
  assert.equal((await anonymous('status')).body.setup, true);
  const setup = { setupKey: env.STAFF_SETUP_KEY, name: 'Chairman', email: 'chairman@example.com', password: 'a strong test password' };
  assert.equal((await chairman('setup', { ...setup, setupKey: 'wrong' })).status, 403);
  const created = await chairman('setup', setup);
  assert.equal(created.status, 201);
  assert.match(created.cookie, /Secure; SameSite=Strict/);
  assert.match(created.cookie, /HttpOnly/);
  assert.equal((await anonymous('status')).body.setup, false);
  assert.equal((await anonymous('setup', setup)).status, 409);
  assert.equal((await anonymous('login', { email: setup.email, password: 'wrong' })).status, 401);
  assert.equal((await chairman('invite', { email: 'staff@example.com', name: 'Group Staff' }, { origin: 'https://evil.example' })).status, 403);
  const first = await chairman('invite', { email: 'staff@example.com', name: 'Group Staff' });
  const second = await chairman('invite', { email: 'staff@example.com', name: 'Group Staff' });
  const token = link => new URLSearchParams(new URL(link).hash.slice(1)).get('invite');
  assert.equal((await staff('accept-invite', { token: token(first.body.link), password: 'a strong staff password' })).status, 410);
  const registered = await staff('accept-invite', { token: token(second.body.link), password: 'a strong staff password', role: 'chairman' });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.user.role, 'staff');
  assert.equal((await anonymous('accept-invite', { token: token(second.body.link), password: 'another strong password' })).status, 410);
  const expired = await chairman('invite', { email: 'expired@example.com', name: 'Expired Invite' });
  await env.STAFF_DB.prepare('UPDATE staff_invites SET expires_at=0 WHERE email=?').bind('expired@example.com').run();
  assert.equal((await anonymous('accept-invite', { token: token(expired.body.link), password: 'another strong password' })).status, 410);
  const stored = await env.STAFF_DB.prepare('SELECT password_hash FROM staff_users WHERE email=?').bind('staff@example.com').first();
  assert.match(stored.password_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.password_hash, 'a strong staff password');
  for (const [action, data] of [['staff', undefined], ['invite', { email: 'outsider@example.com', name: 'Outside' }], ['announcement', { title: 'Bad action', body: 'Staff cannot post this.' }], ['resource', { title: 'Bad link', url: 'https://example.com' }], ['staff-access', { id: created.body.user.id, active: false }], ['delete-content', { kind: 'announcement', id: 'unknown' }]]) {
    assert.equal((await staff(action, data)).status, 403, action);
  }
  const announcement = { title: '<script>Untrusted title</script>', body: 'Group announcement\nwith more than one line.' };
  assert.equal((await chairman('announcement', announcement)).status, 201);
  assert.equal((await chairman('resource', { title: 'Unsafe link', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await chairman('resource', { title: 'Group handbook', url: 'https://example.com/handbook' })).status, 201);
  const dashboard = await staff('dashboard');
  assert.equal(dashboard.body.announcements[0].title, announcement.title);
  assert.equal(dashboard.body.resources.length, 1);
  assert.equal((await chairman('staff-access', { id: created.body.user.id, active: false })).status, 400);
  const anotherSession = client(env, '192.0.2.5');
  const login = await anotherSession('login', { email: 'staff@example.com', password: 'a strong staff password', remember: true });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /Max-Age=2592000/);
  assert.equal((await staff('password', { currentPassword: 'wrong', password: 'new strong staff password' })).status, 403);
  assert.equal((await staff('password', { currentPassword: 'a strong staff password', password: 'new strong staff password' })).status, 200);
  assert.equal((await anotherSession('me')).status, 401);
  assert.equal((await staff('me')).status, 200);
  assert.equal((await chairman('staff-access', { id: registered.body.user.id, active: false })).status, 200);
  assert.equal((await staff('me')).status, 401);
  assert.equal((await staff('login', { email: 'staff@example.com', password: 'new strong staff password' })).status, 401);
  assert.equal((await chairman('staff-access', { id: registered.body.user.id, active: true })).status, 200);
  assert.equal((await staff('login', { email: 'staff@example.com', password: 'new strong staff password' })).status, 200);
  assert.equal((await staff('logout', {})).status, 200);
  assert.equal((await staff('me')).status, 401);
  assert.equal((await chairman('delete-content', { kind: 'announcement', id: dashboard.body.announcements[0].id })).status, 200);
  assert.equal((await chairman('dashboard')).body.announcements.length, 0);
});

test('authentication throttling and request validation', async () => {
  const clientCall = client({ STAFF_DB: database() }, '192.0.2.10');
  assert.equal((await clientCall('setup', { setupKey: 'any-key' })).status, 403);
  assert.equal((await clientCall('login', { email: null, password: 'invalid' })).status, 400);
  for (let i = 0; i < 10; i++) assert.equal((await clientCall('login', { email: 'missing@example.com', password: 'invalid' })).status, 401);
  assert.equal((await clientCall('login', { email: 'missing@example.com', password: 'invalid' })).status, 429);
});

test('UI bindings and security headers remain consistent', () => {
  const html = readFileSync(new URL('../staff/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../staff/hub.js', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size, 'unique HTML IDs');
  for (const match of js.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), match[1]);
  assert.equal(js.includes('innerHTML'), false, 'user text must use DOM text nodes');
  assert.equal(js.includes('localStorage'), false, 'no credentials in local storage');
  assert.match(readFileSync(new URL('../_headers', import.meta.url), 'utf8'), /frame-ancestors 'none'/);
});
