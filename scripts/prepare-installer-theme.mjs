import {createHash} from 'node:crypto';
import {mkdir,readdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.platform==='win32' && process.argv[1] && await realpath(process.argv[1]).catch(()=>null)===await realpath(fileURLToPath(import.meta.url))){await writeResourceHashes(fileURLToPath(new URL('../apps/desktop/src-tauri/resources',import.meta.url)),fileURLToPath(new URL('../apps/desktop/src-tauri/installer/generated/resource-hashes.nsh',import.meta.url)));execFileSync('pwsh.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./build-installer-theme.ps1',import.meta.url))],{stdio:'inherit'});}

export async function writeResourceHashes(resources, output) {
  const entries=[];
  async function walk(folder,prefix) {
    let files;try{files=await readdir(folder,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const file of files.sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const source=join(folder,file.name),destination=prefix+'\\'+file.name;
      if(file.isDirectory())await walk(source,destination);
      else if(file.isFile()) {
        if(/["$\r\n]/.test(destination))throw new Error('Unsafe installer resource path');
        entries.push([destination,createHash('sha256').update(await readFile(source)).digest('hex')]);
      }
    }
  }
  for(const name of ['client-backend','runtime'])await walk(join(resolve(resources),name),name);
  const lines=['; Generated from packaged resource bytes, not timestamps.','!macro LingJiExpectedHash destination','!define LINGJI_RESOURCE_SHA256 ""'];
  for(const [destination,hash]of entries)lines.push('!if "${destination}" == "'+destination+'"','!undef LINGJI_RESOURCE_SHA256','!define LINGJI_RESOURCE_SHA256 "'+hash+'"','!endif');
  lines.push('!macroend','');await mkdir(join(output,'..'),{recursive:true});await writeFile(output,lines.join('\n'));return entries.length;
}
