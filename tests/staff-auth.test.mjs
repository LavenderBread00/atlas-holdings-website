import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { onRequest } from '../functions/api/staff/[[path]].js';
import { readNewDeployment } from '../scripts/deployment-status.mjs';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_staff.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_management.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_recovery.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_group_leadership.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0005_ceo_owner.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0006_rank_permissions.sql', import.meta.url), 'utf8'));
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

test('every group rank gets its intended data and actions while CEO controls stay private', async () => {
  const env={STAFF_DB:database(),STAFF_SETUP_KEY:'feature-test-private-setup-key-at-least-32-characters'};
  const owner=client(env,'192.0.2.100');
  await owner('setup',{setupKey:env.STAFF_SETUP_KEY,email:'owner@example.test',name:'Owner',password:'owner test password'});
  const keys=['view_directory','view_all_tasks','manage_tasks','manage_announcements','manage_resources'];
  const roles=[
    ['group-cfo',[1,1,1,0,1]],['group-coo',[1,1,1,1,1]],['group-cto',[1,1,1,0,1]],
    ['group-cso',[1,1,1,1,1]],['group-ccso',[1,1,1,1,1]],
    ['group-company-secretary',[1,1,0,1,1]],['deputy-company-secretary',[1,0,0,0,1]],
    ['managing-director',[1,1,1,1,1]],['staff',[0,0,0,0,0]]
  ];
  const accounts=[];
  for(let i=0;i<roles.length;i++) {
    const [rank,values]=roles[i],call=client(env,'192.0.2.'+(110+i));
    const invitation=await owner('invite',{email:'role'+i+'@example.test',name:'Role '+i});
    const token=new URLSearchParams(new URL(invitation.body.link).hash.slice(1)).get('invite');
    const joined=await call('accept-invite',{token,password:'role test password',permissions:Object.fromEntries(keys.map(key=>[key,true]))});
    await owner('staff-profile',{id:joined.body.user.id,rank_id:rank});
    await owner('task',{title:'Assigned role task '+i,description:'Own task for this rank.',assignee_id:joined.body.user.id,priority:'normal'});
    accounts.push({rank,call,id:joined.body.user.id,expected:Object.fromEntries(keys.map((key,j)=>[key,!!values[j]]))});
  }
  await owner('announcement',{title:'Shared group update',body:'All staff can read shared announcements.'});
  await owner('resource',{title:'Shared resource',url:'https://example.test/group'});
  const allTasks=(await owner('dashboard')).body.tasks;
  let groupTaskCount=accounts.length;
  for(const account of accounts) {
    const {rank,call,id,expected}=account;
    const me=(await call('me')).body.user;
    assert.deepEqual(me.permissions,expected,rank+' permissions');
    const dashboard=(await call('dashboard')).body;
    assert.deepEqual(dashboard.user.permissions,expected,rank+' dashboard access refresh');
    assert.ok(dashboard.announcements.some(item=>item.title==='Shared group update'));
    assert.ok(dashboard.resources.some(item=>item.title==='Shared resource'));
    assert.equal(dashboard.tasks.length,expected.view_all_tasks?groupTaskCount:1,rank+' task visibility');
    const own=allTasks.find(task=>task.assignee_id===id), other=allTasks.find(task=>task.assignee_id!==id);
    assert.equal((await call('task-status',{id:own.id,status:'in_progress'})).status,200,rank+' own task');
    assert.equal((await call('task-status',{id:other.id,status:'done'})).status,expected.manage_tasks?200:403,rank+' other task');
    assert.equal((await call('directory')).status,expected.view_directory?200:403,rank+' directory');
    assert.equal((await call('task',{title:'Assigned by '+rank,assignee_id:id,priority:'normal'})).status,expected.manage_tasks?201:403,rank+' assign');
    if(expected.manage_tasks)groupTaskCount++;
    assert.equal((await call('announcement',{title:'Update from '+rank,body:'A valid group update for this test.'})).status,expected.manage_announcements?201:403,rank+' publish');
    assert.equal((await call('resource',{title:'Resource from '+rank,url:'https://example.test/resource'})).status,expected.manage_resources?201:403,rank+' resource');
    for(const kind of ['announcement','resource']) assert.equal((await call('delete-content',{kind,id:'no-such-content'})).status,expected[kind==='announcement'?'manage_announcements':'manage_resources']?200:403,rank+' delete '+kind);
    for(const action of ['staff','activity']) assert.equal((await call(action)).status,403,rank+' must not access '+action);
    assert.equal((await call('rank',{id:rank,name:'Unauthorized edit',management:true,permissions:Object.fromEntries(keys.map(key=>[key,true]))})).status,403);
  }
});

