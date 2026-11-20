"use client";

import { backendFetch as fetch } from "@/lib/site-urls";

import { useEffect, useState } from 'react';
import { Download, Film, FileText, Image as ImageIcon } from 'lucide-react';
import { filePreview } from '@/lib/file-preview';

export type PreviewFile = { name: string; type: string | null; src: string; download?: string };

export function MediaTile({ src, name, kind, open }: { src: string; name: string; kind: 'image' | 'video'; open: () => void }) {
  const [failed, setFailed] = useState(false);
  const Icon = kind === 'video' ? Film : ImageIcon;
  return <button type="button" className="media-tile" onClick={open} aria-label={`Preview ${name}`}>
    {failed ? <span className="media-placeholder"><Icon /></span> : kind === 'image'
      ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      : <video src={`${src}#t=0.1`} preload="metadata" muted playsInline aria-hidden="true" onError={() => setFailed(true)} />}
    <span className="media-title">{kind === 'video' && <Film />}{name}</span>
  </button>;
}

function TextPreview({ src, archive }: { src: string; archive?: 'zip'|'docx'|'xlsx'|'pptx' }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('Loading preview…');
  useEffect(() => {
    const controller = new AbortController();
    async function read() {
      const response = await fetch(src, { signal: controller.signal, headers: archive ? {} : { Range: 'bytes=0-65535' } });
      if (!response.ok) throw new Error('Preview unavailable');
      const body = await response.blob();
      if (archive) {
        const { readArchive } = await import('@/lib/archive-preview');
        const content = await readArchive(body,archive);
        if (controller.signal.aborted) return;
        setText(content);
        setStatus(archive==='zip' ? 'Archive contents · up to 500 entries' : 'Extracted content · preview may be truncated');
        return;
      }
      const content = await body.slice(0, 65536).text();
      if (controller.signal.aborted) return;
      setText(content);
      const partial = response.headers.get('Content-Range');
      const total = partial ? Number(partial.split('/')[1]) : body.size;
      setStatus(total > 65536 ? 'Showing the first 64 KB.' : content ? '' : 'This file is empty.');
    }
    void read().catch(() => { if (!controller.signal.aborted) setStatus('Preview unavailable for this file.'); });
    return () => controller.abort();
  }, [src, archive]);
  return <div className="text-preview">{status && <p role="status">{status}</p>}{text && <pre>{text}</pre>}</div>;
}

export function FilePreview({ file }: { file: PreviewFile }) {
  const [failed, setFailed] = useState(false);
  const preview = filePreview(file.type, file.name);
  const [copyStatus, setCopyStatus] = useState('');
  async function copy() {
    setCopyStatus('Copying…');
    try {
      const blob = fetch(file.src).then(response => {
        if (!response.ok) throw new Error('File unavailable');
        return response.blob();
      });
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        if (preview?.kind === 'text') {
          await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob.then(async value => new Blob([await value.text()], { type: 'text/plain' })) })]);
        } else {
          const png = blob.then(async value => {
            if (value.type === 'image/png') return value;
            const image = await createImageBitmap(value);
            try {
              const canvas = document.createElement('canvas');
              canvas.width = image.width; canvas.height = image.height;
              canvas.getContext('2d')!.drawImage(image, 0, 0);
              return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('Image unavailable'))));
            } finally { image.close(); }
          });
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        }
      } else if (preview?.kind === 'text') {
        await navigator.clipboard.writeText(await (await blob).text());
      } else {
        await blob;
        throw new Error('Clipboard unavailable');
      }
      setCopyStatus('Copied.');
    } catch { setCopyStatus('Could not copy in this browser. You can download the file.'); }
  }
  return <>
    <div className="preview-surface">
      {failed || !preview ? <p><FileText /> Preview unavailable for this file.</p>
        : preview.kind === 'image' ? <img src={file.src} alt={file.name} onError={() => setFailed(true)} />
        : preview.kind === 'video' ? <video src={file.src} controls playsInline onError={() => setFailed(true)} />
        : preview.kind === 'audio' ? <audio src={file.src} controls onError={() => setFailed(true)} />
        : preview.kind === 'text' ? <TextPreview src={file.src} />
        : preview.kind === 'pdf' ? <iframe src={file.src} title={file.name} />
        : <TextPreview src={file.src} archive={preview.kind} />}
    </div>
    {preview?.kind === 'pdf' && <p><a href={file.src} target="_blank" rel="noopener noreferrer">Open PDF in a new tab</a></p>}
    <div className="dialog-actions">
      {!failed && (preview?.kind === 'image' || preview?.kind === 'text') && <button className="account-action" onClick={() => void copy()}>{preview.kind === 'image' ? 'Copy image' : 'Copy text'}</button>}
      {file.download && <a className="account-action file-download" href={file.download}><Download /> Download</a>}
    </div>
    {copyStatus && <p role="status">{copyStatus}</p>}
  </>;
}
