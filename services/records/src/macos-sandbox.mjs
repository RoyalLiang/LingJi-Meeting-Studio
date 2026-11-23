import {open,realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {isAbsolute,join,resolve} from 'node:path';
import {requireThat} from '../../../packages/records/src/record.mjs';

const directories=new WeakMap(),require=createRequire(import.meta.url),limit=1024*1024;
export async function installSandboxDirectories(repo,addon=process.env.LINGJI_MACOS_SANDBOX_MODULE?require(process.env.LINGJI_MACOS_SANDBOX_MODULE):undefined){
  if(!addon)return ()=>{};
  let active=new Set(),previous='',pending=Promise.resolve();
  const refresh=async()=>{
    let file,bytes;
    try{
      file=await open(join(repo.root,'directory-bookmarks.json'),'r');
      requireThat((await file.stat()).size<=limit,'invalid_audio_backup_directory',400);
      bytes=await file.readFile({encoding:'utf8'});
      requireThat(Buffer.byteLength(bytes)<=limit,'invalid_audio_backup_directory',400);
    }catch(error){if(error.code!=='ENOENT')throw error;bytes='{}';}finally{await file?.close();}
    if(bytes===previous)return;
    const values=JSON.parse(bytes);
    requireThat(values&&typeof values==='object'&&!Array.isArray(values)&&Object.keys(values).length<=64,'invalid_audio_backup_directory',400);
    requireThat(Object.entries(values).every(([path,data])=>isAbsolute(path)&&path.length<=4096&&typeof data==='string'&&data.length<=262144),'invalid_audio_backup_directory',400);
    const paths=JSON.parse(addon.resolveBookmarks(bytes));
    requireThat(Array.isArray(paths)&&paths.every(path=>typeof path==='string'&&Object.hasOwn(values,path)),'invalid_audio_backup_directory',400);
    active=new Set(await Promise.all(paths.map(path=>realpath(path).catch(()=>resolve(path)))));previous=bytes;
  };
  const synchronize=()=>{const next=pending.then(refresh);pending=next.catch(()=>{});return next;};
  directories.set(repo,async path=>{await synchronize();requireThat(active.has(await realpath(path).catch(()=>resolve(path))),'invalid_audio_backup_directory',400);});
  // A disconnected backup volume must not prevent the rest of the application from starting.
  await synchronize().catch(()=>{});
  return async()=>{await pending;directories.delete(repo);addon.resolveBookmarks('{}');};
}
export async function authorizeSandboxDirectory(repo,path){await directories.get(repo)?.(path);}