test('feature permission changes apply to existing sessions and legacy rank edits preserve custom access', async () => {
  const env={STAFF_DB:database(),STAFF_SETUP_KEY:'feature-test-private-setup-key-at-least-32-characters'};
  const owner=client(env,'192.0.2.130'),staff=client(env,'192.0.2.131');
  const created=await owner('setup',{setupKey:env.STAFF_SETUP_KEY,email:'owner@example.test',name:'Owner',password:'owner password'});
  const invitation=await owner('invite',{email:'worker@example.test',name:'Worker'});
  const token=new URLSearchParams(new URL(invitation.body.link).hash.slice(1)).get('invite');
  const joined=await staff('accept-invite',{token,password:'worker password'});
  await owner('staff-profile',{id:joined.body.user.id,rank_id:'group-coo'});
  await owner('task',{title:'Private owner assignment',assignee_id:created.body.user.id,priority:'normal'});
  const permissions={view_directory:true,view_all_tasks:true,manage_tasks:false,manage_announcements:false,manage_resources:false};
  assert.equal((await owner('rank',{id:'group-coo',name:'Group Chief Operating Officer',management:true,permissions})).status,200);
  assert.equal((await staff('me')).body.user.management,true);
  assert.deepEqual((await staff('me')).body.user.permissions,permissions);
  assert.equal((await staff('announcement',{title:'Blocked publication',body:'This must never be published.'})).status,403);
  assert.equal((await staff('dashboard')).body.tasks.length,1);
  assert.equal((await owner('rank',{id:'group-coo',name:'Operations Lead',management:true})).status,200);
  assert.deepEqual((await staff('me')).body.user.permissions,permissions,'legacy rename preserves feature access');
  assert.equal((await owner('rank',{id:'group-coo',name:'Operations Lead',management:true,permissions:{...permissions,manage_tasks:true,view_directory:false}})).status,400);
  assert.equal((await owner('rank',{id:'group-coo',name:'Operations Lead',management:true,permissions:{...permissions,unexpected:true}})).status,400);
  assert.equal((await owner('rank',{id:'staff',name:'Holdings Staff',management:true,permissions})).status,400);
  assert.equal((await owner('rank',{id:'group-coo',name:'Operations Lead',management:false})).status,200);
  const refreshed=(await staff('dashboard')).body;
  assert.equal(refreshed.tasks.length,0);
  assert.equal(Object.values(refreshed.user.permissions).some(Boolean),false);
  assert.equal((await staff('directory')).status,403);
  assert.equal((await staff('me')).body.user.id,joined.body.user.id,'session remains valid with reduced access');
});

test('role permission migration keeps saved settings and tolerates repeated legacy cleanup', () => {
  const db=new DatabaseSync(':memory:');
  const migration=file=>readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8');
  db.exec(migration('0001_staff.sql'));db.exec(migration('0002_management.sql'));
  db.exec("INSERT INTO staff_users(id,email,name,password_hash,salt,role,created_at) VALUES ('legacy','legacy@example.test','Legacy','original-hash','original-salt','staff',1)");
  db.exec("INSERT INTO staff_profiles(user_id,rank_id,department) VALUES ('legacy','manager','Operations')");
  db.exec("INSERT INTO staff_ranks(id,name,management,sort_order) VALUES ('custom','Custom Manager',1,500)");
  db.exec(migration('0004_group_leadership.sql'));db.exec(migration('0005_ceo_owner.sql'));db.exec(migration('0006_rank_permissions.sql'));
  assert.equal(db.prepare("SELECT manage_announcements FROM staff_rank_permissions WHERE rank_id='custom'").get().manage_announcements,1);
  assert.equal(db.prepare("SELECT manage_announcements FROM staff_rank_permissions WHERE rank_id='group-cfo'").get().manage_announcements,0);
  db.exec("UPDATE staff_rank_permissions SET manage_announcements=1,manage_resources=0 WHERE rank_id='group-cfo'");
  db.exec("DELETE FROM staff_profiles WHERE user_id='legacy'");
  db.exec(migration('0002_management.sql'));db.exec(migration('0004_group_leadership.sql'));db.exec(migration('0005_ceo_owner.sql'));db.exec(migration('0006_rank_permissions.sql'));
  const saved=db.prepare("SELECT * FROM staff_rank_permissions WHERE rank_id='group-cfo'").get();
  assert.equal(saved.manage_announcements,1);assert.equal(saved.manage_resources,0);
  assert.equal(db.prepare("SELECT rank_id FROM staff_rank_permissions WHERE rank_id='manager'").get(),undefined);
  assert.equal(db.prepare("SELECT password_hash FROM staff_users WHERE id='legacy'").get().password_hash,'original-hash');
});

