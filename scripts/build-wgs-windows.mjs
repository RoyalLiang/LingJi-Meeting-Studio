import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {access,copyFile,mkdir,mkdtemp,readFile,readdir,writeFile,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {prepareClientBackend} from './prepare-client-backend.mjs';
import {writeResourceHashes} from './prepare-installer-theme.mjs';
import {assertCurrentSource,finishCurrentBuild} from './wgs-build-contract.mjs';
import {releaseHash} from './release-source.mjs';

assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');await access('/.dockerenv');
const root=resolve('.'),revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(revision,process.env.TTS_RELEASE_SOURCE_REF,'WGS must build the requested commit');
const cargoTarget=process.env.CARGO_TARGET_DIR||join(root,'apps/desktop/src-tauri/target');
const source=await assertCurrentSource(root,revision),config=JSON.parse(await readFile('apps/desktop/src-tauri/tauri.preview.conf.json'));
const finalOutput=join(root,'dist/wgs-input',config.version),resources=join(root,'apps/desktop/src-tauri/resources'),cargoInput=await readFile('apps/desktop/src-tauri/Cargo.toml','utf8');
await assert.rejects(access(finalOutput),{code:'ENOENT'},'Never overwrite WGS input');await mkdir(join(root,'dist/wgs-input'),{recursive:true});
const output=await mkdtemp(join(root,'dist/wgs-input','.windows-'));
try{
function run(command,args,options={}){execFileSync(command,args,{cwd:root,stdio:'inherit',env:{...process.env,...options},maxBuffer:8*1024*1024});}
await prepareClientBackend({root,platform:'win32',arch:'x64',cacheRoot:process.env.TTS_RUNTIME_CACHE});
await mkdir('apps/desktop/src-tauri/installer/generated',{recursive:true});
await writeResourceHashes(resources,join(root,'apps/desktop/src-tauri/installer/generated/resource-hashes.nsh'));
const theme=join(root,'.agent-runtime/wgs-installer-theme');
await rm(theme,{recursive:true,force:true});
run('cmake',['-S','apps/desktop/src-tauri/installer/native-ui','-B',theme,'-G','Ninja','-DCMAKE_SYSTEM_NAME=Windows','-DCMAKE_CXX_COMPILER=i686-w64-mingw32-g++-posix','-DCMAKE_RC_COMPILER=i686-w64-mingw32-windres','-DCMAKE_BUILD_TYPE=Release']);
run('cmake',['--build',theme]);
await mkdir('apps/desktop/src-tauri/installer/generated',{recursive:true});await copyFile(join(theme,'lingji-ui.dll'),'apps/desktop/src-tauri/installer/generated/lingji-ui.dll');
run('node',['scripts/installer-background.mjs','--check']);run('npm',['run','build:web']);
await rm(join(cargoTarget,'x86_64-pc-windows-msvc/release/bundle/nsis'),{recursive:true,force:true});
run('npm',['exec','--workspace','@tts/desktop','--','tauri','build','--runner','cargo-xwin','--target','x86_64-pc-windows-msvc','--config','src-tauri/tauri.preview.conf.json','--config','src-tauri/tauri.windows.conf.json','--bundles','nsis'],{TTS_TARGET_PLATFORM:'win32',TTS_TARGET_ARCH:'x64',CARGO_TARGET_DIR:cargoTarget});
const bundle=join(cargoTarget,'x86_64-pc-windows-msvc/release/bundle/nsis'),installers=(await readdir(bundle)).filter(name=>name.endsWith('.exe'));
assert.equal(installers.length,1);await copyFile(join(bundle,installers[0]),join(output,'windows-setup.exe'));await copyFile(join(theme,'lingji-ui-tests.exe'),join(output,'lingji-ui-tests.exe'));
run('tar',['-czf',join(output,'resources.tar.gz'),'-C',resources,'runtime','client-backend']);
await finishCurrentBuild(root,revision,cargoInput);
const files=await Promise.all(['windows-setup.exe','resources.tar.gz','lingji-ui-tests.exe'].map(async name=>{const bytes=await readFile(join(output,name));return {name,bytes:bytes.length,sha256:releaseHash(bytes)};}));
await writeFile(join(output,'wgs-windows-input.json'),JSON.stringify({version:config.version,builder:'wgs',sourceBuildMode:'guarded-current-directory',sourceVerifiedAfterBuild:true,sourceRevision:revision,source,target:'x86_64-pc-windows-msvc',files},null,2)+'\n');
await rename(output,finalOutput);
console.log(JSON.stringify({output:finalOutput,version:config.version,sourceRevision:revision}));
}finally{try{await finishCurrentBuild(root,revision,cargoInput);}finally{await rm(output,{recursive:true,force:true});}}
