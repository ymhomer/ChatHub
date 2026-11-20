import { publicTransfer, transferDownload } from '@/lib/server/transfers';

const headers = { 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer' };
const unavailable = () => new Response('This transfer is unavailable or has expired.',{status:404,headers});
const escape = (text: string) => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export async function GET(request: Request, context: { params: Promise<{token:string}> }) {
  const folder = await publicTransfer((await context.params).token);
  if (!folder) return unavailable();
  const id = new URL(request.url).searchParams.get('file');
  if (id || folder.files.length === 1) {
    const file = id ? folder.files.find(file=>file.id===id) : folder.files[0];
    return file ? (await transferDownload(file,request)) ?? unavailable() : unavailable();
  }
  const expires = new Intl.DateTimeFormat('en-MY',{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(folder.expires);
  const files = folder.files.map(file => `<li><a href="?file=${encodeURIComponent(file.id)}" download>${escape(file.name)}</a><span>${(file.bytes/1048576).toFixed(1)} MiB</span></li>`).join('');
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ChatHub · Temporary transfer</title><style>body{font:16px system-ui;max-width:38rem;margin:8vh auto;padding:0 16px;color:#183b31;background:#f2f8f4}main{background:white;border-radius:18px;padding:24px}h1,li{overflow-wrap:anywhere}ul{padding:0;list-style:none}li{border-top:1px solid #dce7df;padding:14px 0;display:grid;gap:4px}a{color:#176149}span,p{color:#566960;font-size:.9rem}</style>
  <main><p>ChatHub · Temporary transfer</p><h1>${escape(folder.name)}</h1><p>Available until ${escape(expires)} MYT</p><ul>${files}</ul></main></html>`,
  {headers:{...headers,'Content-Type':'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"}});
}
