"use client";

import { backendFetch as fetch, appPath } from "@/lib/site-urls";

import { type ClipboardEvent, type DragEvent, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { FileText, Image as ImageIcon, Film, Download, Inbox, MessageCircle, Users, Link as LinkIcon, Menu, LoaderCircle, Paperclip, Search, SendHorizontal, Settings2, Terminal, X } from "lucide-react";
import { uploadMessage, type UploadState } from "@/lib/upload";
import { filePreview, fileUrl } from "@/lib/file-preview";
import { FilePreview, MediaTile, type PreviewFile } from "@/components/file-preview";
import { FileSelectionArea } from "@/components/file-selection-area";
import { TemporaryTransfers } from "@/components/temporary-transfers";
import { ShareLinks } from "@/components/share-links";
import { nameClipboardImages } from "@/lib/clipboard-files";
import { MAX_DOWNLOAD_FILES, type DownloadItem } from "@/lib/share-download";
import { txtFilename } from "@/lib/txt";
import Login from "@/components/login";
import { TYPE_LABELS, normalizeTags, parseCommand, type ChatMessage, type Space, type ContentType, type CommandPreview } from "@/lib/organizer";

import type { SocialState } from "@/lib/social";

type StagedFile = { file: File; id: string; src: string };
type FileAction = { message: ChatMessage; action: "rename" | "delete" };
type User = { id: string; displayName: string; email: string };
const commands = [
  { text: '/move all', detail: 'Sort everything by type. Text-only notes stay here.' },
  { text: '/move video', detail: 'Move videos to Videos.' },
  { text: '/move picture', detail: 'Move images to Pictures. Alias: /move pic' },
  { text: '/move url', detail: 'Move links to Web links. Alias: /move web' },
  { text: '/move file', detail: 'Move other attachments to Files.' },
  { text: '/search', detail: 'Find text, captions, filenames and tags across all spaces.' },
  { text: '/clear', detail: 'Review and clear Inbox only.' },
];
const icons = { default: Inbox, picture: ImageIcon, video: Film, url: LinkIcon, file: FileText, archive: Inbox };
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,button,textarea')?.focus();
    return () => previous?.focus();
  }, [title]);
  return <div className="dialog-shade"><div ref={ref} className="organizer-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={e => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const elements = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,a[href]');
      if (!elements?.length) return;
      const first=elements[0],last=elements[elements.length-1];
      if (e.shiftKey && document.activeElement===first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement===last) { e.preventDefault(); first.focus(); }
    }
  }}><div className="dialog-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={close}><X /></button></div>{children}</div></div>;
}
function MessageCard({ message, edit, open, search, inspect, manage, save, chat, asText, share, copyText, deleteText, selection }: { message: ChatMessage; edit: () => void; open?: () => void; search: (tag:string)=>void; inspect: () => void; manage: (action: FileAction["action"]) => void; save?: () => void; chat?: boolean; asText?: () => void; share?: () => void; copyText?: () => void; deleteText?: () => void; selection?: ReactNode }) {
  const Icon = message.contentType?.startsWith('video/') ? Film : message.contentType?.startsWith('image/') ? ImageIcon : FileText;
  return <article className="saved-item" id={`item-${message.id}`}>
    {chat && <strong className="chat-sender">{message.senderName}</strong>}
    {open && <button className="source-link" onClick={open}>{message.spaceTitle} ↗</button>}
    {message.body && <p className="item-body">{message.body.split(/(https?:\/\/[^\s<>]+)/gi).map((part,i) => /^https?:\/\//i.test(part) ? <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part)}</p>}
    {message.attachmentId && <div className="file-row">
      {selection}
      <button type="button" className="file-card" onClick={inspect}><span className="file-icon"><Icon /></span><span className="file-text"><strong>{message.filename}</strong><small>{((message.bytes ?? 0)/1024/1024).toFixed(2)} MB</small></span><span className="file-action">Preview</span></button>
      <a className="icon-button" aria-label={`Download ${message.filename}`} href={fileUrl(message.attachmentId)}><Download /></a>
    </div>}
    {message.attachmentId && message.canManageFile && <div className="file-actions"><button onClick={()=>manage('rename')}>Rename</button><button onClick={()=>manage('delete')}>Delete</button>{share && <button onClick={share}>Share download</button>}</div>}
    {(copyText || asText || deleteText) && <div className="file-actions">
      {copyText && <button onClick={copyText}>Copy text</button>}
      {asText && <button onClick={asText}>Convert to TXT</button>}
      {deleteText && <button onClick={deleteText}>Delete</button>}
    </div>}
    {save && <div className="file-actions"><button onClick={save}>Save to Inbox</button></div>}
    {message.caption && <p className="item-caption">{message.caption}</p>}
    <div className="item-tags">{message.typeTags.map(type=><span className="type-tag" key={type}>{TYPE_LABELS[type]}</span>)}{message.tags.map(tag=><button key={tag} onClick={()=>search(tag)}>#{tag}</button>)}</div>
    <footer className="item-footer"><time dateTime={message.createdAt}>{new Date(message.createdAt.endsWith('Z') || /[+-]\d\d:\d\d$/.test(message.createdAt) ? message.createdAt : message.createdAt.replace(' ','T')+'Z').toLocaleString('en-MY')}</time>{(!chat || message.canManageFile) && <button aria-label="Edit caption and tags" onClick={edit}><Settings2 /> Caption & tags</button>}</footer>
  </article>;
}

export default function Home() {
  const [user,setUser]=useState<User|null>(null);
  const [section, setSection] = useState<'files'|'chats'>('files');
  const [social, setSocial] = useState<SocialState|null>(null);
  const [friendPanel, setFriendPanel] = useState(false);
  const [friendCode, setFriendCode] = useState('');
  const [socialError, setSocialError] = useState('');
  const [alert, setAlert] = useState<{ text: string; chat?: string }|null>(null);
  const previousSocial = useRef<SocialState|null>(null);
  const lastRead = useRef('');
  const drafts = useRef(new Map<string,{draft:string; files:StagedFile[]; caption:string; tags:string; details:boolean}>());
  const [checking,setChecking]=useState(true);
  const [linkRequired,setLinkRequired]=useState(false);
  const [conversations,setConversations]=useState<Space[]>([]);
  const [selected,setSelected]=useState('');
  const [messages,setMessages]=useState<ChatMessage[]>([]);
  const [draft,setDraft]=useState(''); const [files,setFiles]=useState<StagedFile[]>([]);
  const objectUrls = useRef(new Set<string>());
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [fileViewer, setFileViewer] = useState<PreviewFile|null>(null);
  const [media, setMedia] = useState<ChatMessage|null>(null);
  const [fileAction, setFileAction] = useState<FileAction|null>(null);
  const [txtMode, setTxtMode] = useState(false);
  const [txtName, setTxtName] = useState('');
  const [textToDelete, setTextToDelete] = useState<ChatMessage|null>(null);
  const [txtEditor, setTxtEditor] = useState<{ attachmentId: string; etag: string; text: string } | null>(null);
  const [txtConversion, setTxtConversion] = useState<ChatMessage|null>(null);
  const [shares, setShares] = useState<{ attachments?: DownloadItem[] } | null>(null);
  const [transfersOpen, setTransfersOpen] = useState(false);
  const [selectingFiles, setSelectingFiles] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<DownloadItem[]>([]);
  const [viewerMessage, setViewerMessage] = useState<ChatMessage|null>(null);
  const [filename, setFilename] = useState('');
  const [batch, setBatch] = useState<{ current: number; total: number }|null>(null);
  useEffect(() => {
    const urls = objectUrls.current;
    return () => { urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); };
  }, []);
  useEffect(() => {
    const prevent = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);
  const [caption,setCaption]=useState(''); const [tags,setTags]=useState(''); const [details,setDetails]=useState(false);
  const [upload,setUpload]=useState<UploadState|null>(null);
  const [busy,setBusy]=useState(false); const lock=useRef(false); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
  const [syncError,setSyncError]=useState(''); const [refreshVersion,setRefreshVersion]=useState(0);
  const [mobileNav,setMobileNav]=useState(false); const [menu,setMenu]=useState(false); const [preview,setPreview]=useState<CommandPreview|null>(null);
  const sortBeforeClear=useRef(false);
  const [editing,setEditing]=useState<ChatMessage|null>(null); const [editCaption,setEditCaption]=useState(''); const [editTags,setEditTags]=useState('');
  const [searching,setSearching]=useState(false); const [query,setQuery]=useState(''); const [filterType,setFilterType]=useState(''); const [filterTag,setFilterTag]=useState('');
  const [results,setResults]=useState<ChatMessage[]>([]); const [hasMore,setHasMore]=useState(false); const [searchBusy,setSearchBusy]=useState(false); const [searchError,setSearchError]=useState('');
  const searchGeneration=useRef(0); const targetItem=useRef<string|null>(null);
  const fileInput=useRef<HTMLInputElement>(null); const draftInput=useRef<HTMLTextAreaElement>(null); const endRef=useRef<HTMLDivElement>(null); const follow=useRef(true);
  useEffect(()=>{fetch('/api/me',{cache:'no-store'}).then(r=>r.json() as Promise<{signedIn:boolean;user:User;linkRequired?:boolean}>).then(data=>{if(data.signedIn)setUser(data.user);if(data.linkRequired)setLinkRequired(true);}).catch(()=>{}).finally(()=>setChecking(false));},[]);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let running = false;
    async function sync() {
      if (running || controller.signal.aborted || document.hidden) return;
      running = true; clearTimeout(timer);
      try {
        const options = { cache: "no-store" as const, signal: controller.signal };
        const [spacesResponse, messagesResponse] = await Promise.all([
          fetch("/api/conversations", options),
          selected ? fetch(`/api/messages?conversation_id=${encodeURIComponent(selected)}`, options) : Promise.resolve(null),
        ]);
        if (!spacesResponse.ok || (messagesResponse && !messagesResponse.ok)) throw new Error("SYNC_FAILED");
        const spaces = await spacesResponse.json() as { conversations: Space[] };
        const history = messagesResponse ? await messagesResponse.json() as { messages: ChatMessage[] } : null;
        if (controller.signal.aborted) return;
        setConversations(spaces.conversations);
        setSelected(current => current || spaces.conversations[0]?.id || "");
        if (history) setMessages(history.messages);
        setSyncError("");
      } catch {
        if (!controller.signal.aborted) setSyncError("Sync paused. Retrying…");
      } finally {
        running = false;
        if (!controller.signal.aborted) timer = setTimeout(() => void sync(), 3000);
      }
    }
    const resume = () => { if (!document.hidden) void sync(); };
    void sync();
    window.addEventListener("focus", resume); window.addEventListener("online", resume); document.addEventListener("visibilitychange", resume);
    return () => {
      controller.abort(); clearTimeout(timer);
      window.removeEventListener("focus", resume); window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume);
    };
  }, [user, selected, refreshVersion]);
  useEffect(()=>{
    if(searching)return;
    if(targetItem.current&&messages.some(m=>m.id===targetItem.current)){document.getElementById(`item-${targetItem.current}`)?.scrollIntoView({block:'center'});targetItem.current=null;}
    else if(follow.current && !['picture','video'].includes(conversations.find(s=>s.id===selected)?.kind ?? ''))endRef.current?.scrollIntoView({block:'end'});
  },[messages,searching]);
  useEffect(()=>{
    if(!searching || !user)return;
    const generation=++searchGeneration.current;
    const controller=new AbortController(); setSearchBusy(true); setSearchError(''); setResults([]);
    async function search() {
      const p = new URLSearchParams({q:query,type:filterType,tag:filterTag});
      try {
        while (!controller.signal.aborted) {
          const response = await fetch(`/api/organizer?${p}`, {cache:'no-store', signal:controller.signal});
          const data = await response.json() as {messages:ChatMessage[];hasMore:boolean;indexing?:boolean;error?:string};
          if (!response.ok) throw new Error(data.error);
          if (controller.signal.aborted) return;
          if (data.indexing) continue;
          setResults(data.messages); setHasMore(data.hasMore);
          break;
        }
      } catch (error) {
        if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : 'Search failed.');
      } finally {
        if (!controller.signal.aborted) setSearchBusy(false);
      }
    }
    const timer=setTimeout(() => void search(), 250);
    return ()=>{clearTimeout(timer);controller.abort();if(searchGeneration.current===generation)searchGeneration.current++;};
  },[user,searching,query,filterType,filterTag,refreshVersion]);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    let running = false;
    async function poll() {
      if (running || document.hidden) return;
      running = true;
      try {
        const response = await fetch('/api/social', {cache:'no-store',signal:controller.signal});
        if (!response.ok) throw new Error();
        const data = await response.json() as SocialState;
        if (controller.signal.aborted) return;
        const previous = previousSocial.current;
        previousSocial.current = data;
        setSocial(data);
        if (!previous) return;
        const incoming = data.requests.find(r => r.incoming && !previous.requests.some(old => old.id===r.id));
        if (incoming) setAlert({text:`${incoming.name} sent a friend request.`});
        const unread = data.chats.find(c => c.unread && c.latestSender !== user?.id &&
          !(section==='chats' && selected===c.id && !searching) &&
          c.latestId!==previous.chats.find(old=>old.id===c.id)?.latestId);
        if (!incoming && unread) setAlert({text:`${unread.name} · ${unread.unread > 1 ? unread.unread + ' unread messages' : unread.summary ?? 'New message'}`,chat:unread.id});
      } catch {
        // Retry on the next poll.
      } finally { running = false; }
    }
    const interval = setInterval(poll,3000);
    document.addEventListener('visibilitychange',poll);
    void poll();
    return ()=>{controller.abort();clearInterval(interval);document.removeEventListener('visibilitychange',poll);};
  }, [user,selected,section,searching,refreshVersion]);

  useEffect(() => {
    if (section!=='chats' || searching || !selected.startsWith('friend_')) return;
    const latest = [...messages].reverse().find(message=>message.senderId!==user?.id);
    if (!latest || latest.conversationId!==selected) return;
    const read = () => {
      if (document.hidden || lastRead.current===latest.id) return;
      lastRead.current=latest.id;
      void api({action:'read',chatId:selected,messageId:latest.id}, '/api/social').catch(()=>{
        if(lastRead.current===latest.id)lastRead.current='';
      });
    };
    read();
    document.addEventListener('visibilitychange',read);
    return ()=>document.removeEventListener('visibilitychange',read);
  }, [messages,selected,section,searching,user]);

  async function api<T>(body: unknown, endpoint = '/api/organizer'):Promise<T> {
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json() as T & {error?:string}; if(!response.ok)throw new Error(data.error ?? 'Unable to finish. Please retry.');return data;
  }
  async function run(action:()=>Promise<void>) {
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');
    try{await action();}catch(e){setError(e instanceof Error?e.message:'Connection failed. Please retry.');}
    finally{lock.current=false;setBusy(false);setUpload(null);setBatch(null);}
  }
  function refresh(){setRefreshVersion(v=>v+1);}
  function selectSpace(id:string, closeNavigation = true){
    if (lock.current) return;
    if(id!==selected){
      drafts.current.set(selected,{draft,files,caption,tags,details});
      const next=drafts.current.get(id);
      setDraft(next?.draft ?? '');setFiles(next?.files ?? []);setCaption(next?.caption ?? '');setTags(next?.tags ?? '');setDetails(next?.details ?? false);
      setMessages([]);setSelected(id);follow.current=true;
    }
    setSection(id.startsWith('friend_') ? 'chats' : 'files');setSearching(false);if(closeNavigation)setMobileNav(false);setMenu(false);setError('');}
  function openSearch(text='',tag=''){setQuery(text);setFilterTag(tag);setFilterType('');setSearching(true);setMenu(false);setMobileNav(false);}
  const active=conversations.find(s=>s.id===selected); const inbox=conversations.find(s=>s.kind==='default'); const direct = social?.chats.find(chat=>chat.id===selected);
  const inInbox = section==='files' && active?.kind==='default';
  const fileSpace = section==='files' && Boolean(active && active.kind !== 'default' && active.kind !== 'archive');
  const writable = inInbox || fileSpace || (section==='chats' && Boolean(direct));
  const destinations = conversations.filter(space => space.kind !== 'archive');
  const incomingCount = social?.requests.filter(r=>r.incoming).length ?? 0;
  const chatCount = incomingCount + (social?.chats.reduce((sum,chat)=>sum+chat.unread,0) ?? 0);
  function showChats(closeNavigation = true) {
    if(lock.current)return;
    if (social?.chats[0]) selectSpace(direct?.id ?? social.chats[0].id, closeNavigation);
    else { setSection('chats');setSearching(false);if(closeNavigation)setMobileNav(false); }
  }
  async function friendAction(action: string, id?: string) {
    if (lock.current) return;
    setSocialError('');
    let accepted = false;
    await run(async()=>{
      try {
        await api({action,id,code:friendCode}, '/api/social');
        if(action==='invite'){setFriendCode('');setNotice('Friend request sent.');}
        if(action==='accept' && id){setFriendPanel(false);accepted=true;}
        if(action==='save')setNotice('Saved a copy to Inbox.');
        refresh();
      } catch (error) {
        if(action==='save')throw error;
        setSocialError(error instanceof Error ? error.message : 'Please retry.');
      }
    });
    if(accepted && id)selectSpace('friend_'+id);
  }
  function command(text:string){
    void run(async()=>{
      const parsed=parseCommand(text);if(!parsed)return;
      if(!inInbox)throw new Error('Commands only work in Inbox.');
      if(files.length || caption || tags)throw new Error('Send or remove the staged attachments, caption and tags before running a command.');
      if(parsed.action==='search'){openSearch(parsed.query);setDraft('');return;}
      const value=await api<CommandPreview>({action:'preview',sourceId:selected,command:parsed.action,type:parsed.action==='move'?parsed.type:'all'});
      sortBeforeClear.current=false;setPreview(value);setDraft('');setMenu(false);
    });
  }
  function stageFiles(incoming: FileList | File[]) {
    if (lock.current || !writable || searching || !incoming.length) return;
    const candidates = Array.from(incoming);
    const accepted = candidates.filter(file => file.size <= 10 * 1024 * 1024);
    const staged = accepted.map(file => {
      const src = URL.createObjectURL(file);
      objectUrls.current.add(src);
      return { file, src, id: crypto.randomUUID() };
    });
    setFiles(current => [...current, ...staged]);
    setNotice('');
    const rejected = candidates.length - accepted.length;
    setError(rejected ? `${rejected} ${rejected === 1 ? 'file exceeds' : 'files exceed'} the 10 MB limit.` : '');
  }
  function paste(event: ClipboardEvent<HTMLElement>) {
    if (!writable || searching || lock.current) return;
    const incoming = Array.from(event.clipboardData.files);
    if (!incoming.length) {
      for (const item of event.clipboardData.items) {
        const file = item.kind === 'file' ? item.getAsFile() : null;
        if (file) incoming.push(file);
      }
    }
    if (!incoming.length) return;
    event.preventDefault();
    stageFiles(nameClipboardImages(incoming));
  }
  async function pasteMedia() {
    try {
      if (!navigator.clipboard?.read) throw new Error();
      const incoming: File[] = [];
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(mime => /^(image|video|audio)\//.test(mime));
        if (!type) continue;
        const blob = await item.getType(type);
        incoming.push(new File([blob], 'clipboard.' + (type.split('/')[1].replace('jpeg', 'jpg').split('+')[0]), { type }));
      }
      if (!incoming.length) { setError('No supported media found. You can also attach a file.'); return; }
      stageFiles(nameClipboardImages(incoming));
    } catch { setError('Clipboard media is unavailable. Try pasting directly or attach a file.'); }
  }
  function removeFile(staged: StagedFile) {
    URL.revokeObjectURL(staged.src);
    objectUrls.current.delete(staged.src);
    setFiles(current => current.filter(item => item.id !== staged.id));
  }
  function handleDrag(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const allowed = writable && !searching && !lock.current;
    if (event.type === 'drop') {
      dragDepth.current = 0;
      setDragging(false);
      if (allowed) stageFiles(event.dataTransfer.files);
    } else if (event.type === 'dragover') {
      event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
    } else if (event.type === 'dragenter') {
      dragDepth.current++;
      if (allowed) setDragging(true);
    } else {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    }
  }
  function send(event: FormEvent){
    event.preventDefault();
    if (inInbox && txtMode) {
      if (!draft.trim()) return;
      void run(async () => {
        await storeText(txtName, draft, caption, tags);
        setDraft(''); setTxtName(''); setCaption(''); setTags(''); setDetails(false);
        refresh(); setNotice('TXT saved.');
      });
      return;
    }
    if(inInbox && draft.trim().startsWith('/')){command(draft);return;}
    if(!writable || (fileSpace ? !files.length : !draft.trim() && !files.length))return;
    void run(async()=>{
      const parsedTags=normalizeTags(tags.split(',').map(t=>t.trim()).filter(Boolean));
      const queue = files.length ? files : [null];
      let saved = 0;
      try {
        for (const staged of queue) {
          if (staged) setBatch({ current: saved + 1, total: queue.length });
          const form = new FormData();
          form.set('conversation_id', selected);
          form.set('body', !fileSpace && saved === 0 ? draft : '');
          if (fileSpace) form.set('save_to_space', '1');
          form.set('caption', caption);
          form.set('tags', JSON.stringify(parsedTags));
          if (staged) form.set('file', staged.file);
          await uploadMessage(form, setUpload);
          saved++;
          setDraft('');
          if (staged) removeFile(staged);
        }
      } catch (error) {
        if (saved) setNotice(`Saved ${saved} of ${queue.length} files. The remaining files are ready to retry.`);
        throw error;
      } finally {
        if (saved) { follow.current = true; refresh(); }
      }
      setCaption('');setTags('');setDetails(false);
      setNotice(fileSpace ? `Saved to ${active?.title}.` : direct ? (files.length > 1 ? `Sent ${files.length} files.` : 'Sent.') : files.length > 1 ? `Saved ${files.length} files to Inbox.` : 'Saved to Inbox.');
    });
  }
  async function storeText(name: string, text: string, description: string, tagText: string) {
    const base = name.trim() || txtFilename();
    const filename = /\.txt$/i.test(base) ? base : base + '.txt';
    if (filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(filename)) throw new Error('Enter a valid TXT filename.');
    const file = new File([text], filename, { type: 'text/plain' });
    if (file.size > 65536) throw new Error('Editable TXT files can be up to 64 KB.');
    const form = new FormData();
    form.set('conversation_id', selected);
    form.set('file', file);
    form.set('caption', description);
    form.set('tags', JSON.stringify(normalizeTags(tagText.split(','))));
    await uploadMessage(form, setUpload);
  }
  function editText(message: ChatMessage) {
    const id = message.attachmentId!;
    void run(async () => {
      const response = await fetch(fileUrl(id, true));
      const etag = response.headers.get('ETag');
      if (!response.ok || !etag) throw new Error('Could not open this TXT for editing.');
      setTxtEditor({ text: await response.text(), attachmentId: id, etag });
      setFileViewer(null); setMedia(null);
    });
  }
  function saveTextEditor(event: FormEvent) {
    event.preventDefault();
    if (!txtEditor) return;
    void run(async () => {
      const response = await fetch(fileUrl(txtEditor.attachmentId), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': txtEditor.etag },
        body: JSON.stringify({ text: txtEditor.text }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not save this TXT.');
      setTxtEditor(null); refresh(); setNotice('TXT saved.');
    });
  }
  function convertText() {
    if (!txtConversion) return;
    void run(async () => {
      await api({ action:'convert-txt', messageId:txtConversion.id });
      setTxtConversion(null); refresh(); setNotice('Message converted to TXT.');
    });
  }
  function openShare(attachment?: DownloadItem) {
    setFileViewer(null); setMedia(null); setShares({ attachments: attachment ? [attachment] : undefined });
  }
  function fileSelection(message: ChatMessage) {
    const id = message.attachmentId;
    if (!selectingFiles || section !== 'files' || !id || !message.canManageFile) return null;
    const name = message.filename ?? 'File';
    const checked = selectedFiles.some(file => file.id === id);
    return <label className="share-file-check" data-select-file={id} data-select-name={name}>
      <input type="checkbox" aria-label={`Select ${name}`} checked={checked}
        disabled={!checked && selectedFiles.length >= MAX_DOWNLOAD_FILES}
        onChange={event => {
          const selected = event.target.checked;
          setSelectedFiles(files => selected ? [...files, { id, name }] : files.filter(file => file.id !== id));
        }}/>
    </label>;
  }
  function previewActions(message: ChatMessage | null) {
    if (!message?.canManageFile || !message.attachmentId) return null;
    const attachment = { id: message.attachmentId, name: message.filename ?? 'File' };
    return <div className="file-actions preview-extra">
      {/\.txt$/i.test(attachment.name) && (message.bytes ?? 0) <= 65536 && <button disabled={busy} onClick={() => editText(message)}>Edit TXT</button>}
      <button disabled={busy} onClick={() => openShare(attachment)}>Share download</button>
    </div>;
  }
  function inspect(message: ChatMessage) {
    if (!message.attachmentId) return;
    setViewerMessage(message);
    setFileViewer({ name: message.filename ?? 'File', type: message.contentType,
      src: fileUrl(message.attachmentId, true), download: fileUrl(message.attachmentId) });
  }
  function manage(message: ChatMessage, action: FileAction['action']) {
    setError('');
    setFilename(message.filename ?? '');
    setFileAction({ message, action });
  }
  function saveFileAction(event: FormEvent) {
    event.preventDefault();
    if (!fileAction) return;
    const { message, action } = fileAction;
    void run(async () => {
      await api({ action, attachmentId: message.attachmentId, filename });
      setFileAction(null);
      setMedia(null);
      setNotice(action === 'rename' ? 'File renamed.' : 'File deleted.');
      refresh();
    });
  }
  async function copyMessageText(body: string) {
    setError(''); setNotice('');
    try {
      await navigator.clipboard.writeText(body);
      setNotice('Text copied.');
    } catch {
      setError('Could not copy automatically. Select the message text to copy it.');
    }
  }
  function confirmDeleteText() {
    if (!textToDelete) return;
    void run(async () => {
      await api({ action:'delete-inbox-text', messageId:textToDelete.id, confirmed:true });
      setTextToDelete(null);
      refresh(); setNotice('Message deleted.');
    });
  }
  function renderCard(message: ChatMessage, open?: () => void) {
    const chat = message.conversationId.startsWith('friend_');
    if(chat && !message.attachmentId && !message.body && !message.caption && !message.tags.length) return null;
    const inboxText = message.conversationId === inbox?.id && Boolean(message.body) && !message.attachmentId;
    return <MessageCard selection={fileSelection(message)}
      copyText={inboxText ? () => void copyMessageText(message.body) : undefined}
      deleteText={inboxText && message.canManageFile ? () => {setError('');setTextToDelete(message);} : undefined}
      chat={chat} save={chat && message.attachmentId ? ()=>void friendAction('save',message.attachmentId!) : undefined} key={message.id} message={message} edit={()=>{setMedia(null);edit(message);}}
      search={tag=>{setMedia(null);if(chat && inbox)selectSpace(inbox.id);openSearch('',tag);}} open={open} inspect={()=>inspect(message)} manage={action=>manage(message,action)}
      share={!media && message.canManageFile && message.attachmentId ? () => openShare({ id: message.attachmentId!, name: message.filename ?? 'File' }) : undefined}
      asText={!chat && message.body && message.canManageFile && !message.attachmentId ? () => {
        setError(''); setTxtConversion(message);
      } : undefined} />;
  }
  function confirm(){if(!preview)return;void run(async()=>{const result=await api<CommandPreview>({action:'confirm',token:preview.token,confirmed:true});if(result.action==='move'&&sortBeforeClear.current){sortBeforeClear.current=false;setPreview(await api<CommandPreview>({action:'preview',sourceId:inbox?.id,command:'clear'}));}else setPreview(null);refresh();setNotice(result.action==='clear'?`Cleared ${result.count} items from Inbox. Other spaces are unchanged.`:`Moved ${result.count} ${result.count===1?'item':'items'}. ${result.remaining} ${result.remaining===1?'item remains':'items remain'} in Inbox.`);});}
  function autoSort(){void run(async()=>{sortBeforeClear.current=true;setPreview(await api<CommandPreview>({action:'preview',sourceId:inbox?.id,command:'move',type:'all'}));});}
  function edit(message:ChatMessage){setEditing(message);setEditCaption(message.caption);setEditTags(message.tags.join(', '));setError('');}
  function saveAnnotation(event:FormEvent){event.preventDefault();if(!editing)return;void run(async()=>{await api({action:'annotate',messageId:editing.id,caption:editCaption,tags:editTags.split(',').map(t=>t.trim()).filter(Boolean)});setEditing(null);refresh();});}
  async function loadMore(){if(searchBusy)return;const generation=searchGeneration.current;setSearchBusy(true);try{const p=new URLSearchParams({q:query,type:filterType,tag:filterTag,offset:String(results.length)});const r=await fetch(`/api/organizer?${p}`,{cache:'no-store'});const data=await r.json() as {messages:ChatMessage[];hasMore:boolean;error?:string};if(!r.ok)throw new Error(data.error);if(generation!==searchGeneration.current)return;setResults(current=>[...current,...data.messages.filter(m=>!current.some(old=>old.id===m.id))]);setHasMore(data.hasMore);}catch(e){if(generation===searchGeneration.current)setSearchError(e instanceof Error?e.message:'Search failed.');}finally{if(generation===searchGeneration.current)setSearchBusy(false);}}
  if(checking)return <main className="loading-screen">Opening ChatHub…</main>;
  if(!user)return <Login linkRequired={linkRequired}/>;
  const mediaFolder = active?.kind === 'picture' || active?.kind === 'video';
  const gallery = mediaFolder ? messages.filter(message => {
    const kind = filePreview(message.contentType)?.kind;
    return message.attachmentId && (kind === 'image' || kind === 'video');
  }) : [];
  const galleryIds = new Set(gallery.map(message => message.id));
  return <main className="app-shell live-shell organizer-shell">
    {mobileNav&&<button className="nav-shade" aria-label="Close spaces" onClick={()=>setMobileNav(false)}/>}
    <aside className={`conversation-list ${mobileNav?'nav-open':''}`}>
      <div className="list-brand"><span className="brand-mark">C</span><span><strong>ChatHub</strong><small>{user.displayName}</small></span><button className="icon-button nav-close" aria-label="Close spaces" onClick={()=>setMobileNav(false)}><X/></button></div>
      <div className="sidebar-tabs" aria-label="Navigation">
        <button aria-pressed={section==='chats'} disabled={busy} onClick={()=>showChats(false)}><MessageCircle/> Chats {chatCount>0&&<span>{chatCount}</span>}</button>
        <button aria-pressed={section==='files'} disabled={busy} onClick={()=>{if(inbox)selectSpace(inbox.id,false);}}><FileText/> Files</button>
      </div>
      {section==='chats'? <nav className="conversation-scroll" aria-label="Chats">
        <button className="conversation-row" disabled={busy} onClick={()=>{setFriendPanel(true);setSocialError('');setMobileNav(false);}}><span className="workspace-avatar"><Users/></span><span className="conversation-copy"><strong>Friends</strong><small>Add a friend or review requests</small></span>{incomingCount>0&&<span className="space-count">{incomingCount}</span>}</button>
        {social?.chats.map(chat=><button className={`conversation-row ${selected===chat.id?'selected':''}`} key={chat.id} disabled={busy} onClick={()=>selectSpace(chat.id)}>
          <span className="workspace-avatar"><MessageCircle/></span><span className="conversation-copy"><strong>{chat.name}</strong><small>{chat.summary ?? 'Start a conversation'}</small></span>{chat.unread>0&&<span className="space-count">{chat.unread}</span>}
        </button>)}
      </nav>: <nav className="conversation-scroll" aria-label="Spaces">
        <button className="conversation-row" onClick={()=>{setMobileNav(false);setTransfersOpen(true);}}>
          <span className="workspace-avatar"><Paperclip/></span><span className="conversation-copy"><strong>Temporary Transfers</strong><small>Share large files</small></span>
        </button>{conversations.map(space=>{const Icon=icons[space.kind]??Inbox;return <button className={`conversation-row ${space.id===selected&&!searching?'selected':''}`} aria-current={space.id===selected&&!searching?'page':undefined} key={space.id} disabled={Boolean(upload)} onClick={()=>selectSpace(space.id)}><span className="workspace-avatar"><Icon/></span><span className="conversation-copy"><strong>{space.title}</strong><small>{space.kind==='default'?'Capture & run commands':space.kind==='archive'?'Existing saved content':'Organized content'}</small></span><span className="space-count">{space.count}</span></button>;})}</nav>}
      {section==='files'&&<div className="space-guide"><Terminal/><p>Capture in Inbox.<br/>Type <b>/</b> to organize or search.</p><small>Type spaces appear when you move content.</small></div>}
      <div className="list-footer"><a className="chat-account-link" href={appPath("/account/")}><Settings2/> Account & security</a></div>
    </aside>
    <section className="chat-pane" onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrag} onPaste={paste}>
      {dragging && writable && !searching && <div className="file-drop-overlay"><Paperclip /> Drop files to attach</div>}
      <div className="files-pane-header">
      <header className="chat-header"><button className="icon-button spaces-toggle" aria-label={chatCount ? `Open navigation · ${chatCount} unread` : "Open navigation"} onClick={()=>setMobileNav(true)}><Menu/>{chatCount>0&&<span className="mobile-unread"/>}</button><span className="workspace-avatar">{searching?<Search/>:<Inbox/>}</span><span className="chat-title"><strong>{searching?'Search all spaces':section==='chats'?(direct?.name ?? 'Chats'):(active?.title??'Loading…')}</strong><small>{syncError || (searching?'Find your saved content':section==='chats'?'Private conversations':writable?'Your capture space':'Saved content · no message input')}</small></span>{section==='files' && inbox && <button className="icon-button" aria-label="Sharing links" title="Sharing links" disabled={busy} onClick={() => openShare()}><LinkIcon/></button>}{section==='files'&&<button className="icon-button" aria-label={searching?'Close search':'Search all spaces'} onClick={()=>searching?setSearching(false):openSearch()}>{searching?<X/>:<Search/>}</button>}<a className="chat-account-link" href={appPath("/account/")} aria-label="Account & security"><Settings2/></a></header>
      {section === 'files' && <div className="share-selection-bar">
        {selectingFiles ? <>
          <span className="file-selection-hint">Drag to select</span>
          <span role="status">{selectedFiles.length} / {MAX_DOWNLOAD_FILES} selected</span>
          <button className="account-action" onClick={() => {setSelectingFiles(false);setSelectedFiles([]);}}>Cancel</button>
          <button className="account-action" disabled={busy || !selectedFiles.length}
            onClick={() => setShares({ attachments: selectedFiles })}>Share selected</button>
        </> : <>
          <button className="account-action" onClick={() => setSelectingFiles(true)}>Select files</button>
          <button className="account-action" onClick={() => setTransfersOpen(true)}>Temporary Transfers</button>
        </>}
      </div>}
      </div>
        {alert&&<div className="online-alert" role="status"><button onClick={()=>{if(busy)return;if(alert.chat)selectSpace(alert.chat);else {showChats();setFriendPanel(true);}setAlert(null);}}>{alert.text}</button><button aria-label="Dismiss notification" onClick={()=>setAlert(null)}><X/></button></div>}
      <FileSelectionArea enabled={section==='files' && selectingFiles}
        selected={selectedFiles} onSelection={setSelectedFiles}
        onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;}}>

        {notice&&<p className="inline-notice" role="status">{notice}</p>}
        {error&&(searching||!writable)&&!preview&&!editing&&!fileAction&&!textToDelete&&<p className="send-error" role="alert">{error}</p>}
        {section==='chats'&&!direct ? <div className="empty-space"><MessageCircle/><h1>Chats</h1><p>Add a friend to start a private conversation.</p><button className="account-action" onClick={()=>{setSocialError('');setFriendPanel(true);}}>Add a friend</button></div> : searching?<><form className="search-controls" onSubmit={e=>e.preventDefault()}><label>Search<input autoFocus value={query} onChange={e=>setQuery(e.target.value)} maxLength={300} placeholder="Messages, TXT content, captions or filenames"/></label><div className="search-filters"><label>Type<select value={filterType} onChange={e=>setFilterType(e.target.value)}><option value="">All types</option>{Object.entries(TYPE_LABELS).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label><label>Custom tag<input value={filterTag} onChange={e=>setFilterTag(e.target.value)} maxLength={40} placeholder="e.g. work"/></label></div><small>Search also matches previous filenames and custom tags.</small></form>{searchError&&<p role="alert" className="send-error">{searchError}</p>}<p className="results-label" role="status">{searchBusy&&!results.length?'Searching…':`${results.length}${hasMore?'+':''} ${results.length===1&&!hasMore?'result':'results'}`}</p><div className="saved-stack">{results.map(message=>renderCard(message,()=>{selectSpace(message.conversationId);targetItem.current=message.id;follow.current=false;}))}</div>{hasMore&&<button className="account-action more-results" disabled={searchBusy} onClick={()=>void loadMore()}>{searchBusy?'Loading…':'Load more'}</button>}</>:<>
          {!messages.length && direct && <div className="empty-space"><MessageCircle/><h1>Start a conversation</h1><p>Send a message or attach a file.</p></div>}
          {!messages.length&&!direct&&<div className="empty-space"><Inbox/><h1>{writable?'A little space for everything.':'Nothing here yet.'}</h1><p>{inInbox?'Drop a file, save a link or write a note. Organize it when you’re ready.':fileSpace?'Paste, drop or attach files here.':'Use /move in Inbox to collect content here.'}</p>{inInbox&&<button className="account-action" onClick={()=>setMenu(true)}>Explore commands</button>}</div>}
          {gallery.length > 0 && <div className="media-grid">{[...gallery].reverse().map(message => <div className="selectable-media" key={message.id} id={`item-${message.id}`}>
            {fileSelection(message)}
            <MediaTile src={fileUrl(message.attachmentId!, true)} name={message.filename ?? 'Media'}
              kind={message.contentType?.startsWith('video/') ? 'video' : 'image'}
              open={() => setMedia(message)} />
          </div>)}</div>}
          <div className="saved-stack">{messages.filter(message=>!galleryIds.has(message.id)).map(message=>renderCard(message))}</div><div ref={endRef}/>
        </>}
      </FileSelectionArea>
      {!searching&&writable?<form className="composer-wrap" onSubmit={send} aria-busy={Boolean(upload)}>
        {upload&&<div className="upload-status" role="status" aria-live="polite"><span><LoaderCircle className="spin"/>{batch ? `File ${batch.current} of ${batch.total} · ` : ''}{upload.phase==='saving'?(direct?'Sending…':'Saving to Inbox…'):batch?`Uploading${upload.percent===null?'…':` · ${upload.percent}%`}`:'Sending message…'}</span>{batch&&<progress max={100} value={upload.percent??undefined} aria-label="Upload progress"/>}</div>}
        {error&&!preview&&!editing&&!fileAction&&!textToDelete&&<p className="send-error composer-error" role="alert">{error}</p>}
        {inInbox&&!txtMode&&(menu||draft.startsWith('/'))&&<div className="command-menu" aria-label="Commands">{commands.filter(c=>!draft.startsWith('/')||c.text.startsWith(draft.toLowerCase().split(' ').slice(0,2).join(' '))||draft==='/' ).map(c=><button type="button" key={c.text} disabled={busy} onClick={()=>command(c.text)}><code>{c.text}</code><small>{c.detail}</small></button>)}<button type="button" className="command-dismiss" onClick={()=>{setMenu(false);if(draft.startsWith('/'))setDraft('');}}>Close commands</button></div>}
        {files.length > 0 && <div className="staged-list" aria-label="Files ready to upload">{files.map(staged=><div className="attachment-staged" key={staged.id}>
          {filePreview(staged.file.type)?.kind === 'image' ? <img src={staged.src} alt="" /> : <Paperclip/>}
          <button className="staged-preview" type="button" onClick={()=>{setViewerMessage(null);setFileViewer({ name: staged.file.name, type: staged.file.type, src: staged.src });}}><strong>{staged.file.name}</strong><small>{(staged.file.size/1024/1024).toFixed(2)} MB · Preview</small></button>
          <button className="staged-remove" type="button" disabled={busy} aria-label={`Remove ${staged.file.name}`} onClick={()=>removeFile(staged)}>×</button>
        </div>)}</div>}
        {details&&<div className="capture-details"><label>Caption <span>Optional description</span><input disabled={Boolean(upload)} value={caption} onChange={e=>setCaption(e.target.value)} maxLength={2000} placeholder="What is this? Add words you’ll search for."/></label><label>Custom tags<input disabled={Boolean(upload)} value={tags} onChange={e=>setTags(e.target.value)} placeholder="work, ideas, to-read"/><small>Separate tags with commas.</small></label></div>}
        {inInbox && <div className="composer-modes" aria-label="Inbox input format">
          <button type="button" aria-pressed={!txtMode} disabled={busy} onClick={() => setTxtMode(false)}>Message</button>
          <button type="button" aria-pressed={txtMode} disabled={busy} onClick={() => {setTxtMode(true);setMenu(false);}}>TXT</button>
        </div>}
        {inInbox && txtMode && <div className="txt-options">
          <input aria-label="TXT filename" placeholder="Automatic date and time" value={txtName} disabled={busy} maxLength={251} onChange={e => setTxtName(e.target.value)}/>
        </div>}
        <div className="composer">{inInbox&&!txtMode&&<button type="button" className="icon-button" aria-label="Commands" disabled={busy} onClick={()=>setMenu(v=>!v)}><Terminal/></button>}<button type="button" className="icon-button" aria-label="Attach files" disabled={busy} onClick={()=>fileInput.current?.click()}><Paperclip/></button><input ref={fileInput} type="file" multiple className="hidden-file" onChange={e=>{if(e.target.files)stageFiles(e.target.files);e.target.value='';}}/>{!fileSpace&&<textarea disabled={busy} ref={draftInput} value={draft} onChange={e=>{setDraft(e.target.value);setMenu(false);}} placeholder={inInbox?(txtMode?'Write your TXT…':'Message or /command'):'Message'} aria-label={txtMode&&inInbox?"TXT content":"Message or command"} maxLength={20000} rows={txtMode&&inInbox?3:1} onKeyDown={e=>{if(!(inInbox&&txtMode)&&e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>}
          {inInbox && txtMode ? <button className="account-action" type="submit" disabled={busy || !draft.trim()}>Save TXT</button> :
          <button type="submit" className="send-button icon-button" disabled={busy||(fileSpace?!files.length:!draft.trim()&&!files.length)} aria-label={upload?'Upload in progress':fileSpace?'Save files':'Send message or run command'}>{upload?<LoaderCircle className="spin"/>:<SendHorizontal/>}</button>}</div>
        <div className="composer-bottom"><button type="button" disabled={Boolean(upload)} aria-expanded={details} onClick={()=>setDetails(v=>!v)}>{details?'Hide details':`Add caption & tags${caption||tags?' •':''}`}</button><button type="button" disabled={busy} onClick={()=>void pasteMedia()}>Paste media</button><small>Up to 10 MB per file</small></div>
      </form>:section==='files'?<div className="read-only-footer"><span>{searching?'Search across your file spaces.':'Add new content and run commands in Inbox.'}</span><button className="account-action" onClick={()=>{if(inbox)selectSpace(inbox.id);}}>Back to Inbox</button></div>:<div/>}
    </section>
    {friendPanel&&<Modal title="Friends" close={()=>{if(!busy)setFriendPanel(false);}}>
      <form className="annotation-form" onSubmit={e=>{e.preventDefault();void friendAction('invite');}}>
        <label>Your friend code<input readOnly value={social?.code ?? ''} onFocus={e=>e.target.select()} aria-label="Your friend code"/></label>
        <label>Add a friend<input value={friendCode} onChange={e=>setFriendCode(e.target.value)} placeholder="Enter their ChatHub friend code" maxLength={40} required/></label>
        <button className="auth-submit" disabled={busy||!friendCode.trim()}>Send friend request</button>
      </form>
      {socialError&&<p className="send-error" role="alert">{socialError}</p>}
      {social?.requests.map(request=><div className="friend-request" key={request.id}><strong>{request.name}</strong>
        {request.incoming?<div className="file-actions"><button disabled={busy} onClick={()=>void friendAction('accept',request.id)}>Accept</button><button disabled={busy} onClick={()=>void friendAction('decline',request.id)}>Decline</button></div>:<small>Request sent</small>}
      </div>)}
    </Modal>}
    {media && !fileViewer && !fileAction && <Modal title={media.filename ?? 'Media'} close={()=>setMedia(null)}>
      <FilePreview key={media.attachmentId} file={{ name: media.filename ?? 'Media', type: media.contentType,
        src: fileUrl(media.attachmentId!, true), download: fileUrl(media.attachmentId!) }} />
      {previewActions(media)}{error && <p className="send-error" role="alert">{error}</p>}
      {renderCard(media)}
    </Modal>}
    {fileViewer && <Modal title={fileViewer.name} close={()=>setFileViewer(null)}><FilePreview key={fileViewer.src} file={fileViewer}/>{previewActions(viewerMessage)}{error && <p className="send-error" role="alert">{error}</p>}</Modal>}
    {transfersOpen && <Modal title="Temporary Transfers" close={() => setTransfersOpen(false)}><TemporaryTransfers/></Modal>}
    {shares && <Modal title={shares.attachments ? 'Share download' : 'Sharing links'} close={() => setShares(null)}>
      <ShareLinks attachments={shares.attachments} spaces={destinations} destination={inbox?.id ?? ''}/>
    </Modal>}
    {textToDelete && <Modal title="Delete this message?" close={() => {if (!busy) {setTextToDelete(null); setError('');}}}>
      <p>This permanently deletes the selected Inbox message.</p>
      {error && <p className="send-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="account-action" disabled={busy} onClick={() => {setTextToDelete(null); setError('');}}>Cancel</button>
        <button className="danger-button" disabled={busy} onClick={confirmDeleteText}>{busy ? 'Deleting…' : 'Delete message'}</button>
      </div>
    </Modal>}
    {txtConversion && <Modal title="Convert to TXT?" close={() => {if (!busy) setTxtConversion(null);}}>
      <p>The message will become a TXT file in the same space, with its original date, caption and tags.</p>
      {error && <p className="send-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="account-action" disabled={busy} onClick={() => setTxtConversion(null)}>Cancel</button>
        <button className="auth-submit" disabled={busy} onClick={convertText}>{busy ? 'Converting…' : 'Convert to TXT'}</button>
      </div>
    </Modal>}
    {txtEditor && <Modal title="Edit TXT" close={() => {if (!busy) setTxtEditor(null);}}>
      <form className="annotation-form" onSubmit={saveTextEditor}>
        <label>Text<textarea value={txtEditor.text} maxLength={65536} rows={8} onChange={e => setTxtEditor({...txtEditor, text:e.target.value})}/></label>
        {error && <p className="send-error" role="alert">{error}</p>}
        <button className="auth-submit" disabled={busy}>{busy ? 'Saving…' : 'Save TXT'}</button>
      </form>
    </Modal>}
    {fileAction && <Modal title={fileAction.action === 'rename' ? 'Rename file' : 'Delete file?'} close={()=>{if(!busy){setFileAction(null);setError('');}}}>
      <form className="annotation-form" onSubmit={saveFileAction}>
        {fileAction.action === 'rename' ? <label>Filename<input value={filename} onChange={e=>setFilename(e.target.value)} maxLength={255} required disabled={busy}/></label>
          : <p>Permanently delete <strong>{fileAction.message.filename}</strong>? Any saved message text, caption and tags will be kept.</p>}
        {error && <p role="alert" className="send-error">{error}</p>}
        <div className="dialog-actions"><button type="button" className="account-action" disabled={busy} onClick={()=>{setFileAction(null);setError('');}}>Cancel</button>
          <button className={fileAction.action === 'delete' ? 'danger-button' : 'auth-submit'} disabled={busy}>{fileAction.action === 'delete' ? 'Delete file' : 'Save name'}</button></div>
      </form>
    </Modal>}
    {preview&&<Modal title={preview.action==='clear'?'Clear Inbox?':'Move content?'} close={()=>{if(!busy)setPreview(null);}}><p>{preview.count} {preview.count===1?'item':'items'} · {preview.files} {preview.files===1?'attachment':'attachments'}</p>{preview.action==='clear'?<><p>This permanently removes these items and their attachments from Inbox. Other spaces are not affected. New items received after this preview stay safe.</p>{preview.remaining>0&&<p>This preview covers the first {preview.count} items. {preview.remaining} more items stay in Inbox; run /clear again to review them.</p>}<button className="account-action" disabled={busy} onClick={autoSort}>Sort first with /move all</button></>:<><ul>{Object.entries(preview.groups).map(([kind,count])=><li key={kind}>{count} → {TYPE_LABELS[kind as ContentType]}</li>)}</ul><p>{preview.remaining} {preview.remaining===1?'item stays':'items stay'} in Inbox. Text-only notes stay here. Captions, tags and attachments move together.</p></>}{error&&<p role="alert" className="send-error">{error}</p>}<div className="dialog-actions"><button className="account-action" disabled={busy} onClick={()=>setPreview(null)}>Cancel</button><button className={preview.action==='clear'?'danger-button':'auth-submit'} disabled={busy||!preview.count} onClick={confirm}>{busy?'Working…':preview.action==='clear'?'Clear these items':'Confirm move'}</button></div></Modal>}
    {editing&&<Modal title="Caption & custom tags" close={()=>{if(!busy)setEditing(null);}}><form className="annotation-form" onSubmit={saveAnnotation}><label>Caption<textarea value={editCaption} onChange={e=>setEditCaption(e.target.value)} maxLength={2000} rows={4} placeholder="Describe this content in your own words."/></label><label>Custom tags<input value={editTags} onChange={e=>setEditTags(e.target.value)} placeholder="work, ideas, to-read"/><small>Up to 20 tags. Separate with commas. Type tags are automatic.</small></label>{error&&<p className="send-error" role="alert">{error}</p>}<button className="auth-submit" disabled={busy}>{busy?'Saving…':'Save details'}</button></form></Modal>}
  </main>;
}