test('a newly accepted deployment tolerates brief registration delay without hiding permission errors', async () => {
  let reads=0, waits=0;
  const result=await readNewDeployment(async()=>{reads++;if(reads<3)throw Object.assign(new Error('Not registered yet'),{status:404});return {latest_stage:{status:'success'}};},{pause:async()=>{waits++;}});
  assert.equal(result.latest_stage.status,'success');assert.equal(reads,3);assert.equal(waits,2);
  reads=0;waits=0;
  await assert.rejects(()=>readNewDeployment(async()=>{reads++;throw Object.assign(new Error('Forbidden'),{status:403});},{pause:async()=>{waits++;}}),/Forbidden/);
  assert.equal(reads,1);assert.equal(waits,0);
  reads=0;waits=0;
  await assert.rejects(()=>readNewDeployment(async()=>{reads++;throw Object.assign(new Error('Missing'),{status:404});},{pause:async()=>{waits++;},attempts:3}),/Missing/);
  assert.equal(reads,3);assert.equal(waits,2);
});

test('Group CEO is the protected owner position and cannot be assigned or duplicated', async () => {
  const env={STAFF_DB:database(),STAFF_SETUP_KEY:'ceo-test-private-setup-key-at-least-32-characters'};
  const owner=client(env,'192.0.2.220'), staff=client(env,'192.0.2.221');
  const created=await owner('setup',{setupKey:env.STAFF_SETUP_KEY,email:'owner@example.test',name:'Owner',password:'test password'});
  assert.equal(created.body.user.rank,'Group Chief Executive Officer');
  assert.equal(created.body.user.management,true);
  assert.equal((await owner('me')).body.user.rank,'Group Chief Executive Officer');
  const directory=(await owner('directory')).body;
  assert.equal(directory.staff[0].rank,'Group Chief Executive Officer');
  assert.equal(directory.ranks.some(rank=>rank.id==='group-ceo'||rank.name==='Group Chief Executive Officer'),false);
  assert.equal(directory.ranks.length,9);
  for(const name of ['CEO','Group CEO','Chief Executive Officer','Group Chief Executive Officer','Chairman']) {
    assert.equal((await owner('rank',{name,management:true})).status,400);
  }
  assert.equal((await owner('rank',{id:'group-ceo',name:'Different owner title',management:false})).status,400);
  const invite=await owner('invite',{email:'worker@example.test',name:'Worker'});
  const token=new URLSearchParams(new URL(invite.body.link).hash.slice(1)).get('invite');
  const joined=await staff('accept-invite',{token,password:'staff password',role:'chairman',rank_id:'group-ceo'});
  assert.equal(joined.body.user.management,false);
  assert.equal((await owner('staff-profile',{id:joined.body.user.id,rank_id:'group-ceo'})).status,400);
  assert.equal((await staff('staff')).status,403);
  assert.equal((await owner('staff-access',{id:created.body.user.id,active:false})).status,400);
  assert.equal((await owner('staff-profile',{id:created.body.user.id,rank_id:'staff'})).status,404);
  assert.equal((await owner('me')).body.user.management,true);
  for(const path of ['../staff/index.html','../index.html']) {
    assert.doesNotMatch(readFileSync(new URL(path,import.meta.url),'utf8'),/\bchairman\b/i,'no former owner title in website markup');
  }
});

