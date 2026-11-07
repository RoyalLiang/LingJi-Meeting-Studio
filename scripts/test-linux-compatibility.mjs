import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
assert.equal(process.env.GITHUB_ACTIONS,'true','Installation tests require a disposable runner');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','Never replace a developer installation');
assert.match(await readFile('/etc/os-release','utf8'),/^VERSION_ID="24\.04"$/m);
const directory=resolve(process.argv[2]),output=resolve(process.argv[3]),metadata=JSON.parse(await readFile(join(directory,'release-linux-x64.json'),'utf8'));
await mkdir(dirname(output),{recursive:true});
const files=(await readdir(directory)).filter(n=>n.endsWith('.deb'));assert.equal(files.length,1);
const packagePath=join(directory,files[0]),bytes=await readFile(packagePath);assert.equal(createHash('sha256').update(bytes).digest('hex'),metadata.sha256);
assert.equal(metadata.sourceRevision,process.env.SOURCE_SHA);assert.equal(metadata.baselineUbuntu,'22.04');
const capture=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',maxBuffer:8*1024*1024}).trim();
const run=(cmd,args,env={})=>new Promise((resolve,reject)=>{const child=spawn(cmd,args,{env:{...process.env,...env},stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${cmd} failed (${code})`)));});
const packageName=capture('dpkg-deb',['-f',packagePath,'Package']);assert.match(packageName,/^[a-z0-9][a-z0-9+.-]+$/);
let installed=false;
try{
  installed=true;await run('sudo',['apt-get','install','-y',packagePath]);
  const packageFiles=capture('dpkg-query',['-L',packageName]).split('\n'),binary=packageFiles.find(p=>p==='/usr/bin/tts-client'),node=packageFiles.find(p=>p.endsWith('/runtime/node'));assert.ok(binary&&node);
  const backend=join(dirname(dirname(node)),'client-backend');
  await run('xvfb-run',['-a',process.execPath,'scripts/test-standalone-package.mjs',output],{NATIVE_CLIENT_EXECUTABLE:binary,TTS_VERIFY_BUNDLED_ASR:'1'});
  await run(node,['scripts/test-bundled-asr.mjs',backend,output.replace(/\.json$/,'.asr.json')]);
  const result=JSON.parse(await readFile(output,'utf8'));result.ubuntuCompatibility={system:'24.04',builtOn:'22.04',packageSha256:metadata.sha256,sourceRevision:metadata.sourceRevision};await writeFile(output,JSON.stringify(result,null,2)+'\n');
}finally{if(installed)await run('sudo',['apt-get','remove','-y',packageName]);}
