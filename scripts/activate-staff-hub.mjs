import { readFile } from 'node:fs/promises';

const account = 'a9037651b7dade97f03a1d9f6b0eeb4a';
const projectName = 'atlas-holdings-website';
const databaseName = 'altas-holdings-staff';
const token = process.env.CLOUDFLARE_API_TOKEN;
const setupHash = process.env.STAFF_SETUP_KEY_HASH;
if (!token) throw new Error('Save CLOUDFLARE_API_TOKEN as an Actions repository secret in atlas-holdings-website.');
if (!/^[a-f0-9]{64}$/.test(setupHash || '')) throw new Error('Missing setup-key hash.');
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
async function api(path, method = 'GET', data) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const body = await res.json();
  if (!res.ok || body.success === false) {
    const codes = (body.errors || []).map(e => e.code).join(', ');
    throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (HTTP ${res.status}; codes ${codes || 'none'}). Check token account scope, Pages Write and D1 Write permissions.`);
  }
  return body.result;
}
async function query(id, sql, params = []) {
  const result = await api(`/d1/database/${id}/query`, 'POST', { sql, params });
  if (!Array.isArray(result) || result.some(item => item.success === false)) throw new Error('Database query failed.');
  return result;
}
const projectPath = `/pages/projects/${projectName}`;
let project = await api(projectPath);
console.log('Cloudflare token accepted for the Altaş Pages project.');
let db;
for (let page = 1; page <= 100; page++) {
  const list = await api(`/d1/database?per_page=100&page=${page}`);
  db = list.find(item => item.name === databaseName);
  if (db || list.length < 100) break;
}
if (!db) db = await api('/d1/database', 'POST', { name: databaseName });
const id = db.uuid;
if (!id) throw new Error('Cloudflare did not return a database ID.');
const current = project.deployment_configs?.production || {};
if (current.d1_databases?.STAFF_DB && current.d1_databases.STAFF_DB.id !== id) throw new Error('STAFF_DB already points to another database; refusing to replace it.');
await query(id, await readFile('migrations/0001_staff.sql', 'utf8'));
await query(id, await readFile('migrations/0002_management.sql', 'utf8'));
await query(id, await readFile('migrations/0003_recovery.sql', 'utf8'));
await query(id, await readFile('migrations/0004_group_leadership.sql', 'utf8'));
const managementSchema = await query(id, "SELECT COUNT(*) AS total FROM staff_ranks");
if (Number(managementSchema[0]?.results?.[0]?.total) < 10) throw new Error('Group leadership rank verification failed.');
const rankCatalog = await query(id, 'SELECT name FROM staff_ranks ORDER BY sort_order,name');
console.log('Verified group rank catalog: ' + rankCatalog[0].results.map(rank => rank.name).join('; '));
console.log('Altaş staff database created or verified; schema applied.');
const rows = await query(id, "SELECT COUNT(*) AS total FROM staff_users WHERE role='chairman'");
const chairmanExists = Number(rows[0]?.results?.[0]?.total) > 0;
const production = { d1_databases: { ...(current.d1_databases || {}), STAFF_DB: { id } } };
if (!chairmanExists) production.env_vars = { STAFF_SETUP_KEY_HASH: { type: 'secret_text', value: setupHash } };
await api(projectPath, 'PATCH', { deployment_configs: { production } });
project = await api(projectPath);
if (project.deployment_configs?.production?.d1_databases?.STAFF_DB?.id !== id) throw new Error('Could not verify the production database binding.');
console.log('Production STAFF_DB binding verified. ' + (chairmanExists ? 'Existing chairman account preserved.' : 'Private chairman setup is enabled.'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let sourceDeployment;
for (let attempt = 0; attempt < 36; attempt++) {
  const deployments = await api(`${projectPath}/deployments?per_page=20`);
  sourceDeployment = deployments.find(d => d.environment === 'production' && d.deployment_trigger?.metadata?.commit_hash === process.env.GITHUB_SHA);
  if (sourceDeployment && ['success', 'failure', 'canceled'].includes(sourceDeployment.latest_stage?.status)) break;
  if (attempt === 35) throw new Error('Timed out waiting for this commit to finish its Git-connected Pages build.');
  await pause(5000);
}
const deployment = await api(`${projectPath}/deployments/${sourceDeployment.id}/retry`, 'POST');
console.log(`Started production deployment ${deployment.id} with the staff database binding.`);
for (let attempt = 0; attempt < 60; attempt++) {
  const deployed = await api(`${projectPath}/deployments/${deployment.id}`);
  const state = deployed.latest_stage?.status;
  if (state === 'success') {
    const res = await fetch('https://atlas-holdings-website.pages.dev/api/staff/status', { cache: 'no-store' });
    const status = await res.json();
    if (!res.ok || status.ready !== true) throw new Error('Deployment completed, but the staff service readiness check failed.');
    if (!chairmanExists && status.setup !== true) throw new Error('Database is ready, but chairman setup is not enabled.');
    console.log('VERIFIED: production staff hub is connected and ready.');
    console.log('Staff Hub: https://atlas-holdings-website.pages.dev/staff/');
    process.exit(0);
  }
  if (['failure', 'canceled'].includes(state)) throw new Error('Cloudflare deployment did not succeed. Check Pages build logs.');
  await pause(5000);
}
throw new Error('Deployment is still pending. Check the Cloudflare Pages deployment status.');

