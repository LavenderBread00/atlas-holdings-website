// Temporary Vercel entrance to the existing Altaş service. No database or
// authentication credentials are copied into this deployment.
const upstreamOrigin = 'https://atlas-holdings-website.pages.dev';
const sessionName = '__Host-altas_staff';
const actions = new Set(['status','setup','login','accept-invite','me','logout','password','dashboard','staff','invite','staff-access','announcement','resource','delete-content','task-status','directory','activity','rank','staff-profile','revoke-invite','task']);

export function createGateway({ fetcher = fetch, environment = process.env } = {}) {
  return async function gateway(req, res) {
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.end(JSON.stringify(body));
    };
    try {
      if (!['GET','POST'].includes(req.method)) { res.setHeader('Allow','GET, POST'); return send(405,{error:'Method not allowed.'}); }
      const host = environment.STAFF_HUB_HOST || environment.VERCEL_PROJECT_PRODUCTION_URL;
      if (!host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return send(503,{error:'The temporary Staff Hub address is awaiting configuration.'});
      const origin = 'https://' + host;
      if (req.headers.host !== host) return send(403,{error:'Use the production Staff Hub address.'});
      if (req.method === 'POST' && req.headers.origin !== origin) return send(403,{error:'Please submit from the Altaş Staff Hub.'});
      // Only fixed staff actions are forwarded: this is never a general proxy.
      const match = /^\/api\/staff\/([a-z-]+)\/?(?:\?.*)?$/.exec(req.url || '');
      const action = match?.[1];
      if (!actions.has(action)) return send(404,{error:'Not found.'});
      const headers = { Accept:'application/json' };
      const userAgent = req.headers['user-agent'];
      if (typeof userAgent === 'string') headers['User-Agent'] = userAgent;
      const cookie = String(req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>new RegExp('^'+sessionName+'=[a-f0-9]{64}$').test(s));
      if (cookie) headers.Cookie = cookie;
      let body;
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return send(415,{error:'JSON required.'});
        body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
        if (body.length > 20000) return send(413,{error:'Request too large.'});
        headers['Content-Type'] = 'application/json';
        // The browser origin was checked above before adapting the request for
        // the upstream service's own same-origin check.
        headers.Origin = upstreamOrigin;
      }
      const upstream = await fetcher(upstreamOrigin+'/api/staff/'+action,{method:req.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(12000)});
      if (!upstream.headers.get('Content-Type')?.startsWith('application/json')) return send(503,{error:'The staff service could not be reached. Please try again.'});
      const result = await upstream.json();
      if (action === 'invite' && upstream.ok && typeof result.link === 'string') {
        const link = new URL(result.link);
        if (link.origin !== upstreamOrigin || link.pathname !== '/staff/') return send(503,{error:'The invitation could not be prepared.'});
        result.link = origin+'/staff/'+link.hash;
      }
      const setCookie = upstream.headers.get('Set-Cookie');
      if (setCookie?.startsWith(sessionName+'=') && !/;\s*Domain=/i.test(setCookie)) res.setHeader('Set-Cookie',setCookie);
      return send(upstream.status,result);
    } catch {
      return send(503,{error:'The staff service could not be reached. Please try again.'});
    }
  };
}
export default createGateway();
