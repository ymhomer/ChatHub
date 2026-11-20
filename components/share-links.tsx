'use client';

import { backendFetch as fetch, backendPath } from "@/lib/site-urls";

import { useEffect, useState, type FormEvent } from 'react';
import type { DownloadItem } from '@/lib/share-download';
import type { Space } from '@/lib/organizer';

type Share = { token: string; kind: 'download' | 'upload'; expires: number; name: string };

export function ShareLinks({ attachments, spaces, destination }: {
  attachments?: DownloadItem[]; spaces: Space[]; destination: string;
}) {
  const multiple = Boolean(attachments && attachments.length > 1);
  const [links, setLinks] = useState<Share[]>([]);
  const [target, setTarget] = useState(destination);
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [created, setCreated] = useState<Share>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/shares', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json() as { links: Share[] };
      setLinks(current => [...current, ...data.links.filter(link => !current.some(item => item.token === link.token))]);
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load active links.'); });
    return () => controller.abort();
  }, []);

  async function submit(body: object) {
    const response = await fetch('/api/shares', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Could not update the link.');
    return result;
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setCopied('');
    try {
      const link: Share = await submit({ kind: attachments ? 'download' : 'upload', target, targets: attachments?.map(file => file.id), minutes });
      setCreated(link);
      setLinks(current => [link, ...current.filter(item => item.token !== link.token)]);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not create the link.'); }
    finally { setBusy(false); }
  }
  async function revoke(token: string) {
    setBusy(true); setError('');
    try {
      await submit({ action: 'revoke', token });
      setLinks(current => current.filter(link => link.token !== token));
      if (created?.token === token) setCreated(undefined);
    } catch { setError('Could not revoke the link.'); }
    finally { setBusy(false); }
  }
  async function copy(link: Share) {
    setError('');
    try { await navigator.clipboard.writeText(url(link.token)); setCopied(link.token); }
    catch { setCreated(link); setError('Select the link above to copy it.'); }
  }
  function url(token: string) { return new URL(backendPath('/share/' + token), location.origin).href; }

  return <>
    <form className="annotation-form" onSubmit={create}>
      {attachments ? <div>
        {multiple && <p>{attachments.length} files · ZIP download</p>}
        <ul className="share-selection-list">{attachments.map(file => <li key={file.id}>{file.name}</li>)}</ul>
      </div> :
        <label>Save incoming files to<select value={target} onChange={e => setTarget(e.target.value)}>
          {spaces.map(space => <option key={space.id} value={space.id}>{space.title}</option>)}
        </select></label>}
      <label>Expires in<select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
        <option value={15}>15 minutes</option><option value={60}>1 hour</option><option value={1440}>24 hours</option>
      </select></label>
      <small>Anyone with the link can {multiple ? 'download these files as a ZIP' : attachments ? 'download this file' : 'upload up to 20 files'} until it expires.</small>
      <button className="auth-submit" disabled={busy}>Create {attachments ? 'download' : 'upload'} link</button>
    </form>
    {error && <p className="send-error" role="alert">{error}</p>}
    {created && <label className="share-url">New link<input readOnly value={url(created.token)} onFocus={e => e.target.select()} /></label>}
    {links.length > 0 && <div className="share-list" aria-label="Active sharing links">{links.map(link =>
      <div className="share-row" key={link.token}>
        <strong>{link.kind === 'upload' ? 'Upload to ' : ''}{link.name}</strong>
        <small>Expires {new Date(link.expires).toLocaleString('en-MY')}</small>
        <div className="file-actions">
          <button onClick={() => void copy(link)}>{copied === link.token ? 'Copied' : 'Copy link'}</button>
          <button disabled={busy} onClick={() => void revoke(link.token)}>Revoke</button>
        </div>
      </div>)}</div>}
  </>;
}
