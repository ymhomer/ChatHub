import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
const migration=(await readFile(new URL('../drizzle/0000_lazy_black_widow.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
const bundle=await build({stdin:{contents:`import * as organizer from './lib/server/organizer'; import * as chat from './lib/server/chat'; import * as parser from './lib/organizer'; import * as route from './app/api/organizer/route'; import {env} from 'cloudflare:workers';
let initialized;
export default {async fetch(request){
 initialized??=(async()=>{for(const s of ${JSON.stringify(migration)})await env.DB.prepare(s).run();})(); await initialized;
 if(new URL(request.url).pathname==='/route'){globalThis.testUser=request.headers.get('test-user')||'a';return route[request.method](request);}
 const {module='organizer',action,args=[],sql,params=[]}=await request.json();
 try{
 if(sql)return Response.json(await env.DB.prepare(sql).bind(...params).all());
 if(action==='bucket')return Response.json({exists:!!await env.BUCKET.get(args[0])});
 if(action==='upload'){args[1].file=new File(['synthetic content'],args[1].name,{type:args[1].mime});return Response.json({result:await chat.createMessage(...args)});}
 return Response.json({result:await ({organizer,chat,parser}[module])[action](...args)});
 }catch(e){return Response.json({error:e.message},{status:400});}
}};`,resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',external:['cloudflare:workers'],plugins:[{name:'synthetic-identity',setup(b){b.onResolve({filter:/^@\/lib\/server\/auth$/},()=>({path:'auth',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:`export async function requireAuthUser(){return {id:globalThis.testUser||'a',displayName:'Test',email:'test@example.test'};}`}));}}]});
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET']});
async function request(body){const r=await mf.dispatchFetch('http://organizer.test',{method:'POST',body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error);return Object.hasOwn(data,"result")?data.result:data;}
const call=(action,...args)=>request({action,args});
const sql=(sql,...params)=>request({sql,params});
const one=async(q,...args)=>(await sql(q,...args)).results[0];
let inbox,other;
test('Organizer on real Worker D1 + R2',async t=>{
 try{
 await sql(`INSERT INTO users(id,display_name) VALUES ('a','Alice'),('b','Bob')`);
 await sql(`INSERT INTO conversations(id,type,title,created_by,created_at) VALUES ('old-a','group','我的私人空間','a','2020-01-01'),('archive-a','group','Old work','a','2021-01-01')`);
 await sql(`INSERT INTO conversation_members(conversation_id,user_id,role) VALUES ('old-a','a','admin'),('archive-a','a','admin')`);
 await sql(`INSERT INTO messages(id,conversation_id,sender_id,body) VALUES ('legacy','old-a','a','Existing text remains')`);
 await t.test('adopts legacy private space without destroying existing data',async()=>{
  inbox=await call('defaultSpace','a');assert.equal(inbox,'old-a');assert.equal((await call('organizerMessages','a',inbox))[0].body,'Existing text remains');
  assert.equal((await call('organizerSpaces','a'))[0].title,'Inbox');other=await call('defaultSpace','b');assert.notEqual(other,inbox);
 });
 await t.test('aliases, invalid commands, literal text and mixed media classification',async()=>{
  for(const [alias,type] of [['pic','picture'],['picture','picture'],['web','url'],['url','url'],['video','video'],['file','file'],['all','all']])assert.deepEqual(await request({module:'parser',action:'parseCommand',args:[`/move ${alias}`]}),{action:'move',type});
  assert.deepEqual(await request({module:'parser',action:'parseCommand',args:['/search AA10 reader']}),{action:'search',query:'AA10 reader'});
  await assert.rejects(request({module:'parser',action:'parseCommand',args:['/clear now']}),/Unknown/);
  assert.equal(await request({module:'parser',action:'parseCommand',args:['ordinary note']}),null);
  assert.deepEqual(await request({module:'parser',action:'contentTypes',args:['image/png','https://example.test']}),['picture','url']);
 });
 let picture,video,file,link;
 await t.test('uploads videos, images and other files with captions and custom tags',async()=>{
  picture=await call('upload','a',{conversationId:inbox,body:'Image and https://example.test/photo',caption:'AA10 reader wiring',tags:['Work','EPM3'],name:'IMG_123.png',mime:'image/png'});
  video=await call('upload','a',{conversationId:inbox,body:'Demo',caption:'Reader video',tags:['work'],name:'clip.mp4',mime:'video/mp4'});
  file=await call('upload','a',{conversationId:inbox,body:'report',caption:'100% literal_file',tags:['work'],name:'report.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  link=await request({module:'chat',action:'createMessage',args:['a',{conversationId:inbox,body:'https://example.test',file:null}]});
  await assert.rejects(request({module:'chat',action:'createMessage',args:['a',{conversationId:'archive-a',body:'blocked',file:null}]}),/READ_ONLY/);
  const key=(await one('SELECT object_key FROM attachments WHERE id=?',picture.attachmentId)).object_key;assert.equal((await call('bucket',key)).exists,true);
 });
 await t.test('searches captions and tags across spaces, literal wildcard characters; never leaks other accounts',async()=>{
  assert.equal((await call('searchMessages','a','wiring')).messages[0].id,picture.id);
  assert.equal((await call('searchMessages','a','','picture','work')).messages.length,1);
  assert.equal((await call('searchMessages','a','100% literal_file')).messages[0].id,file.id);
  assert.equal((await call('searchMessages','b','wiring')).messages.length,0);
  await assert.rejects(call('updateAnnotation','b',picture.id,'stolen',[]),/no longer available/);
  await assert.rejects(call('organizerMessages','b',inbox),/FORBIDDEN/);
 });
 await t.test('/move all classifies atomically, preserves IDs, timestamps, metadata and original R2 paths',async()=>{
  const before=await one('SELECT created_at FROM messages WHERE id=?',picture.id);const path=await one('SELECT object_key FROM attachments WHERE id=?',picture.attachmentId);
  const preview=await call('previewCommand','a',inbox,'move','all');assert.equal(preview.count,4);assert.equal(preview.remaining,1);assert.deepEqual(preview.groups,{picture:1,video:1,file:1,url:1});
  await call('executeCommand','a',preview.token);await call('executeCommand','a',preview.token);
  const spaces=await call('organizerSpaces','a');assert.equal(spaces.find(s=>s.kind==='picture').count,1);
  const pic=await call('organizerMessages','a',spaces.find(s=>s.kind==='picture').id);assert.equal(pic[0].id,picture.id);assert.deepEqual(pic[0].tags,['work','epm3']);assert.deepEqual(pic[0].typeTags,['picture','url']);assert.equal(pic[0].caption,'AA10 reader wiring');
  assert.deepEqual(await one('SELECT created_at FROM messages WHERE id=?',picture.id),before);assert.deepEqual(await one('SELECT object_key FROM attachments WHERE id=?',picture.attachmentId),path);
  await assert.rejects(call('previewCommand','a',spaces.find(s=>s.kind==='picture').id,'clear','all'),/only work in Inbox/);
 });
 await t.test('metadata edits are searchable after move; stale confirmation rolls back safely',async()=>{
  await call('updateAnnotation','a',picture.id,'New caption',['Updated']);assert.equal((await call('searchMessages','a','New caption')).messages[0].id,picture.id);
  await request({module:'chat',action:'createMessage',args:['a',{conversationId:inbox,body:'https://another.test',file:null}]});
  const move=await call('previewCommand','a',inbox,'move','url');const clear=await call('previewCommand','a',inbox,'clear','all');await call('executeCommand','a',move.token);
  await assert.rejects(call('executeCommand','a',clear.token));assert.equal((await call('organizerMessages','a',inbox)).length,1);
 });
 await t.test('/clear affects only previewed Inbox items; new arrivals and other spaces survive; attachment bytes removed',async()=>{
  const pendingFile=await call('upload','a',{conversationId:inbox,body:'delete me',caption:'old',tags:[],name:'temp.txt',mime:'text/plain'});
  const key=(await one('SELECT object_key FROM attachments WHERE id=?',pendingFile.attachmentId)).object_key;
  const preview=await call('previewCommand','a',inbox,'clear','all');assert.equal(preview.count,2);
  await request({module:'chat',action:'createMessage',args:['a',{conversationId:inbox,body:'new phone arrival',file:null}]});
  await assert.rejects(call('executeCommand','b',preview.token),/invalid/);
  await call('executeCommand','a',preview.token);
  const remaining=await call('organizerMessages','a',inbox);assert.equal(remaining.length,1);assert.equal(remaining[0].body,'new phone arrival');
  assert.equal((await call('bucket',key)).exists,false);
  assert.equal((await call('searchMessages','a','New caption')).messages.length,1);
  assert.equal((await call('searchMessages','a','delete me')).messages.length,0);
  assert.equal((await one('SELECT COUNT(*) n FROM message_annotations WHERE message_id=?',pendingFile.id)).n,0);
 });
 await t.test('search pagination and a multi-chunk clear preserve other spaces',async()=>{
  await sql(`INSERT INTO messages(id,conversation_id,sender_id,body) SELECT 'bulk-' || value,?,'a','batch-search' FROM json_each(?)`,inbox,JSON.stringify(Array.from({length:165},(_,i)=>i)));
  const first=await call('searchMessages','a','batch-search');assert.equal(first.messages.length,50);assert.equal(first.hasMore,true);
  const second=await call('searchMessages','a','batch-search','','',50);assert.equal(second.messages.length,50);assert.equal(second.messages.some(m=>first.messages.some(a=>a.id===m.id)),false);
  const clear=await call('previewCommand','a',inbox,'clear','all');assert.equal(clear.count,166);
  await call('executeCommand','a',clear.token);assert.equal((await call('organizerMessages','a',inbox)).length,0);
  assert.equal((await call('searchMessages','a','New caption')).messages.length,1);
 });
 await t.test('cross-origin command requests are rejected; preview does not mutate content',async()=>{
  const before=await one('SELECT COUNT(*) n FROM messages');
  const r=await mf.dispatchFetch('http://organizer.test/route',{method:'POST',headers:{origin:'https://evil.test','Content-Type':'application/json'},body:JSON.stringify({action:'preview',sourceId:inbox,command:'clear'})});assert.equal(r.status,400);
  const p=await call('previewCommand','a',inbox,'clear','all');assert.ok(p.token);assert.deepEqual(await one('SELECT COUNT(*) n FROM messages'),before);
 });
 }finally{await mf.dispose();}
});