test('CEO migration preserves the existing owner, credentials, sessions and other staff', () => {
  const db=new DatabaseSync(':memory:');
  const migration=file=>readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8');
  db.exec(migration('0001_staff.sql'));db.exec(migration('0002_management.sql'));
  db.exec("INSERT INTO staff_users(id,email,name,password_hash,salt,role,created_at) VALUES ('owner','owner@example.test','Owner','original-hash','original-salt','chairman',1),('worker','worker@example.test','Worker','staff-hash','staff-salt','staff',1)");
  db.exec("INSERT INTO staff_profiles(user_id,rank_id,department) VALUES ('owner','manager','Existing Department')");
  db.exec("INSERT INTO staff_sessions(token_hash,user_id,expires_at) VALUES ('existing-session-hash','owner',9999999999999)");
  db.exec(migration('0004_group_leadership.sql'));
  db.exec("INSERT INTO staff_profiles(user_id,rank_id,department) VALUES ('worker','group-coo','Operations')");
  db.exec(migration('0005_ceo_owner.sql'));db.exec(migration('0005_ceo_owner.sql'));
  const owner=db.prepare("SELECT * FROM staff_users WHERE id='owner'").get();
  assert.equal(owner.password_hash,'original-hash');assert.equal(owner.salt,'original-salt');
  const profile=db.prepare("SELECT * FROM staff_profiles WHERE user_id='owner'").get();
  assert.equal(profile.rank_id,'group-ceo');assert.equal(profile.department,'Existing Department');
  assert.equal(db.prepare("SELECT rank_id FROM staff_profiles WHERE user_id='worker'").get().rank_id,'group-coo');
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM staff_sessions WHERE user_id='owner'").get().total,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM staff_users').get().total,2);
});

