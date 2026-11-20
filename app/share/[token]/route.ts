import { activeShare, receiveSharedFile, sharedDownload } from '@/lib/server/shares';
import { requireSameOrigin } from '@/lib/server/auth-http';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const unavailable = () => new Response('This link is unavailable or has expired.', { status: 404, headers });

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const share = await activeShare((await context.params).token);
  if (!share) return unavailable();
  if (share.kind === 'download') return (await sharedDownload(share)) ?? unavailable();
  return new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload to ChatHub</title><style>
body{font:16px system-ui;margin:12vh auto;padding:0 20px;max-width:35rem;color:#182339;background:#edf2f9}
main{background:white;padding:28px;border-radius:18px} h1{margin-top:0} label{display:block;border:2px dashed #a1adc2;padding:20px;border-radius:12px} input{max-width:100%}
button{margin-top:16px;padding:10px 18px;background:#254d94;color:white;border:0;border-radius:8px;font:inherit} progress{width:100%;margin-top:12px} li{overflow-wrap:anywhere}
</style><main><h1>Upload to ChatHub</h1><p>Select or drop files. Up to 10 MB each and 20 files per link.</p>
<form><label>Choose files<input name="file" type="file" multiple required></label><button>Upload</button></form>
<progress max="100" hidden></progress><ul aria-live="polite"></ul></main><script>
const form = document.querySelector('form'), input = form.elements.file, button = form.querySelector('button');
const progress = document.querySelector('progress'), results = document.querySelector('ul');
let pending = [];
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => {
  event.preventDefault();
  if (!button.disabled && event.dataTransfer.files.length) input.files = event.dataTransfer.files;
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = input.disabled = true;
  results.replaceChildren(); pending = [];
  const files = Array.from(input.files);
  for (const file of files) {
    const row = document.createElement('li');
    results.append(row); row.textContent = file.name + ' — uploading';
    try {
      if (file.size > 10485760) throw new Error('File exceeds 10 MB.');
      progress.hidden = false; progress.value = 0;
      const data = new FormData(); data.set('file', file);
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', location.pathname); xhr.responseType = 'json';
        xhr.upload.onprogress = e => { if (e.lengthComputable) progress.value = e.loaded / e.total * 100; };
        xhr.onload = () => xhr.status === 201 ? resolve() : reject(new Error(xhr.response?.error || 'Link unavailable.'));
        xhr.onerror = () => reject(new Error('Connection failed.'));
        xhr.send(data);
      });
      row.textContent = file.name + ' — uploaded';
    } catch (error) {
      pending.push(file); row.textContent = file.name + ' — ' + error.message;
    }
  }
  const retry = new DataTransfer();
  pending.forEach(file => retry.items.add(file)); input.files = retry.files;
  progress.hidden = true; button.disabled = input.disabled = false;
});
</script></html>`, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  } });
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    requireSameOrigin(request);
    const share = await activeShare((await context.params).token);
    if (!share || share.kind !== 'upload') return unavailable();
    const length = Number(request.headers.get('Content-Length') ?? 0);
    if (length > 10 * 1024 * 1024 + 65536) {
      return Response.json({ error: 'Each file must be 10 MB or smaller.' }, { status: 413, headers });
    }
    // Bound streamed bodies as well as requests that declare a length.
    let bytes = 0;
    const body = request.body?.pipeThrough(new TransformStream({
      transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > 10 * 1024 * 1024 + 65536) controller.error(new Error('Upload too large'));
        else controller.enqueue(chunk);
      },
    }));
    const form = await new Response(body, { headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' } }).formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size > 10 * 1024 * 1024) {
      return Response.json({ error: 'Choose a file up to 10 MB.' }, { status: 400, headers });
    }
    if (!await receiveSharedFile(share, file)) {
      return Response.json({ error: 'This link expired, was revoked, or has reached its upload limit.' }, { status: 410, headers });
    }
    return Response.json({ ok: true }, { status: 201, headers });
  } catch {
    return Response.json({ error: 'Upload could not finish. Check the file size and retry.' }, { status: 400, headers });
  }
}
