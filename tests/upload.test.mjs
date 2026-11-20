import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {writeFile,mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Miniflare} from 'miniflare';
import {unzipSync} from 'fflate';
const tmp=await mkdtemp(join(tmpdir(),'chathub-upload-'));
const bundled=await build({entryPoints:['lib/upload.ts'],bundle:true,write:false,format:'esm',platform:'node'});
await writeFile(join(tmp,'upload.mjs'),bundled.outputFiles[0].text);
const {uploadMessage}=await import(pathToFileURL(join(tmp,'upload.mjs')));
function requestMock(){return {upload:{},open(){},setRequestHeader(){},send(){},timeout:0,status:201,responseText:'{"id":"saved","attachmentId":"file"}'};}
test('upload shows byte progress, saving phase and confirmed success',async()=>{
 const xhr=requestMock(),events=[];const p=uploadMessage(new FormData(),e=>events.push(e),()=>xhr);
 xhr.upload.onprogress({lengthComputable:true,loaded:25,total:100});xhr.upload.onload();xhr.onload();
 assert.deepEqual(await p,{id:'saved',attachmentId:'file'});assert.deepEqual(events,[{phase:'uploading',percent:0},{phase:'uploading',percent:25},{phase:'saving',percent:100}]);
});
test('plain-text 413, non-JSON gateway failures and connection errors remain readable',async()=>{
 for(const [status,text,pattern] of [[413,'Payload Too Large',/server rejected.*too large/],[502,'<html>bad gateway</html>',/HTTP 502/],[400,'{"error":"Each file must be 10 MB or smaller."}',/10 MB/]]){
  const xhr=requestMock();xhr.status=status;xhr.responseText=text;const p=uploadMessage(new FormData(),()=>{},()=>xhr);xhr.onload();await assert.rejects(p,pattern);
 }
 const xhr=requestMock();const p=uploadMessage(new FormData(),()=>{},()=>xhr);xhr.onerror();await assert.rejects(p,/file and text are still here/);
});
test('pasted images use Malaysia date and time with usable file extensions', async () => {
 const bundled = await build({entryPoints:['lib/clipboard-files.ts'],bundle:true,write:false,format:'esm',platform:'node'});
 const {nameClipboardImages} = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
 const input = [new File(['image-data'],'image.png',{type:'image/png'}), new File(['second'],'screenshot',{type:'image/jpeg'}),
   new File(['third'],'photo.webp'), new File(['clip'],'movie.mp4',{type:'video/mp4'})];
 const result = nameClipboardImages(input,new Date('2026-11-17T08:09:10.123Z'));
 assert.deepEqual(result.map(file=>file.name), [
   '2026-11-17_16-09-10-123-01.png', '2026-11-17_16-09-10-123-02.jpg',
   '2026-11-17_16-09-10-123-03.webp', 'movie.mp4',
 ]);
 assert.equal(await result[0].text(),'image-data');
 assert.equal(result[3],input[3]);
});
test('actual built Worker accepts 2 MB and 10 MB multipart files with authentication, D1 and R2',{timeout:120000},async()=>{
 const files=(await readdir('dist/server',{recursive:true})).filter(p=>/\.m?js$/.test(p));
 const modules=['index.js',...files.filter(p=>p!=='index.js')].map(p=>({type:'ESModule',path:resolve('dist/server',p)}));
 const mf=new Miniflare({modules,modulesRoot:resolve('dist/server'),compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET']});
 try{
  const db=await mf.getD1Database('DB');
  const migration=(await readFile('drizzle/0000_lazy_black_widow.sql','utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
  for(const sql of migration)await db.prepare(sql).run();
  const origin=(await mf.ready).origin;
  const registered=await mf.dispatchFetch(origin+'/api/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'upload-test@example.test',password:'Synthetic-upload-password-79'})});
  assert.equal(registered.status,201,await registered.clone().text());
  const cookie=registered.headers.get('set-cookie').split(';')[0];
  const spaces=await mf.dispatchFetch(origin+'/api/conversations',{headers:{Cookie:cookie}}).then(r=>r.json());
  const inbox=spaces.conversations.find(s=>s.kind==='default').id;
  for(const bytes of [2*1024*1024,10*1024*1024]){
   const form=new FormData();form.set('conversation_id',inbox);form.set('body','');form.set('caption','Large video test');form.set('tags','["test"]');form.set('file',new File([new Uint8Array(bytes)],'video.mp4',{type:'video/mp4'}));
   const encoded=new Request(origin,{method:'POST',body:form});
   const r=await mf.dispatchFetch(origin+'/api/messages',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':encoded.headers.get('content-type')},body:await encoded.arrayBuffer()});
   assert.equal(r.status,201,await r.clone().text());const saved=await r.json();assert.ok(saved.id);assert.ok(saved.attachmentId);
   const row=await db.prepare('SELECT object_key,bytes FROM attachments WHERE id=?').bind(saved.attachmentId).first();assert.equal(row.bytes,bytes);
   const bucket=await mf.getR2Bucket('BUCKET');assert.equal((await bucket.head(row.object_key)).size,bytes);
  }
  const video = await db.prepare('SELECT id, object_key FROM attachments LIMIT 1').first();
  const filePath = origin + '/api/files/' + video.id;
  const preview = await mf.dispatchFetch(filePath + '?preview=1', {headers:{Cookie:cookie, Range:'bytes=10-19'}});
  assert.equal(preview.status,206);
  assert.equal(preview.headers.get('content-type'),'video/mp4');
  assert.match(preview.headers.get('content-range'),/^bytes 10-19\//);
  assert.equal((await preview.arrayBuffer()).byteLength,10);
  assert.equal((await mf.dispatchFetch(filePath + '?preview=1')).status,401);
  const action = (action, filename) => mf.dispatchFetch(origin+'/api/organizer', {
   method:'POST', headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},
   body:JSON.stringify({action, attachmentId:video.id, filename}),
  });
  assert.equal((await action('rename','my-demo.mp4')).status,200);
  assert.equal((await action('rename','final-cut.mp4')).status,200);
  for (const q of ['video.mp4','my-demo.mp4','final-cut.mp4']) {
   const found = await mf.dispatchFetch(origin+'/api/organizer?q='+q, {headers:{Cookie:cookie}}).then(r=>r.json());
   assert.ok(found.messages.some(m=>m.attachmentId===video.id && m.filename==='final-cut.mp4'));
  }
  const download = await mf.dispatchFetch(filePath, {headers:{Cookie:cookie}});
  assert.match(download.headers.get('content-disposition'),/attachment.*final-cut.mp4/);
  await download.body.cancel();
  assert.equal((await action('delete')).status,200);
  assert.equal((await mf.dispatchFetch(filePath, {headers:{Cookie:cookie}})).status,404);
  assert.equal(await (await mf.getR2Bucket('BUCKET')).head(video.object_key),null);
  const note = await db.prepare("SELECT caption FROM message_annotations WHERE caption='Large video test'").all();
  assert.equal(note.results.length,2);
  const form=new FormData();form.set('conversation_id',inbox);form.set('file',new File([new Uint8Array(11*1024*1024)],'oversized.mp4',{type:'video/mp4'}));
  const encoded=new Request(origin,{method:'POST',body:form});
  const tooBig=await mf.dispatchFetch(origin+'/api/messages',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':encoded.headers.get('content-type')},body:await encoded.arrayBuffer()});assert.equal(tooBig.status,400);assert.match((await tooBig.json()).error,/10 MB/);
  const post = (path, data, extra = {}) => mf.dispatchFetch(origin + path, {
    method:'POST', headers:{ Origin:origin, Cookie:cookie, 'Content-Type':'application/json', ...extra }, body:JSON.stringify(data),
  });
  const search = query => mf.dispatchFetch(origin + '/api/organizer?q=' + encodeURIComponent(query), {
    headers:{Cookie:cookie},
  }).then(response=>response.json());
  const noteForm = new FormData();
  noteForm.set('conversation_id',inbox);
  noteForm.set('body','Convert me 原始文字');
  noteForm.set('caption','Original caption');
  noteForm.set('tags','["keep"]');
  const noteRequest = new Request(origin,{method:'POST',body:noteForm});
  const original = await mf.dispatchFetch(origin+'/api/messages',{
    method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':noteRequest.headers.get('content-type')},
    body:await noteRequest.arrayBuffer(),
  }).then(response=>response.json());
  assert.ok(original.id);
  const conversion = await post('/api/organizer',{action:'convert-txt',messageId:original.id});
  assert.equal(conversion.status,200,await conversion.clone().text());
  const converted = (await search('原始文字')).messages.find(message=>message.id===original.id);
  assert.equal(converted.conversationId,inbox);
  assert.equal(converted.body,'');
  assert.equal(converted.caption,'Original caption');
  assert.deepEqual(converted.tags,['keep']);
  assert.match(converted.filename,/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.txt$/);
  assert.equal(await (await mf.dispatchFetch(origin+'/api/files/'+converted.attachmentId,{headers:{Cookie:cookie}})).text(),'Convert me 原始文字');
  assert.equal((await post('/api/organizer',{action:'convert-txt',messageId:original.id})).status,400);
  await db.prepare('DELETE FROM attachment_txt_search WHERE attachment_id=?').bind(converted.attachmentId).run();
  assert.equal((await search('原始文字')).messages[0].id,original.id);
  const firstUser = await db.prepare('SELECT created_by AS id FROM conversations WHERE id=?').bind(inbox).first();
  await db.prepare('INSERT INTO messages(id,conversation_id,sender_id,body) VALUES (?,?,?,?)')
    .bind('delete-inbox-test', inbox, firstUser.id, 'Delete this Inbox text').run();
  const deleteInboxText = (messageId, confirmed) => post('/api/organizer',{action:'delete-inbox-text',messageId,confirmed});
  assert.equal((await deleteInboxText('delete-inbox-test',false)).status,400);
  assert.equal((await deleteInboxText(original.id,true)).status,400);
  assert.equal((await search('Delete this Inbox text')).messages.length,1);
  assert.equal((await deleteInboxText('delete-inbox-test',true)).status,200);
  assert.equal((await search('Delete this Inbox text')).messages.length,0);
  assert.equal((await search('原始文字')).messages[0].id,original.id);
  const uploadLinkResponse = await post('/api/shares', { kind:'upload', target:inbox, minutes:60 });
  assert.equal(uploadLinkResponse.status,200,await uploadLinkResponse.clone().text());
  const { token:uploadToken } = await uploadLinkResponse.json();
  const uploadPath = origin + '/share/' + uploadToken;
  assert.match(await (await mf.dispatchFetch(uploadPath)).text(), /Upload to ChatHub/);
  const guestFile = new FormData();
  guestFile.set('file', new File(['Guest content'], 'guest.txt', { type:'text/plain' }));
  const guestRequest = new Request(uploadPath, { method:'POST', body:guestFile });
  const guestUpload = await mf.dispatchFetch(uploadPath, { method:'POST', headers:{ Origin:origin, 'Content-Type':guestRequest.headers.get('content-type') }, body:await guestRequest.arrayBuffer() });
  assert.equal(guestUpload.status,201,await guestUpload.clone().text());
  const attachment = await db.prepare("SELECT id FROM attachments WHERE filename='guest.txt'").first();
  const textPath = origin + '/api/files/' + attachment.id;
  const textFile = await mf.dispatchFetch(textPath + '?preview=1',{ headers:{ Cookie:cookie } });
  assert.equal(await textFile.text(),'Guest content');
  const editHeaders = { Origin:origin, Cookie:cookie, 'Content-Type':'application/json', 'If-Match':textFile.headers.get('etag') };
  const edit = () => mf.dispatchFetch(textPath, { method:'PATCH', headers:editHeaders, body:JSON.stringify({text:'Edited 文字'}) });
  assert.ok((await search('guest content')).messages.some(message=>message.attachmentId===attachment.id));
  const edited = await edit();
  assert.equal(edited.status,200,await edited.clone().text());
  assert.equal((await edit()).status,409);
  assert.ok((await search('edited 文字')).messages.some(message=>message.attachmentId===attachment.id));
  assert.equal((await search('guest content')).messages.length,0);

  const shareResponse = await post('/api/shares', { kind:'download', target:attachment.id, minutes:15 });
  assert.equal(shareResponse.status,200,await shareResponse.clone().text());
  const { token:downloadToken } = await shareResponse.json();
  const guestDownload = await mf.dispatchFetch(origin + '/share/' + downloadToken);
  assert.match(guestDownload.headers.get('content-disposition'), /attachment.*guest.txt/);
  assert.equal(await guestDownload.text(),'Edited 文字');
  const bundleShare = targets => post('/api/shares',{kind:'download',targets,minutes:15});
  assert.equal((await bundleShare([attachment.id,'att_missing'])).status,400);
  assert.equal((await bundleShare([attachment.id,attachment.id])).status,400);
  const zipLinkResponse = await bundleShare([attachment.id,converted.attachmentId]);
  assert.equal(zipLinkResponse.status,200,await zipLinkResponse.clone().text());
  const {token:zipToken}=await zipLinkResponse.json();
  const zipPath=origin+'/share/'+zipToken;
  const zipResponse=await mf.dispatchFetch(zipPath);
  assert.equal(zipResponse.headers.get('content-type'),'application/zip');
  assert.match(zipResponse.headers.get('content-disposition'),/attachment.*ChatHub_.*\.zip/);
  const zipped=unzipSync(new Uint8Array(await zipResponse.arrayBuffer()));
  assert.equal(new TextDecoder().decode(zipped['guest.txt']),'Edited 文字');
  assert.equal(new TextDecoder().decode(zipped[converted.filename]),'Convert me 原始文字');
  assert.equal((await post('/api/shares',{action:'revoke',token:zipToken})).status,200);
  assert.equal((await mf.dispatchFetch(zipPath)).status,404);
  const links = await mf.dispatchFetch(origin + '/api/shares', { headers:{ Cookie:cookie } }).then(response=>response.json());
  assert.equal(links.links.length,2);
  assert.equal((await post('/api/shares', {action:'revoke',token:downloadToken})).status,200);
  assert.equal((await mf.dispatchFetch(origin + '/share/' + downloadToken)).status,404);
  await db.prepare('UPDATE file_shares SET expires=0 WHERE token=?').bind(uploadToken).run();
  assert.equal((await mf.dispatchFetch(uploadPath)).status,404);
  const transfer = data=>post('/api/transfers',data);
  const draftResponse=await transfer({action:'create',name:'Test <transfer>'});
  assert.equal(draftResponse.status,201,await draftResponse.clone().text());
  const {id:transferId}=await draftResponse.json();
  assert.equal((await transfer({action:'publish',id:transferId,minutes:15})).status,400);
  const partSize=8*1024*1024;
  const begin=await transfer({action:'begin',id:transferId,name:'big-test.bin',bytes:partSize+4*1024*1024,fingerprint:'a'.repeat(64)});
  assert.equal(begin.status,201,await begin.clone().text());
  const {id:tempId}=await begin.json();
  const part=(number,body)=>mf.dispatchFetch(origin+'/api/transfers?file='+tempId+'&part='+number,{
    method:'PUT',headers:{Origin:origin,Cookie:cookie,'Content-Length':String(body.byteLength)},body,
  });
  const first=await part(1,new Uint8Array(partSize));
  assert.equal(first.status,200,await first.clone().text());
  const resume=await mf.dispatchFetch(origin+'/api/transfers?file='+tempId,{headers:{Cookie:cookie}}).then(r=>r.json());
  assert.deepEqual(resume.parts,[1]);
  const tail=new Uint8Array(4*1024*1024);tail.set([1,2,3,4],tail.length-4);
  const second=await part(2,tail);
  assert.equal(second.status,200,await second.clone().text());
  const finish=await transfer({action:'finish',id:tempId});
  assert.equal(finish.status,200,await finish.clone().text());
  assert.equal((await transfer({action:'finish',id:tempId})).status,200);
  const published=await transfer({action:'publish',id:transferId,minutes:15});
  assert.equal(published.status,200,await published.clone().text());
  const transferList=await mf.dispatchFetch(origin+'/api/transfers',{headers:{Cookie:cookie}}).then(r=>r.json());
  const transferPath=origin+'/transfer/'+transferList.folders[0].token;
  const transferRange=await mf.dispatchFetch(transferPath,{headers:{Range:'bytes=-4'}});
  assert.equal(transferRange.status,206,await transferRange.clone().text());
  assert.deepEqual([...new Uint8Array(await transferRange.arrayBuffer())],[1,2,3,4]);
  assert.equal((await mf.dispatchFetch(transferPath+'?file=unrelated')).status,404);
  await db.prepare('UPDATE temp_folders SET expires=?,deadline=? WHERE id=?').bind(1,1,transferId).run();
  assert.equal((await mf.dispatchFetch(transferPath)).status,404);
  const cleaned=await mf.dispatchFetch(origin+'/api/transfer-cleanup',{method:'POST'});
  assert.equal(cleaned.status,200,await cleaned.clone().text());
  assert.equal(await (await mf.getR2Bucket('BUCKET')).head('temporary-transfers/'+tempId),null);
 }finally{await mf.dispose();await rm(tmp,{recursive:true,force:true});}
});