test('private recovery links preserve accounts, reject replay and revoke old sessions', async () => {
  const db = database(), env = { STAFF_DB: db, STAFF_SETUP_KEY: 'recovery-test-setup-key-at-least-32-characters' };
  const chair = client(env, '192.0.2.201'), otherSession = client(env, '192.0.2.202'), recover = client(env, '192.0.2.203');
  const email = 'chairman@example.com', oldPassword = 'old test password';
  const created = await chair('setup', { setupKey: env.STAFF_SETUP_KEY, email, name: 'Chairman', password: oldPassword });
  const id = created.body.user.id;
  await otherSession('login', { email, password: oldPassword, remember: true });
  await chair('announcement', { title: 'Preserved update', body: 'Our group announcement must survive recovery.' });
  const token = 'a3'.repeat(32), hash = createHash('sha256').update(token).digest('hex');
  await db.prepare('INSERT INTO staff_password_resets(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').bind(hash, id, Date.now() + 60000, Date.now()).run();
  assert.equal((await recover('check-reset', { token: hash })).status, 410, 'the stored hash cannot be used as a credential');
  assert.equal((await recover('check-reset', { token: 'invalid' })).status, 410);
  const check = await recover('check-reset', { token });
  assert.equal(check.status, 200);
  assert.equal(check.cookie, null);
  assert.equal((await db.prepare('SELECT used_at FROM staff_password_resets WHERE user_id=?').bind(id).first()).used_at, null);
  assert.equal((await recover('reset-password', { token, password: 'short' })).status, 400);
  assert.equal((await recover('reset-password', { token, password: 'new test password' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await chair('me')).status, 200, 'checking a link or rejecting a password must not revoke the current session');
  const reset = await recover('reset-password', { token, password: 'new test password', user_id: 'ignored', role: 'staff' });
  assert.equal(reset.status, 200);
  assert.match(reset.cookie, /Max-Age=0/);
  assert.equal((await chair('me')).status, 401);
  assert.equal((await otherSession('me')).status, 401);
  assert.equal((await recover('reset-password', { token, password: 'another test password' })).status, 410);
  assert.equal((await recover('check-reset', { token })).status, 410);
  const login = client(env, '192.0.2.204');
  assert.equal((await login('login', { email, password: oldPassword })).status, 401);
  const signedIn = await login('login', { email, password: 'new test password' });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.user.id, id);
  assert.equal(signedIn.body.user.role, 'chairman');
  assert.equal((await login('dashboard')).body.announcements[0].title, 'Preserved update');
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM staff_activity WHERE action='Password recovered'").first()).total, 1);
});

test('recovery rejects expired and suspended accounts and consumes a token once under concurrent requests', async () => {
  const db = database(), env = { STAFF_DB: db, STAFF_SETUP_KEY: 'recovery-test-setup-key-at-least-32-characters' };
  const chair = client(env, '192.0.2.210'), recover = client(env, '192.0.2.211');
  const created = await chair('setup', { setupKey: env.STAFF_SETUP_KEY, email: 'chairman@example.com', name: 'Chairman', password: 'old password' });
  const id = created.body.user.id, token = 'b4'.repeat(32), hash = createHash('sha256').update(token).digest('hex');
  await db.prepare('INSERT INTO staff_password_resets(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').bind(hash, id, Date.now() - 1000, Date.now() - 2000).run();
  assert.equal((await recover('reset-password', { token, password: 'new password' })).status, 410);
  await db.prepare('UPDATE staff_password_resets SET expires_at=?').bind(Date.now() + 60000).run();
  await db.prepare('UPDATE staff_users SET active=0 WHERE id=?').bind(id).run();
  assert.equal((await recover('reset-password', { token, password: 'new password' })).status, 410);
  await db.prepare('UPDATE staff_users SET active=1 WHERE id=?').bind(id).run();
  const results = await Promise.all([
    recover('reset-password', { token, password: 'first new password' }),
    client(env, '192.0.2.212')('reset-password', { token, password: 'second new password' })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 410]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM staff_activity WHERE action='Password recovered'").first()).total, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM staff_sessions WHERE user_id=?').bind(id).first()).total, 0);
  const limited = client(env, '192.0.2.213');
  for (let i = 0; i < 15; i++) assert.equal((await limited('check-reset', { token: '0'.repeat(64) })).status, 410);
  assert.equal((await limited('check-reset', { token: '0'.repeat(64) })).status, 429);
});

test('hashed one-time setup keys cannot be used as bearer setup credentials', async () => {
  const key = 'private-test-setup-key-at-least-32-characters';
  const hash = createHash('sha256').update(key).digest('hex');
  const call = client({ STAFF_DB: database(), STAFF_SETUP_KEY_HASH: hash }, '192.0.2.15');
  const setup = { name: 'Chairman', email: 'chairman@example.com', password: 'six123' };
  assert.equal((await call('status')).body.setup, true);
  assert.equal((await call('setup', { ...setup, setupKey: hash })).status, 403);
  assert.equal((await call('setup', { ...setup, password: 'short', setupKey: key })).status, 400);
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
  assert.equal((await staff('accept-invite', { token: token(second.body.link), password: 'short' })).status, 400);
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
  assert.equal((await staff('password', { currentPassword: 'a strong staff password', password: 'short' })).status, 400);
  assert.equal((await staff('password', { currentPassword: 'wrong', password: 'new123' })).status, 403);
  assert.equal((await staff('password', { currentPassword: 'a strong staff password', password: 'new123' })).status, 200);
  assert.equal((await anotherSession('me')).status, 401);
  assert.equal((await staff('me')).status, 200);
  assert.equal((await chairman('staff-access', { id: registered.body.user.id, active: false })).status, 200);
  assert.equal((await staff('me')).status, 401);
  assert.equal((await staff('login', { email: 'staff@example.com', password: 'new123' })).status, 401);
  assert.equal((await chairman('staff-access', { id: registered.body.user.id, active: true })).status, 200);
  assert.equal((await staff('login', { email: 'staff@example.com', password: 'new123' })).status, 200);
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

test('ranks, delegated management, task privacy, audit history and live demotion', async () => {
  const env = { STAFF_DB: database(), STAFF_SETUP_KEY: 'test-only-private-setup-key-at-least-32-characters' };
  const chair = client(env,'192.0.2.40'), manager = client(env,'192.0.2.41'), staff = client(env,'192.0.2.42'), other=client(env,'192.0.2.43');
  const owner=await chair('setup',{setupKey:env.STAFF_SETUP_KEY,name:'Owner',email:'owner@example.com',password:'six123'});
  async function join(call,email) {
    const invite=await chair('invite',{name:email.split('@')[0],email});
    const token=new URLSearchParams(new URL(invite.body.link).hash.slice(1)).get('invite');
    return (await call('accept-invite',{token,password:'six123',rank_id:'director',management:true})).body.user;
  }
  const boss=await join(manager,'manager@example.com'), worker=await join(staff,'staff@example.com'), colleague=await join(other,'other@example.com');
  assert.equal(boss.management,false);
  assert.equal((await staff('rank',{name:'Bad rank',management:true})).status,403);
  assert.equal((await staff('directory')).status,403);
  assert.equal((await chair('staff-profile',{id:owner.body.user.id,rank_id:'trainee'})).status,404);
  assert.equal((await chair('staff-profile',{id:boss.id,rank_id:'missing'})).status,404);
  assert.equal((await chair('staff-profile',{id:boss.id,rank_id:'group-coo',department:'Operations'})).status,200);
  assert.equal((await manager('me')).body.user.management,true);
  assert.equal((await manager('me')).body.user.department,'Operations');
  assert.equal((await manager('directory')).body.staff.length,4);
  for(const action of ['staff','activity'])assert.equal((await manager(action)).status,403);
  for(const [action,data] of [['invite',{email:'x@example.com',name:'Someone'}],['staff-access',{id:worker.id,active:false}],['staff-profile',{id:worker.id,rank_id:'director'}],['rank',{name:'New Boss',management:true}],['revoke-invite',{email:'x@example.com'}]])assert.equal((await manager(action,data)).status,403);
  assert.equal((await manager('announcement',{title:'Management update',body:'A test update for staff.'})).status,201);
  assert.equal((await manager('resource',{title:'Handbook',url:'https://example.com/handbook'})).status,201);
  const task={title:'Prepare group update',description:'Review the next group announcement.',assignee_id:worker.id,priority:'high',due_date:'2026-11-10'};
  assert.equal((await staff('task',task)).status,403);
  assert.equal((await manager('task',{...task,due_date:'2026-02-30'})).status,400);
  assert.equal((await manager('task',{...task,assignee_id:'missing'})).status,400);
  assert.equal((await manager('task',task)).status,201);
  const assigned=(await staff('dashboard')).body.tasks;
  assert.equal(assigned.length,1);assert.equal(assigned[0].title,task.title);
  assert.equal((await other('dashboard')).body.tasks.length,0);
  assert.equal((await other('task-status',{id:assigned[0].id,status:'done'})).status,403);
  assert.equal((await staff('task-status',{id:assigned[0].id,status:'bad'})).status,400);
  assert.equal((await staff('task-status',{id:assigned[0].id,status:'in_progress'})).status,200);
  assert.equal((await manager('dashboard')).body.tasks[0].status,'in_progress');
  assert.equal((await chair('rank',{name:'Development Lead',management:false})).status,200);
  assert.equal((await chair('rank',{name:'Development Lead',management:false})).status,409);
  assert.equal((await chair('rank',{name:'Chairman',management:true})).status,400);
  assert.equal((await chair('rank',{id:'staff',name:'Holdings Staff',management:true})).status,400);
  const lead=(await chair('directory')).body.ranks.find(r=>r.name==='Development Lead');
  assert.equal((await chair('staff-profile',{id:worker.id,rank_id:lead.id,department:'Digital'})).status,200);
  assert.equal((await staff('me')).body.user.rank,'Development Lead');
  assert.equal((await chair('rank',{id:lead.id,name:'Digital Lead',management:true})).status,200);
  assert.equal((await staff('me')).body.user.management,true);
  assert.equal((await chair('rank',{id:lead.id,name:'Digital Lead',management:false})).status,200);
  assert.equal((await staff('directory')).status,403);
  assert.equal((await chair('staff-profile',{id:boss.id,rank_id:'staff'})).status,200);
  assert.equal((await manager('announcement',{title:'Blocked now',body:'Should not be published.'})).status,403);
  const invitation=await chair('invite',{name:'Revoke Test',email:'revoke@example.com'});
  assert.equal((await chair('revoke-invite',{email:'revoke@example.com'})).status,200);
  const token=new URLSearchParams(new URL(invitation.body.link).hash.slice(1)).get('invite');
  assert.equal((await other('accept-invite',{token,password:'six123'})).status,410);
  const log=(await chair('activity')).body.activity;
  assert(log.some(a=>a.action==='Rank updated'));
  assert(log.some(a=>a.action==='Task assigned'));
  assert(log.some(a=>a.action==='Invitation revoked'));
  assert(log.every(a=>!JSON.stringify(a).includes(token)));
  assert.equal((await chair('staff-access',{id:colleague.id,active:false})).status,200);
  assert.equal((await other('me')).status,401);
});

test('group leadership migration preserves people, assigned legacy ranks and custom permissions', () => {
 const db=new DatabaseSync(':memory:');
 const migration = file => readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8');
 db.exec(migration('0001_staff.sql'));
 db.exec(migration('0002_management.sql'));
 db.exec("INSERT INTO staff_users(id,email,name,password_hash,salt,role,created_at) VALUES ('existing-manager','manager@example.test','Existing manager','hash','salt','staff',1),('existing-staff','staff@example.test','Existing staff','hash','salt','staff',1)");
 db.exec("INSERT INTO staff_profiles(user_id,rank_id,department) VALUES ('existing-manager','manager','Operations'),('existing-staff','staff','Support')");
 db.exec("INSERT INTO staff_ranks(id,name,management,sort_order) VALUES ('custom','Custom Position',0,500)");
 db.exec("UPDATE staff_ranks SET name='Academy' WHERE id='trainee'");
 const sql=migration('0004_group_leadership.sql');db.exec(sql);
 const leadership=db.prepare('SELECT name FROM staff_ranks WHERE sort_order<100 AND id LIKE ? ORDER BY sort_order').all('group-%').map(r=>r.name);
 assert.deepEqual(leadership,['Group Chief Executive Officer','Group Chief Financial Officer','Group Chief Operating Officer','Group Chief Technology Officer','Group Chief Strategy Officer','Group Chief Corporate Services Officer','Group Company Secretary']);
 assert.equal(db.prepare("SELECT name FROM staff_ranks WHERE id='deputy-company-secretary'").get().name,'Deputy Company Secretary');
 assert.equal(db.prepare("SELECT name FROM staff_ranks WHERE id='managing-director'").get().name,'Managing Director');
 assert.equal(db.prepare("SELECT rank_id FROM staff_profiles WHERE user_id='existing-manager'").get().rank_id,'manager');
 assert.equal(db.prepare("SELECT management FROM staff_ranks WHERE id='manager'").get().management,1);
 assert.equal(db.prepare("SELECT rank_id FROM staff_profiles WHERE user_id='existing-staff'").get().rank_id,'staff');
 assert.equal(db.prepare("SELECT management FROM staff_ranks WHERE id='staff'").get().management,0);
 assert.equal(db.prepare("SELECT name FROM staff_ranks WHERE id='trainee'").get().name,'Academy');
 assert.equal(db.prepare("SELECT name FROM staff_ranks WHERE id='custom'").get().name,'Custom Position');
 assert.equal(db.prepare("SELECT id FROM staff_ranks WHERE id='director'").get(),undefined);
 assert.equal(db.prepare("SELECT id FROM staff_ranks WHERE id='supervisor'").get(),undefined);
 db.exec("UPDATE staff_ranks SET management=0,name='Custom executive title' WHERE id='group-ceo'");
 db.exec(migration('0002_management.sql'));db.exec(sql);db.exec(sql);
 assert.equal(db.prepare("SELECT management FROM staff_ranks WHERE id='group-ceo'").get().management,0);
 assert.equal(db.prepare("SELECT name FROM staff_ranks WHERE id='group-ceo'").get().name,'Custom executive title');
 assert.equal(db.prepare("SELECT id FROM staff_ranks WHERE id='director'").get(),undefined);
 assert.equal(db.prepare('SELECT COUNT(*) AS total FROM staff_users').get().total,2);
 assert.equal(db.prepare("SELECT password_hash FROM staff_users WHERE id='existing-manager'").get().password_hash,'hash');
});

test('management migration is additive and safe to re-run', () => {
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_staff.sql',import.meta.url),'utf8'));
 db.exec("INSERT INTO staff_users VALUES ('existing','existing@example.com','Existing','hash','salt','staff',1,0)");
 const sql=readFileSync(new URL('../migrations/0002_management.sql',import.meta.url),'utf8');db.exec(sql);db.exec(sql);
 assert.equal(db.prepare('SELECT count(*) AS n FROM staff_ranks').get().n,5);
 assert.equal(db.prepare('SELECT password_hash FROM staff_users').get().password_hash,'hash');
});

