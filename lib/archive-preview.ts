const decoder = new TextDecoder();
const limit = 2 * 1024 * 1024;

export async function readArchive(blob: Blob, kind: 'zip' | 'docx' | 'xlsx' | 'pptx') {
  if (blob.size > 10 * 1024 * 1024) throw new Error('Preview size limit exceeded.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end,true)!==0x06054b50) end--;
  if (end < Math.max(0, bytes.length - 65557)) throw new Error('Archive directory unavailable.');
  const count = view.getUint16(end+10,true);
  let cursor = view.getUint32(end+16,true);
  const entries = new Map<string,{offset:number;size:number;packed:number;method:number;flags:number}>();
  for (let i=0;i<count;i++) {
    if (view.getUint32(cursor,true)!==0x02014b50) throw new Error('Invalid archive directory.');
    const nameLength=view.getUint16(cursor+28,true);
    const name=decoder.decode(bytes.subarray(cursor+46,cursor+46+nameLength));
    entries.set(name,{offset:view.getUint32(cursor+42,true),size:view.getUint32(cursor+24,true),
      packed:view.getUint32(cursor+20,true),method:view.getUint16(cursor+10,true),flags:view.getUint16(cursor+8,true)});
    cursor+=46+nameLength+view.getUint16(cursor+30,true)+view.getUint16(cursor+32,true);
  }
  if (kind==='zip') return [...entries.keys()].slice(0,500).join('\n') || 'Empty archive';
  async function xml(name: string) {
    const entry=entries.get(name);
    if (!entry || entry.size>limit || (entry.flags&1)) throw new Error('Document preview unavailable.');
    const {offset}=entry;
    if (view.getUint32(offset,true)!==0x04034b50) throw new Error('Invalid archive entry.');
    const start=offset+30+view.getUint16(offset+26,true)+view.getUint16(offset+28,true);
    const data=bytes.slice(start,start+entry.packed);
    let content: string;
    if (entry.method===0 && data.length<=limit) content=decoder.decode(data);
    else if (entry.method===8) {
      const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const chunks: string[]=[];
      const streamDecoder=new TextDecoder();
      let length=0;
      try {
        for (;;) {
          const next=await reader.read();
          if(next.done)break;
          length+=next.value.length;
          if(length>limit)throw new Error('Document preview limit exceeded.');
          chunks.push(streamDecoder.decode(next.value,{stream:true}));
        }
      } finally { await reader.cancel(); }
      content=chunks.join('')+streamDecoder.decode();
    } else throw new Error('Compression type unsupported.');
    return new DOMParser().parseFromString(content,'application/xml');
  }
  const nodes=(root:Document|Element,name:string)=>Array.from(root.getElementsByTagNameNS('*',name));
  const text=(node:Document|Element)=>nodes(node,'t').map(n=>n.textContent??'').join('');
  if(kind==='docx') return nodes(await xml('word/document.xml'),'p').slice(0,400).map(text).join('\n') || 'No extractable text.';
  const pattern=kind==='pptx'?/^ppt\/slides\/slide(\d+)\.xml$/:/^xl\/worksheets\/sheet(\d+)\.xml$/;
  const documents=[...entries.keys()].filter(name=>pattern.test(name)).sort((a,b)=>Number(pattern.exec(a)?.[1])-Number(pattern.exec(b)?.[1]));
  const shared=kind==='xlsx'&&entries.has('xl/sharedStrings.xml')?nodes(await xml('xl/sharedStrings.xml'),'si').map(text):[];
  const sections=[];
  for(const name of documents.slice(0,12)) {
    const doc=await xml(name);
    const title=(kind==='pptx'?'Slide ':'Sheet ')+pattern.exec(name)?.[1];
    const lines=kind==='pptx'?nodes(doc,'p').slice(0,150).map(text):nodes(doc,'row').slice(0,100).map(row=>
      nodes(row,'c').slice(0,24).map(cell=>{
        const value=nodes(cell,'v')[0]?.textContent??'';
        const type=cell.getAttribute('t');
        return (cell.getAttribute('r') ?? '')+': '+(type==='s'?shared[Number(value)]??'':type==='inlineStr'?text(cell):value);
      }).join('    '));
    sections.push(title+'\n'+lines.join('\n'));
  }
  return sections.join('\n\n').slice(0,100000) || 'No extractable content.';
}
