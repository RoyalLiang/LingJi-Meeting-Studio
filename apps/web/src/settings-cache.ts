export function createSettingsCache(generation:()=>number,now:()=>number=Date.now){
 let auth=-1,revision=0;
 const entries=new Map<string,{at:number;revision:number;value?:unknown;pending?:Promise<unknown>}>();
 return {
  invalidate(){revision++;entries.clear();},
  async read<T>(path:string,fetcher:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
   const current=generation();if(auth!==current){auth=current;revision++;entries.clear();}
   signal?.throwIfAborted();let entry=entries.get(path);
   if(!entry||now()-entry.at>3000){
    entry={at:now(),revision};const selected=entry;entries.set(path,entry);
    selected.pending=fetcher().then(value=>{if(auth===current&&revision===selected.revision&&entries.get(path)===selected){selected.value=structuredClone(value);selected.pending=undefined;}return value;}).catch(error=>{if(entries.get(path)===selected)entries.delete(path);throw error;});
   }
   const pending=entry.pending||Promise.resolve(entry.value);
   if(!signal){const value=await pending;if(generation()!==current)throw new DOMException('Session changed','AbortError');return structuredClone(value) as T;}
   return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    pending.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else if(generation()!==current)reject(new DOMException('Session changed','AbortError'));else resolve(structuredClone(value) as T);},error=>{signal.removeEventListener('abort',abort);reject(error);});
   });
  }
 };
}
