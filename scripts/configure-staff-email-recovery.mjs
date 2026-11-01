// A separate email proof app; existing staff policies and account data stay intact.
import {readNewDeployment} from './deployment-status.mjs';
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token)throw Error('Save CLOUDFLARE_API_TOKEN in this repository’s Actions secrets.');
const base='https://api.cloudflare.com/client/v4/accounts/a9037651b7dade97f03a1d9f6b0eeb4a';
async function api(path,method='GET',data){
 const res=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
 const body=await res.json();
 if(!res.ok||body.success===false)throw Object.assign(Error(`Cloudflare ${method} ${path.split('?')[0]} failed (HTTP ${res.status}; codes ${(body.errors||[]).map(e=>e.code).join(',')||'none'}). The token needs Pages Edit and Access Apps and Policies Edit, plus Identity Providers Read.`),{status:res.status});
 return body.result;
}
const projectPath='/pages/projects/atlas-holdings-website',origin='https://atlas-holdings-website.pages.dev';
const project=await api(projectPath);
if(project.production_branch!=='main'||project.source?.config?.owner!=='LavenderBread00'||project.source?.config?.repo_name!=='atlas-holdings-website'||!project.deployment_configs?.production?.d1_databases?.STAFF_DB?.id)throw Error('Altaş production repository or database binding did not verify.');
const production=project.deployment_configs.production,env=production.env_vars||{};
const reference=await api('/pages/projects/corendon-rblx'); // Read-only email provider reference.
const referenceEnv=reference.deployment_configs?.production?.env_vars||{};
const team=referenceEnv.ACCESS_TEAM_DOMAIN?.value;
if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team||''))throw Error('Existing email verification team domain is missing.');
const providers=await api('/access/identity_providers');
const apps=await api('/access/apps?per_page=100');
const staff=apps.find(a=>a.aud===referenceEnv.ACCESS_AUD?.value);
const pin=providers.find(p=>p.type==='onetimepin'&&staff?.allowed_idps?.includes(p.id));
if(!pin)throw Error('Existing email-code provider did not verify.');
const policies=await api('/access/policies?per_page=100');
const policyName='Altaş staff recovery - verified email',domain='atlas-holdings-website.pages.dev/api/staff/email-reset/*',name='Altaş staff email recovery';
const expected={name:policyName,decision:'allow',include:[{login_method:{id:pin.id}}],require:[],exclude:[],session_duration:'1h'};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let policy=policies.find(p=>p.name===policyName),app=apps.find(a=>a.domain===domain);
if(!policy)policy=await api('/access/policies','POST',expected);
for(const key of Object.keys(expected))if(!equal(policy[key]??[],expected[key]))throw Error('Existing recovery policy differs from the expected OTP-only policy; refusing to overwrite it.');
if(apps.some(a=>a.domain!==domain&&(a.policies||[]).some(p=>p.id===policy.id)))throw Error('Recovery policy must not be shared with another application.');
if(!app)app=await api('/access/apps','POST',{name,type:'self_hosted',domain,session_duration:'1h',allowed_idps:[pin.id],auto_redirect_to_identity:true,allow_authenticate_via_warp:false,app_launcher_visible:false,http_only_cookie_attribute:true,path_cookie_attribute:true,same_site_cookie_attribute:'lax',policies:[{id:policy.id,precedence:1}]});
const checked=await api('/access/apps/'+app.id);
if(checked.name!==name||checked.type!=='self_hosted'||checked.domain!==domain||checked.session_duration!=='1h'||!checked.aud||[referenceEnv.ACCESS_AUD?.value,referenceEnv.APPLICANT_EMAIL_AUD?.value].includes(checked.aud)||!equal(checked.allowed_idps,[pin.id])||checked.policies?.length!==1||checked.policies[0].id!==policy.id||checked.allow_authenticate_via_warp!==false||checked.http_only_cookie_attribute!==true||checked.path_cookie_attribute!==true)throw Error('Recovery application did not verify.');
const prior=await api('/access/apps/'+staff.id);
for(const key of ['aud','domain','allowed_idps','policies','session_duration'])if(!equal(prior[key],staff[key]))throw Error('Existing staff sign-in configuration changed unexpectedly.');
if(env.STAFF_EMAIL_AUD?.value!==checked.aud||env.STAFF_EMAIL_TEAM_DOMAIN?.value!==team){
 await api(projectPath,'PATCH',{deployment_configs:{production:{env_vars:{STAFF_EMAIL_AUD:{type:'plain_text',value:checked.aud},STAFF_EMAIL_TEAM_DOMAIN:{type:'plain_text',value:team}}}}});
 const after=(await api(projectPath)).deployment_configs.production;
 const stable=o=>JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
 const beforeVars={...env},afterVars={...after.env_vars};
 for(const key of ['STAFF_EMAIL_AUD','STAFF_EMAIL_TEAM_DOMAIN']){delete beforeVars[key];delete afterVars[key];}
 if(stable(beforeVars)!==stable(afterVars)||!equal(production.d1_databases,after.d1_databases))throw Error('An existing runtime setting changed unexpectedly.');
}
console.log('Verified separate Altaş email recovery application. Existing accounts, database and staff policies preserved.');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let source;
for(let attempt=0;attempt<60;attempt++){
 const deployments=await api(projectPath+'/deployments?per_page=20');
 source=deployments.find(d=>d.environment==='production'&&d.deployment_trigger?.metadata?.commit_hash===process.env.GITHUB_SHA);
 if(source&&['success','failure','canceled'].includes(source.latest_stage?.status))break;
 if(attempt===59)throw Error('Timed out waiting for the Git-connected source deployment.');
 await pause(5000);
}
const deployed=await api(`${projectPath}/deployments/${source.id}/retry`,'POST');
for(let attempt=0;attempt<60;attempt++){
 const result=await readNewDeployment(()=>api(`${projectPath}/deployments/${deployed.id}`),{pause,attempts:attempt===0?7:1});
 if(result.latest_stage?.status==='success'){
  const res=await fetch(origin+'/api/staff/status',{cache:'no-store'}),status=await res.json();
  if(!res.ok||status.ready!==true||status.emailRecovery!==true)throw Error('Production email recovery readiness check failed.');
  const gate=await fetch(origin+'/api/staff/email-reset/verify?state=invalid',{redirect:'manual'});
  if(![302,303,307].includes(gate.status)||new URL(gate.headers.get('location')||origin).hostname!==team)throw Error('Email callback is not protected by the expected verification gate.');
  console.log('VERIFIED: email recovery is active at '+origin+'/staff/');process.exit(0);
 }
 if(['failure','canceled'].includes(result.latest_stage?.status))throw Error('The recovery deployment failed. Check Pages build logs.');
 await pause(5000);
}
throw Error('Email recovery deployment is still pending. Check Cloudflare Pages.');
