'use client';

import { backendFetch as fetch, backendPath } from "@/lib/site-urls";

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_TRANSFER_FILE, PART_BYTES, type TransferFolder } from '@/lib/transfers';

async function request<T>(path = '', init?: RequestInit): Promise<T> {
  const response = await fetch('/api/transfers' + path, { cache:'no-store', ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Transfer failed.');
  return data;
}

async function fingerprint(file: File) {
  const sample = await new Blob([file.slice(0,65536),file.slice(Math.max(0,file.size-65536))]).arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',sample))]
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

const formatDate = (date: number) => new Intl.DateTimeFormat('en-MY',{
  timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short',
}).format(date) + ' MYT';

export function TemporaryTransfers() {
  const [folders,setFolders] = useState<TransferFolder[]>([]);
  const [selected,setSelected] = useState('');
  const [name,setName] = useState('');
  const [minutes,setMinutes] = useState(60);
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [copied,setCopied] = useState(false);
  const [confirm,setConfirm] = useState(false);
  const [progress,setProgress] = useState<{name:string;bytes:number;total:number}>();
  const active = useRef<AbortController|null>(null);
  const folder = folders.find(item=>item.id===selected);
  const link = folder?.token ? new URL(backendPath('/transfer/'+folder.token),window.location.origin).href : '';

  async function refresh(signal?: AbortSignal) {
    const result = await request<{folders:TransferFolder[]}>('',{signal});
    if (!signal?.aborted) setFolders(result.folders);
    return result.folders;
  }
  useEffect(() => {
    const controller = new AbortController();
    function sync() {
      if (active.current) return;
      void refresh(controller.signal).catch(error=>{
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load transfers.');
      }).finally(()=>{if (!controller.signal.aborted) setLoading(false);});
    }
    sync();
    const timer = window.setInterval(sync,15000);
    return () => { controller.abort(); active.current?.abort(); window.clearInterval(timer); };
  },[]);

  async function perform(action: (signal:AbortSignal)=>Promise<void>) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller; setBusy(true); setCopied(false); setError('');
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Transfer failed.');
    } finally {
      if (!controller.signal.aborted) {
        await refresh(controller.signal).catch(()=>{});
        setBusy(false); setProgress(undefined);
      }
      active.current = null;
    }
  }
  function post<T>(body: object, signal: AbortSignal) {
    return request<T>('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void perform(async signal => {
      const {id} = await post<{id:string}>({action:'create',name},signal);
      setName(''); setSelected(id);
    });
  }
  function upload(files: File[]) {
    if (!folder || !files.length) return;
    void perform(async signal => {
      const current = folder.files.map(file=>({...file}));
      for (const file of files) {
        if (file.size < 1 || file.size > MAX_TRANSFER_FILE) throw new Error('Choose a file from 1 byte to 1 GiB.');
        const hash = await fingerprint(file);
        const pending = current.find(item=>item.name===file.name && item.bytes===file.size && item.fingerprint===hash);
        if (pending?.status === 'ready') continue;
        const {id} = pending ?? await post<{id:string}>({action:'begin',id:folder.id,name:file.name,bytes:file.size,fingerprint:hash},signal);
        const status = await request<{ready:boolean;parts:number[]}>('?file='+encodeURIComponent(id),{signal});
        if (!status.ready) {
          const uploaded = new Set(status.parts);
          const parts = Math.ceil(file.size/PART_BYTES);
          let sent = status.parts.reduce((sum,part)=>sum+Math.min(PART_BYTES,file.size-(part-1)*PART_BYTES),0);
          setProgress({name:file.name,bytes:sent,total:file.size});
          for (let part=1;part<=parts;part++) {
            if (uploaded.has(part)) continue;
            const body = file.slice((part-1)*PART_BYTES,part*PART_BYTES);
            for (let attempt=0;;attempt++) {
              try {
                await request(`?file=${encodeURIComponent(id)}&part=${part}`,{method:'PUT',body,signal});
                break;
              } catch (error) {
                if (signal.aborted || attempt===2) throw error;
                await new Promise(resolve=>window.setTimeout(resolve,500*(attempt+1)));
              }
            }
            sent += body.size;
            setProgress({name:file.name,bytes:sent,total:file.size});
          }
          await post({action:'finish',id},signal);
        }
        if (pending) pending.status = 'ready';
        else current.push({id,name:file.name,bytes:file.size,fingerprint:hash,status:'ready'});
      }
    });
  }

  return <div className="transfer-panel">
    {error && <p className="send-error" role="alert">{error}</p>}
    {loading && <p role="status">Loading transfers…</p>}
    {!folder ? <>
      <form className="annotation-form" onSubmit={create}>
        <label>Folder name<input placeholder="e.g. Video handoff" required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
        <button className="auth-submit" disabled={busy || !name.trim()}>Create temporary folder</button>
      </form>
      <div className="share-list">{folders.map(item=><div className="share-row" key={item.id}>
        <button className="account-action" disabled={busy} onClick={()=>{setSelected(item.id);setConfirm(false);setCopied(false);setError('');}}>{item.name}</button>
        <small>{item.files.length} files · {item.expires ? 'Expires '+formatDate(item.expires) : 'Draft'}</small>
      </div>)}</div>
    </> : <>
      <button className="account-action" disabled={busy} onClick={()=>{setSelected('');setConfirm(false);setError('');}}>Back to transfers</button>
      <h3>{folder.name}</h3>
      {!link && <div className="transfer-drop" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();upload(Array.from(e.dataTransfer.files));}}>
        <label>Choose or drop files<input type="file" multiple disabled={busy} onChange={e=>{upload(Array.from(e.target.files ?? []));e.target.value='';}}/></label>
        <small>1 GiB per file · 2 GiB per folder. Drafts expire after 24 hours. Choose the same file again to resume.</small>
      </div>}
      {progress && <div className="upload-status" role="status">
        <span>{progress.name} · {Math.floor(100*progress.bytes/progress.total)}%</span>
        <progress aria-label="Upload progress" max={progress.total} value={progress.bytes}/>
      </div>}
      <ul className="share-list">{folder.files.map(file=><li className="share-row" key={file.id}>
        <strong>{file.name}</strong><small>{(file.bytes/1048576).toFixed(1)} MiB · {file.status==='ready'?'Ready':'Choose the same file to resume'}</small>
      </li>)}</ul>
      {link ? <div className="annotation-form">
        <p>Expires {formatDate(folder.expires!)}</p>
        <label>Download link<input readOnly value={link} onFocus={e=>e.target.select()}/></label>
        <button className="account-action" onClick={async()=>{try{await navigator.clipboard.writeText(link);setCopied(true);}catch{setError('Select the download link to copy it.');}}}>{copied?'Copied':'Copy link'}</button>
      </div> : <form className="annotation-form" onSubmit={e=>{e.preventDefault();void perform(signal=>post({action:'publish',id:folder.id,minutes},signal));}}>
        <label>Expires after sharing<select value={minutes} onChange={e=>setMinutes(Number(e.target.value))}>
          <option value={15}>15 minutes</option><option value={60}>1 hour</option><option value={1440}>24 hours</option>
        </select></label>
        <button className="auth-submit" disabled={busy || !folder.files.length || folder.files.some(file=>file.status!=='ready')}>Create download link</button>
      </form>}
      {confirm ? <div className="file-actions">
        <button disabled={busy} onClick={()=>setConfirm(false)}>Cancel</button>
        <button disabled={busy} onClick={()=>void perform(async signal=>{await post({action:'close',id:folder.id},signal);setSelected('');setConfirm(false);})}>Confirm {link?'revoke':'discard'}</button>
      </div> : <button className="account-action" disabled={busy} onClick={()=>setConfirm(true)}>{link?'Revoke and remove folder':'Discard draft'}</button>}
    </>}
  </div>;
}
