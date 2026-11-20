import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

const migration=(await readFile(new URL('../drizzle/0000_lazy_black_widow.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean);
const result=await build({
  stdin:{contents:`import * as auth from './lib/server/auth'; import {env} from 'cloudflare:workers';
    let initialized;
    export default {async fetch(request){
      initialized??=(async()=>{for(const sql of ${JSON.stringify(migration)}) await env.DB.prepare(sql).run();})();
      await initialized;
      const {action,args=[],identity=null,cookies={}}=await request.json();
      globalThis.__workerAuthTest={identity,cookies};
      try{return Response.json({result:await auth[action](...args)});}catch(error){return Response.json({error:error.message},{status:400});}
    }};`,resolveDir:process.cwd(),loader:'js'},
  bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],
  plugins:[{name:'only-platform-identity-is-simulated',setup(b){
    b.onResolve({filter:/^(next\/headers|@\/app\/chatgpt-auth|@simplewebauthn\/server)$/},args=>({path:args.path,namespace:'test'}));
    b.onLoad({filter:/.*/,namespace:'test'},args=>({contents:{
      'next/headers':'export async function cookies(){return {get(name){const v=globalThis.__workerAuthTest.cookies[name];return v?{value:v}:undefined;}};}',
      '@/app/chatgpt-auth':'export async function getChatGPTUser(){return globalThis.__workerAuthTest.identity;}',
      '@simplewebauthn/server':'export const generateAuthenticationOptions=()=>{}; export const generateRegistrationOptions=()=>{}; export const verifyAuthenticationResponse=()=>{}; export const verifyRegistrationResponse=()=>{};',
    }[args.path]}));
  }}],
});
const password='Worker-test-password-long-38';
const token=result=>result.session.cookie.split(';')[0].split('=')[1];
const native=n=>({id:`native-${n}`,email:`profile-${n}@example.test`,displayName:`test-${n}`,fullName:null});

test('Real Workers WebCrypto + D1: new binding, both first-login orders, both merge directions and recovery', {timeout:60000}, async()=>{
  const mf=new Miniflare({modules:true,script:result.outputFiles[0].text,compatibilityDate:'2026-05-15',d1Databases:['DB']});
  async function call(action,args=[],identity=null,cookies={}) {
    const r=await mf.dispatchFetch('http://auth-test.local',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,args,identity,cookies})});
    const data=await r.json();if(!r.ok) throw new Error(data.error);return data.result;
  }
  try{
    const first=await call('getAppUser',[],native(1));
    assert.equal((await call('authMethods',[],native(1))).hasPassword,false);
    await call('linkEmailCredentials',['worker-one@example.test',password],native(1));
    assert.equal((await call('loginEmail',['worker-one@example.test',password])).user.id,first.id);

    const emailFirst=await call('registerEmail',['worker-two@example.test',password]);
    const secondCookies={chathub_session:token(emailFirst)};
    const start=await call('beginChatGPTLink',[],native(2),secondCookies);
    secondCookies.chathub_link_intent=start.cookie.split(';')[0].split('=')[1];
    assert.equal((await call('linkChatGPTIdentity',[],native(2),secondCookies)).linked,true);
    assert.equal((await call('getAppUser',[],native(2))).id,emailFirst.user.id);

    await call('getAppUser',[],native(3));
    const third=await call('registerEmail',['worker-three@example.test',password]);
    const p3=await call('prepareAccountMerge',['worker-three@example.test',password],native(3));
    await call('confirmAccountMerge',[p3.token],native(3));
    assert.equal((await call('getAppUser',[],native(3))).id,third.user.id);
    await assert.rejects(call('confirmAccountMerge',[p3.token],native(3)),/CHALLENGE_EXPIRED/);

    await call('getAppUser',[],native(4));
    const fourth=await call('registerEmail',['worker-four@example.test',password]);
    const fourthCookies={chathub_session:token(fourth)};
    const begin4=await call('beginChatGPTLink',[],native(4),fourthCookies);
    fourthCookies.chathub_link_intent=begin4.cookie.split(';')[0].split('=')[1];
    const callback4=await call('linkChatGPTIdentity',[],native(4),fourthCookies);
    assert.equal(callback4.mergeRequired,true);
    const p4=await call('prepareAccountMerge',['worker-four@example.test',password,callback4.proofId],native(4),fourthCookies);
    const merged=await call('confirmAccountMerge',[p4.token],native(4),fourthCookies);
    const methods=await call('authMethods',[],null,{chathub_session:token(merged)});
    assert.equal(methods.email,'worker-four@example.test');assert.equal(methods.chatgptLinked,true);
    assert.equal((await call('getAppUser',[],native(4))).id,fourth.user.id);
    const next='New-worker-test-password-99';
    const recovered=await call('recoverEmailPassword',['worker-four@example.test',fourth.recoveryCodes[0],next]);
    assert.equal(recovered.recoveryCodes.length,8);
    assert.equal((await call('loginEmail',['worker-four@example.test',next])).user.id,fourth.user.id);
    await assert.rejects(call('recoverEmailPassword',['worker-four@example.test',fourth.recoveryCodes[1],password]),/INVALID_RECOVERY/);
  }finally{await mf.dispose();}
});
