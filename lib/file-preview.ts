import { backendPath } from "./site-urls";
const images = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon'];
const videos = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
const audio = ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac'];
const text = ['text/plain', 'text/csv', 'text/markdown', 'application/json'];

export function filePreview(type: string | null, name = "") {
  const mime = type?.split(';')[0].trim().toLowerCase() ?? '';
  if (images.includes(mime)) return { kind: 'image', mime } as const;
  if (videos.includes(mime)) return { kind: 'video', mime } as const;
  if (audio.includes(mime)) return { kind: 'audio', mime } as const;
  if (text.includes(mime)) return { kind: 'text', mime: 'text/plain; charset=utf-8' } as const;
  const extensions = {
    zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  } as const;
  for (const kind of Object.keys(extensions) as (keyof typeof extensions)[]) {
    if (mime === extensions[kind] || name.toLowerCase().endsWith('.'+kind)) return {kind, mime:'application/octet-stream'} as const;
  }
  if (/\.(txt|csv|md|json|log|xml|html|css|js|ts|py|sql|ini|yaml|yml|sh|bat)$/i.test(name)) return {kind:'text',mime:'text/plain; charset=utf-8'} as const;
  if (mime === 'application/pdf') return { kind: 'pdf', mime } as const;
  return null;
}

export function fileUrl(id: string, preview = false) {
  return backendPath(`/api/files/${encodeURIComponent(id)}${preview ? '?preview=1' : ''}`);
}
