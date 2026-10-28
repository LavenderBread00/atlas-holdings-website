import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createGateway } from '../api/staff/[...path].js';
import { onRequest } from '../functions/api/staff/[[path]].js';

function database() {
  const sqlite=new DatabaseSync(':memory:');
  for(const file of ['0001_staff.sql','0002_management.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const statement=(sql,args=[])=>({bind:(...values)=>statement(sql,values),first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>sqlite.prepare(sql).run(...args),execute:()=>sqlite.prepare(sql).run(...args)});
  return {prepare:sql=>statement(sql),batch:async statements=>{sqlite.exec('BEGIN');try{const result=statements.map(s=>s.execute());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
}
function client(gateway) {
  let cookie='';
  return async(action,body,extra={})=>{
    const headers={host:'atlasholdings.vercel.app','user-agent':'Browser test',cookie,...(body===undefined?{}:{origin:'https://atlasholdings.vercel.app','content-type':'application/json'}),...extra};
    const output={headers:{},setHeader(name,value){this.headers[name.toLowerCase()]=value;},end(text){this.body=JSON.parse(text);}};
    await gateway({url:'/api/staff/'+action,method:body===undefined?'GET':'POST',headers,body},output);
    if(output.headers['set-cookie'])cookie=output.headers['set-cookie'].split(';')[0];
    return output;
  };
}
test('temporary address preserves real accounts, sessions, ranks and invitation links',async()=>{
 const env={STAFF_DB:database(),STAFF_SETUP_KEY:'a-private-test-setup-key-for-this-test-only'};
 const gateway=createGateway({environment:{VERCEL_PROJECT_PRODUCTION_URL:'atlasholdings.vercel.app'},fetcher:async(url,options)=>onRequest({request:new Request(url,options),env})});
 const owner=client(gateway),staff=client(gateway);
 assert.equal((await owner('status')).body.ready,true);
 assert.equal((await owner('setup',{setupKey:env.STAFF_SETUP_KEY,name:'Test Owner',email:'owner@example.com',password:'six123'})).statusCode,201);
 assert.equal((await owner('me')).body.user.role,'chairman');
 assert.equal((await owner('invite',{name:'Test Staff',email:'staff@example.com'},{origin:'https://untrusted.example'})).statusCode,403);
 const invite=await owner('invite',{name:'Test Staff',email:'staff@example.com'});
 assert.equal(new URL(invite.body.link).origin,'https://atlasholdings.vercel.app');
 const token=new URLSearchParams(new URL(invite.body.link).hash.slice(1)).get('invite');
 const joined=await staff('accept-invite',{token,password:'six123'});
 assert.equal(joined.statusCode,201);assert.match(joined.headers['set-cookie'],/HttpOnly; Secure; SameSite=Strict/);
 assert.equal((await staff('me')).body.user.rank,'Holdings Staff');
 assert.equal((await owner('directory')).body.staff.length,2);
 assert.equal((await staff('directory')).statusCode,403);
 assert.equal((await staff('logout',{})).body.ok,true);
 assert.equal((await staff('me')).statusCode,401);
});
test('gateway is fixed to staff API and never forwards unrelated cookies or arbitrary origins',async()=>{
 let observed,calls=0;
 const gateway=createGateway({environment:{VERCEL_PROJECT_PRODUCTION_URL:'atlasholdings.vercel.app'},fetcher:async(url,options)=>{observed={url,options};calls++;return new Response('{}',{headers:{'Content-Type':'application/json'}});}});
 const call=client(gateway);
 assert.equal((await call('https://attacker.example')).statusCode,404);
 assert.equal((await call('login',{}, {host:'spoof.example'})).statusCode,403);
 assert.equal((await call('login',{}, {origin:'https://spoof.example'})).statusCode,403);
 assert.equal(calls,0);
 const session='a'.repeat(64);
 await call('me',undefined,{cookie:'private_other=secret; __Host-altas_staff='+session+'; analytics=x'});
 assert.equal(observed.url,'https://atlas-holdings-website.pages.dev/api/staff/me');
 assert.equal(observed.options.headers.Cookie,'__Host-altas_staff='+session);
 assert.equal(observed.options.redirect,'manual');
 assert.equal((await call('login','x'.repeat(20001))).statusCode,413);
});
test('gateway fails closed on missing configuration and non-JSON or unavailable upstream',async()=>{
 assert.equal((await client(createGateway({environment:{}}))('status')).statusCode,503);
 for(const fetcher of [async()=>new Response('<h1>Unavailable</h1>'),async()=>{throw new Error('Private infrastructure error');}]) {
  const result=await client(createGateway({environment:{VERCEL_PROJECT_PRODUCTION_URL:'atlasholdings.vercel.app'},fetcher}))('status');
  assert.equal(result.statusCode,503);assert.equal(result.headers['cache-control'],'private, no-store');
  assert(!JSON.stringify(result.body).includes('Private infrastructure'));
 }
});
