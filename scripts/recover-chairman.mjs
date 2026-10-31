import { readFile } from 'node:fs/promises';

// Only a trusted repository administrator can run this workflow. The raw
// recovery token must remain private; this script receives only its SHA-256 hash.
if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Recovery must run from main.');
const now = Date.now();
let recovery;
if (process.env.GITHUB_EVENT_NAME === 'push') {
  try { recovery = JSON.parse(await readFile('.github/recovery/chairman.json', 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') { console.log('No pending recovery request.'); process.exit(0); } throw error; }
} else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
  recovery = { email: process.env.RECOVERY_EMAIL, token_hash: process.env.RECOVERY_TOKEN_HASH, created_at: now, expires_at: Number(process.env.RECOVERY_EXPIRES_AT) };
} else throw new Error('Unsupported recovery trigger.');
const { email, token_hash: tokenHash, created_at: createdAt, expires_at: expiresAt } = recovery;
if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('A valid account email is required.');
if (!/^[a-f0-9]{64}$/.test(tokenHash || '')) throw new Error('A SHA-256 recovery-token hash is required. Never provide the raw token.');
if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt) || createdAt > now + 60000 || expiresAt <= now || expiresAt <= createdAt || expiresAt - createdAt > 86400000) throw new Error('Recovery must expire within 24 hours of issuance.');
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not configured.');
const base = 'https://api.cloudflare.com/client/v4/accounts/a9037651b7dade97f03a1d9f6b0eeb4a';
async function api(path, method = 'GET', data) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const body = await res.json();
  if (!res.ok || body.success === false) throw new Error(`Cloudflare recovery request failed (HTTP ${res.status}). Check the repository secret's Pages and D1 permissions.`);
  return body.result;
}
const project = await api('/pages/projects/atlas-holdings-website');
const databaseId = project.deployment_configs?.production?.d1_databases?.STAFF_DB?.id;
if (!databaseId) throw new Error('The production STAFF_DB binding is missing.');
const database = await api(`/d1/database/${databaseId}`);
if (database.name !== 'altas-holdings-staff') throw new Error('Unexpected production database; refusing recovery.');
async function query(sql, params = []) {
  const result = await api(`/d1/database/${databaseId}/query`, 'POST', { sql, params });
  if (!Array.isArray(result) || result.some(item => item.success === false)) throw new Error('Recovery database query failed.');
  return result;
}
await query(await readFile('migrations/0003_recovery.sql', 'utf8'));
const owner = (await query("SELECT id FROM staff_users WHERE email=? AND role='chairman' AND active=1", [email.trim().toLowerCase()]))[0]?.results?.[0];
if (!owner) throw new Error('No active CEO account matches that email. No account was changed.');
await query('INSERT INTO staff_password_resets(token_hash,user_id,expires_at,used_at,created_at) VALUES (?,?,?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,used_at=NULL,created_at=excluded.created_at WHERE staff_password_resets.token_hash<>excluded.token_hash AND staff_password_resets.created_at<excluded.created_at', [tokenHash, owner.id, expiresAt, createdAt]);
const saved = (await query('SELECT expires_at,used_at FROM staff_password_resets WHERE token_hash=? AND user_id=?', [tokenHash, owner.id]))[0]?.results?.[0];
if (!saved || saved.used_at !== null || saved.expires_at <= now) throw new Error('This recovery request is expired, used or superseded. It has not been reactivated.');
await query('INSERT INTO staff_activity(id,actor_id,action,detail,created_at) VALUES (?,?,?,?,?)', [crypto.randomUUID(), owner.id, 'Recovery link issued', 'Private CEO recovery prepared through repository administration.', now]);
console.log('VERIFIED: one-use CEO recovery prepared. Existing password, staff records, permissions and sessions are unchanged until the owner submits a new password.');
console.log('Recovery expires at ' + new Date(expiresAt).toISOString() + '. The raw recovery token is not stored in GitHub or logs.');
