import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.platform==='win32')execFileSync('pwsh.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./build-installer-theme.ps1',import.meta.url))],{stdio:'inherit'});
