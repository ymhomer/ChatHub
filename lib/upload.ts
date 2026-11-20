import { backendPath, standalone } from "./site-urls";
export type UploadState = { phase: 'uploading' | 'saving'; percent: number | null };
/** Multipart transport with real browser upload progress and readable non-JSON errors. */
export function uploadMessage(form: FormData, onProgress: (state: UploadState) => void, makeRequest = () => new XMLHttpRequest()): Promise<{ id: string; attachmentId: string | null }> {
  return new Promise((resolve,reject) => {
    const xhr=makeRequest();
    xhr.open('POST', backendPath('/api/messages'));
    if (standalone) xhr.withCredentials = true;
    xhr.timeout=180_000;
    xhr.setRequestHeader('Accept','application/json');
    xhr.upload.onprogress=event=>onProgress({phase:'uploading',percent:event.lengthComputable?Math.min(100,Math.round(event.loaded/event.total*100)):null});
    xhr.upload.onload=()=>onProgress({phase:'saving',percent:100});
    xhr.onerror=()=>reject(new Error('Connection lost. Your file and text are still here. Check your connection and try again.'));
    xhr.ontimeout=()=>reject(new Error('The upload timed out. Your file and text are still here. Check Inbox before retrying.'));
    xhr.onabort=()=>reject(new Error('Upload canceled. Your file and text are still here.'));
    xhr.onload=()=>{
      let data: {id?:string;attachmentId?:string|null;error?:string}={};
      try{data=JSON.parse(xhr.responseText);}catch{/* Framework/proxy errors may be plain text or HTML. */}
      if(xhr.status<200||xhr.status>=300){reject(new Error(xhr.status===413?'The server rejected this upload as too large. Each file must be 10 MB or smaller.':data.error||`Unable to save (HTTP ${xhr.status}). Your file and text are still here.`));return;}
      if(!data.id){reject(new Error('The server did not confirm that the message was saved. Check Inbox before retrying.'));return;}
      resolve({id:data.id,attachmentId:data.attachmentId??null});
    };
    onProgress({phase:'uploading',percent:0});
    xhr.send(form);
  });
}
