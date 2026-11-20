"use client";

import { backendFetch as fetch, standalone } from "@/lib/site-urls";

import { useEffect, useRef, useState } from 'react';
import { Download, Film, FileText, Image as ImageIcon } from 'lucide-react';
import { filePreview } from '@/lib/file-preview';

export type PreviewFile = { name: string; type: string | null; src: string; download?: string };

function usePrivateMedia(src: string | undefined, lazy = false) {
  const target = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(!lazy);
  const [result, setResult] = useState<{ source: string; url: string | null }>();
  useEffect(() => {
    if (!standalone || !lazy || !target.current) return;
    if (!("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "150px" });
    observer.observe(target.current);
    return () => observer.disconnect();
  }, [lazy]);
  useEffect(() => {
    if (!standalone || !src || !visible) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const response = await fetch(src, { signal: controller.signal });
      if (!response.ok) throw new Error("File unavailable");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setResult({ source: src, url: objectUrl });
    })().catch(() => {
      if (!controller.signal.aborted) setResult({ source: src, url: null });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, visible]);
  return { target, url: standalone ? (result?.source === src ? result?.url : undefined) : src };
}

export function FileDownload({ src, name, iconOnly = false }: { src: string; name: string; iconOnly?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const className = iconOnly ? "icon-button" : "account-action file-download";
  const label = `Download ${name}`;
  const content = <><Download />{!iconOnly && (busy ? " Downloading…" : " Download")}</>;
  if (!standalone) return <a className={className} aria-label={label} href={src}>{content}</a>;
  async function download() {
    setBusy(true);
    setError(false);
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error("File unavailable");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return <><button type="button" className={className} aria-label={label} disabled={busy} onClick={() => void download()}>{content}</button>{error && <small role="alert">Download failed. Try again.</small>}</>;
}

export function MediaTile({ src, name, kind, open }: { src: string; name: string; kind: 'image' | 'video'; open: () => void }) {
  const [failed, setFailed] = useState(false);
  const { target, url } = usePrivateMedia(src, true);
  const Icon = kind === 'video' ? Film : ImageIcon;
  return <button type="button" className="media-tile" ref={target} onClick={open} aria-label={`Preview ${name}`}>
    {failed || !url ? <span className="media-placeholder"><Icon /></span> : kind === 'image'
      ? <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      : <video src={`${url}#t=0.1`} preload="metadata" muted playsInline aria-hidden="true" onError={() => setFailed(true)} />}
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
  const isMedia = preview && ['image', 'video', 'audio', 'pdf'].includes(preview.kind);
  const { url } = usePrivateMedia(isMedia ? file.src : undefined);
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
      {failed || !preview || (isMedia && url === null) ? <p><FileText /> Preview unavailable for this file.</p>
        : isMedia && !url ? <p role="status">Loading preview…</p>
        : preview.kind === 'image' ? <img src={url || undefined} alt={file.name} onError={() => setFailed(true)} />
        : preview.kind === 'video' ? <video src={url || undefined} controls playsInline onError={() => setFailed(true)} />
        : preview.kind === 'audio' ? <audio src={url || undefined} controls onError={() => setFailed(true)} />
        : preview.kind === 'text' ? <TextPreview src={file.src} />
        : preview.kind === 'pdf' ? <iframe src={url || undefined} title={file.name} />
        : <TextPreview src={file.src} archive={preview.kind} />}
    </div>
    {preview?.kind === 'pdf' && url && <p><a href={url} target="_blank" rel="noopener noreferrer">Open PDF in a new tab</a></p>}
    <div className="dialog-actions">
      {!failed && (preview?.kind === 'image' || preview?.kind === 'text') && <button className="account-action" onClick={() => void copy()}>{preview.kind === 'image' ? 'Copy image' : 'Copy text'}</button>}
      {file.download && <FileDownload src={file.download} name={file.name} />}
    </div>
    {copyStatus && <p role="status">{copyStatus}</p>}
  </>;
}
