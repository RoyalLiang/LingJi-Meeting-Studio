import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';

const paths=['package.json','package-lock.json','apps/web','apps/desktop/package.json','apps/desktop/src-tauri','apps/desktop/assets','scripts','tools/neohorse','services/records/src','packages/records/src','services/session-gateway/src/providers/doubao-ast-codec.mjs','services/session-gateway/src/providers/doubao-ast/protos','docs/releases'];
export const releaseHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function readReleaseSource(root,ref,path){
  if(ref){assert.match(ref,/^[a-f0-9]{40}$/);return execFileSync('git',['show',`${ref}:${path}`],{cwd:root,maxBuffer:8*1024*1024});}
  return readFile(join(root,path));
}
export async function snapshotReleaseSource({root,ref=null,destination}){
  if(ref)assert.match(ref,/^[a-f0-9]{40}$/);
  const args=ref?['ls-tree','-r','--name-only','-z',ref,'--',...paths]:['ls-files','--cached','--others','--exclude-standard','-z','--',...paths];
  const entries=execFileSync('git',args,{cwd:root,maxBuffer:8*1024*1024}).toString().split('\0').filter(Boolean).sort();
  const files=[];
  for(const path of entries){
    if(path.split('/').some(part=>['.DS_Store','node_modules','target','.agent-runtime'].includes(part))||/(^|\/)\.env(?:\.|$)/.test(path))continue;
    let bytes;try{bytes=await readReleaseSource(root,ref,path);}catch(error){if(error.code!=='ENOENT')throw error;bytes=null;}
    files.push({path,sha256:bytes===null?null:releaseHash(bytes)});
    if(destination&&bytes!==null){const target=join(destination,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);}
  }
  return {sha256:releaseHash(JSON.stringify(files)),files};
}
