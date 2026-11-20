import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';

test('friend consent, private chat, unread state and independent saved attachments', {timeout:120000}, async () => {
  const files=(await readdir('dist/server',{recursive:true})).filter(p=>/\.m?js$/.test(p));
  const modules=['index.js',...files.filter(p=>p!=='index.js')].map(p=>({type:'ESModule',path:resolve('dist/server',p)}));
  const mf=new Miniflare({modules,modulesRoot:resolve('dist/server'),compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET']});
  try {
    const db=await mf.getD1Database('DB');
    for(const sql of (await readFile('drizzle/0000_lazy_black_widow.sql','utf8')).split('--> statement-breakpoint')) {
      if(sql.trim()) await db.prepare(sql.trim()).run();
    }
    const origin=(await mf.ready).origin;
    async function post(path, data, cookie='') {
      const form=data instanceof FormData;
      const req=new Request(origin,{method:'POST',body:form?data:JSON.stringify(data)});
      return mf.dispatchFetch(origin+path,{method:'POST',headers:{Cookie:cookie,Origin:origin,
        'Content-Type':form?req.headers.get('content-type'):'application/json'},body:await req.arrayBuffer()});
    }
    async function register(name) {
      const response=await post('/api/auth/register',{email:name+'@example.test',password:'Synthetic-test-pass-75'});
      assert.equal(response.status,201,await response.clone().text());
      return response.headers.get('set-cookie').split(';')[0];
    }
    const [alice,bob,eve]=await Promise.all(['alice','bob','eve'].map(register));
    const get=(path,Cookie)=>mf.dispatchFetch(origin+path,{headers:{Cookie}});
    const state=cookie=>get('/api/social',cookie).then(r=>r.json());
    const bobCode=(await state(bob)).code;
    assert.equal((await post('/api/social',{action:'invite',code:bobCode},alice)).status,200);
    const request=(await state(bob)).requests[0];
    assert.equal(request.incoming,true);
    assert.equal((await post('/api/social',{action:'accept',id:request.id},eve)).status,400);
    assert.equal((await state(alice)).chats.length,0);
    const accepted=await post('/api/social',{action:'accept',id:request.id},bob);
    assert.equal(accepted.status,200,await accepted.clone().text());
    const chat=(await state(alice)).chats[0];
    assert.equal((await state(bob)).chats[0].id,chat.id);
    const form=new FormData();
    form.set('conversation_id',chat.id);
    form.set('body','/literal');
    form.set('file',new File(['private contents'],'demo.txt',{type:'text/plain'}));
    assert.equal((await post('/api/messages',form,eve)).status,400);
    const sent=await post('/api/messages',form,alice);
    assert.equal(sent.status,201,await sent.clone().text());
    const {id,attachmentId}=await sent.json();
    assert.equal((await state(bob)).chats[0].unread,1);
    assert.equal((await get('/api/files/'+attachmentId,eve)).status,404);
    assert.equal((await get('/api/files/'+attachmentId+'?preview=1',bob)).status,200);
    assert.equal((await get('/api/organizer?q=demo',bob).then(r=>r.json())).messages.length,0);
    assert.equal((await post('/api/social',{action:'read',chatId:chat.id,messageId:id},bob)).status,200);
    assert.equal((await state(bob)).chats[0].unread,0);
    assert.equal((await post('/api/organizer',{action:'delete',attachmentId},bob)).status,400);
    assert.equal((await post('/api/social',{action:'save',id:attachmentId},eve)).status,400);
    assert.equal((await post('/api/social',{action:'save',id:attachmentId},bob)).status,200);
    const copy=(await get('/api/organizer?q=demo',bob).then(r=>r.json())).messages[0];
    assert.notEqual(copy.attachmentId,attachmentId);
    assert.equal((await post('/api/organizer',{action:'delete',attachmentId},alice)).status,200);
    assert.equal(await get('/api/files/'+copy.attachmentId,bob).then(r=>r.text()),'private contents');
  } finally { await mf.dispose(); }
});
