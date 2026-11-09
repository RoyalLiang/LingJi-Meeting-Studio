import {finishCurrentBuild} from './wgs-build-contract.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const source=resolve(process.env.WGS_SOURCE_DIRECTORY||'/home/westwell/builds/lingji-preview-20261107/source-240245aa');
assert.equal(process.platform,'linux');assert.equal(process.env.RUNNER_ENVIRONMENT,'self-hosted');
const revision=process.env.TTS_RELEASE_SOURCE_REF;assert.match(revision,/^[a-f0-9]{40}$/);
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
// flock covers checkout, both builds and both before/after source checks.
if(!process.env.TTS_WGS_BUILD_LOCKED){run('flock',['--nonblock',join(source,'.agent-runtime/preview-build.lock'),process.execPath,process.argv[1]],{env:{...process.env,TTS_WGS_BUILD_LOCKED:'1'}});process.exit(0);}
const previousRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
const previousCargo=execFileSync('git',['show','HEAD:apps/desktop/src-tauri/Cargo.toml'],{cwd:source,encoding:'utf8'});
await finishCurrentBuild(source,previousRevision,previousCargo);
assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:source,encoding:'utf8'}).trim(),'','Current WGS checkout has changes; preserve them instead of resetting');
run('git',['fetch','--no-tags','https://github.com/RoyalLiang/lingji.git',revision],{cwd:source});run('git',['checkout','--detach',revision],{cwd:source});
const cache=resolve(source,'..','cache');await mkdir(cache,{recursive:true});
const toolchain=join(cache,'rust-1.92.0');
assert.match(execFileSync(join(toolchain,'bin/rustc'),['--version'],{encoding:'utf8'}),/^rustc 1\.92\.0 /);
await access(join(toolchain,'lib/rustlib/x86_64-pc-windows-msvc/lib'));
const version=JSON.parse(await readFile(join(source,'package.json'))).version;
const args=['run','--rm','--network','host','--cpus','4','--memory','6g','--pids-limit','2048','--user',`${process.getuid()}:${process.getgid()}`,'--mount',`type=bind,src=${source},dst=/work`,'--mount',`type=bind,src=${cache},dst=/cache`,'--mount',`type=bind,src=${toolchain},dst=/opt/rust,readonly`,'-w','/work'];
for(const [name,value]of Object.entries({GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,RUNNER_ENVIRONMENT:'self-hosted',TTS_RELEASE_SOURCE_REF:revision,TTS_WGS_CURRENT_BUILD:'1',TTS_RUNTIME_CACHE:'/cache/runtimes',CARGO_HOME:'/cache/cargo',CARGO_TARGET_DIR:'/cache/target',CARGO_BUILD_JOBS:'4',npm_config_cache:'/cache/npm',XWIN_CACHE_DIR:'/cache/xwin',XDG_CACHE_HOME:'/cache/xdg'}))args.push('--env',`${name}=${value}`);
// These public-input caches contain no model keys or user meeting data.
run('docker',[...args,'lingji-wgs-cross:030','bash','-euc','npm ci && npm run build:web && node scripts/prepare-client-backend.mjs && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --features smoke-test -- --test-threads=1 && cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --features smoke-test && NATIVE_CLIENT_EXECUTABLE=/cache/target/debug/tts-client xvfb-run -a node scripts/test-native-evolution.mjs .agent-runtime/native-evolution-linux.json && node --test tests/records-git-sync.test.mjs tests/records-agent-compaction.test.mjs tests/records-meeting-tasks.test.mjs && node scripts/release-linux-preview.mjs && node scripts/build-wgs-windows.mjs']);
if(process.env.GITHUB_OUTPUT)await writeFile(process.env.GITHUB_OUTPUT,`linux=${join(source,'dist/releases',version,'linux-x64')}\nwindows=${join(source,'dist/wgs-input',version)}\n`,{flag:'a'});
await access(join(source,'dist/wgs-input',version,'wgs-windows-input.json'));
