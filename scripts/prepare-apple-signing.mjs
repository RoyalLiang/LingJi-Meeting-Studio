import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';

assert.equal(process.platform,'darwin');
assert.equal(process.env.GITHUB_ACTIONS,'true','Signing keychain setup runs only in GitHub Actions');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','GitHub-hosted macOS runner required');
const directory=join(process.env.RUNNER_TEMP,'lingji-testflight-signing'),keychain=join(directory,'signing.keychain-db'),state=join(directory,'search-list.json');
const security=args=>execFileSync('security',args,{stdio:['ignore','pipe','pipe']});
try{
  if(process.argv[2]==='cleanup'){
    let previous;try{previous=JSON.parse(await readFile(state,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(previous){assert.ok(Array.isArray(previous)&&previous.every(path=>typeof path==='string'));security(['list-keychains','-d','user','-s',...previous]);security(['delete-keychain',keychain]);}
    await rm(directory,{recursive:true,force:true});
  }else{
    const previous=[...security(['list-keychains','-d','user']).toString().matchAll(/"([^"\n]+)"/g)].map(match=>match[1]);
    assert.ok(previous.length,'Existing keychain search list unavailable');
    await mkdir(directory,{recursive:false,mode:0o700});
    await writeFile(state,JSON.stringify(previous),{mode:0o600});
    const password=randomBytes(32).toString('hex');
    security(['create-keychain','-p',password,keychain]);
    security(['set-keychain-settings','-lut','21600',keychain]);security(['unlock-keychain','-p',password,keychain]);
    for(const [prefix,name] of [['APPLE_APP_STORE','application.p12'],['APPLE_INSTALLER','installer.p12']]){
      assert.ok(process.env[`${prefix}_P12_BASE64`]&&process.env[`${prefix}_P12_PASSWORD`],'Signing certificate secret missing');
      const path=join(directory,name);await writeFile(path,Buffer.from(process.env[`${prefix}_P12_BASE64`],'base64'),{mode:0o600});
      security(['import',path,'-k',keychain,'-P',process.env[`${prefix}_P12_PASSWORD`],'-T','/usr/bin/codesign','-T','/usr/bin/productbuild']);
      await rm(path);
    }
    security(['set-key-partition-list','-S','apple-tool:,apple:,codesign:','-s','-k',password,keychain]);
    security(['list-keychains','-d','user','-s',keychain,...previous]);
    assert.ok(process.env.APPLE_TESTFLIGHT_PROFILE_BASE64,'Provisioning profile secret missing');
    const profile=join(directory,'app.provisionprofile');await writeFile(profile,Buffer.from(process.env.APPLE_TESTFLIGHT_PROFILE_BASE64,'base64'),{mode:0o600});await chmod(profile,0o600);
    await writeFile(process.env.GITHUB_ENV,`APPLE_TESTFLIGHT_PROFILE_PATH=${profile}\n`,{flag:'a'});
    console.log('Configured isolated App Store signing keychain');
  }
}catch{
  // Child-process errors can contain password arguments; never echo the error object.
  console.error('Apple signing setup or cleanup failed; certificate values were not logged');process.exitCode=1;
}
