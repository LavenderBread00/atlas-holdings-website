const origin='https://atlas-holdings-website.pages.dev';
const callback=origin+'/api/staff/email-reset/verify';
const cookieName='__Host-altas_email_reset';
const enc=new TextEncoder();
const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
const digest=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const cookie=value=>`${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value?900:0}`;
export const emailRecoveryConfigured=env=>/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.STAFF_EMAIL_TEAM_DOMAIN||'')&&/^[a-zA-Z0-9_-]{16,128}$/.test(env.STAFF_EMAIL_AUD||'');
let keysCache;
const decode=s=>{if(typeof s!=='string'||!/^[\w-]+$/.test(s))throw Error();return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));};
export async function verifyEmailIdentity(token,env){
 try{
  if(!emailRecoveryConfigured(env)||typeof token!=='string'||token.length>16000)throw Error();
  const parts=token.split('.');if(parts.length!==3)throw Error();
  const header=JSON.parse(new TextDecoder().decode(decode(parts[0]))),claims=JSON.parse(new TextDecoder().decode(decode(parts[1]))),now=Math.floor(Date.now()/1000);
  if(header.alg!=='RS256'||typeof header.kid!=='string'||claims.iss!=='https://'+env.STAFF_EMAIL_TEAM_DOMAIN||!Array.isArray(claims.aud)||!claims.aud.includes(env.STAFF_EMAIL_AUD)||!Number.isFinite(claims.exp)||claims.exp<=now||claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf>now+5)||typeof claims.sub!=='string'||!claims.sub||claims.type!=='app'||typeof claims.email!=='string'||claims.email.length>254||!/^\S+@\S+\.\S+$/.test(claims.email))throw Error();
  if(!keysCache||keysCache.domain!==env.STAFF_EMAIL_TEAM_DOMAIN||keysCache.until<=Date.now()||!keysCache.keys.some(k=>k.kid===header.kid)){
   const res=await fetch('https://'+env.STAFF_EMAIL_TEAM_DOMAIN+'/cdn-cgi/access/certs',{redirect:'error',signal:AbortSignal.timeout(10000)});if(!res.ok)throw Error();
   const data=await res.json();if(!Array.isArray(data.keys))throw Error();
   keysCache={domain:env.STAFF_EMAIL_TEAM_DOMAIN,keys:data.keys,until:Date.now()+300000};
  }
  const jwk=keysCache.keys.find(k=>k.kid===header.kid);if(!jwk||jwk.kty!=='RSA')throw Error();
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(parts[2]),enc.encode(parts[0]+'.'+parts[1])))throw Error();
  return claims;
 }catch{fail('Email ownership verification is required.',401);}
}
const redirect=(fragment,clear=false)=>new Response(null,{status:303,headers:{location:origin+'/staff/#'+fragment,'cache-control':'no-store','referrer-policy':'no-referrer',...(clear?{'set-cookie':cookie('')}:{})}});
export async function staffEmailRecovery({request,env,query,rate,body,now,response}){
 if(!emailRecoveryConfigured(env))fail('Email password reset is awaiting activation. Your account manager can still provide a private recovery link.',503);
 const url=new URL(request.url);
 if(request.method==='POST'){
  if(body.website!=='')fail('Please check the reset form.');
  const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
  if(email.length>254||!/^([^\s@]{1,64})@([^\s@]+\.[^\s@]+)$/.test(email))fail('Enter a valid staff email address.');
  await rate('email-reset-ip',20,15);
  const key=await digest('email-reset-global:'+email);
  const limited=await query('INSERT INTO staff_rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count',key,now+900000,now,now).first();
  if(limited.count>5)fail('Too many attempts. Please try again later.',429);
  const state=random(),browser=random(),hash='email:'+await digest(state+'.'+browser);
  const user=await query('SELECT id FROM staff_users WHERE email=? AND active=1',email).first();
  // Pending email proofs use a non-hex namespace: legacy reset routes cannot consume them.
  if(user)await query('INSERT INTO staff_password_resets(token_hash,user_id,expires_at,used_at,created_at) VALUES (?,?,?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,used_at=NULL,created_at=excluded.created_at',hash,user.id,now+900000,now).run();
  return response({verificationUrl:callback+'?state='+state},200,{'Set-Cookie':cookie(browser)});
 }
 try{
  if(url.origin!==origin)throw Error();
  await rate('email-reset-callback',20,15);
  const state=url.searchParams.get('state'),cookies=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));
  const browser=cookies.length===1?cookies[0].slice(cookieName.length+1):'';
  if(!/^[a-f0-9]{64}$/.test(state||'')||!/^[a-f0-9]{64}$/.test(browser))throw Error();
  const claims=await verifyEmailIdentity(request.headers.get('Cf-Access-Jwt-Assertion'),env);
  const pending='email:'+await digest(state+'.'+browser);
  const reset=await query('SELECT r.user_id FROM staff_password_resets r JOIN staff_users u ON u.id=r.user_id WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND u.active=1 AND u.email=?',pending,now,claims.email.trim().toLowerCase()).first();
  if(!reset)throw Error();
  const token=random();
  const updated=await query('UPDATE staff_password_resets SET token_hash=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM staff_users u WHERE u.id=staff_password_resets.user_id AND u.active=1 AND u.email=?)',await digest(token),pending,now,claims.email.trim().toLowerCase()).run();
  if(Number(updated.meta?.changes??updated.changes)!==1)throw Error();
  return redirect('reset='+token,true);
 }catch{return redirect('recovery-error=1',true);}
}
