import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {deleteRefsWithLease} from './release-ref-lease.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RESET_RELEASE_VERSION,'0.3.0');
const token=process.env.GH_TOKEN;assert.ok(token);const repository=process.env.GITHUB_REPOSITORY;
assert.ok(['royalliang/lingji','royalliang/lingji-meeting-studio'].includes(repository?.toLowerCase()));
const plan=JSON.parse(await readFile(process.env.HISTORY_RESET_PLAN||'tools/release/history-reset-plan.json','utf8')),receipt={releases:[],tags:[],branches:[]};
assert.equal(plan.repositoryId,1416481402);assert.equal(plan.newVersion,'0.3.0');
async function api(path,method='GET'){
 const response=await fetch(`https://api.github.com/repos/${repository}${path}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(45000)});
 if(response.status===404)return null;
 assert.ok(response.ok,`GitHub ${method} ${path}: ${response.status}`);return response.status===204?true:response.json();
}
const identity=await api('');assert.equal(identity.id,plan.repositoryId);
let current=[];for(let page=1;page<=10;page++){const rows=await api(`/releases?per_page=100&page=${page}`);assert.ok(Array.isArray(rows));current.push(...rows);if(rows.length<100)break;assert.ok(page<10,'Release inventory truncated');}
const expectedReleases=new Map(plan.releases.map(item=>[item.id,item]));
for(const release of current.filter(item=>item.tag_name!=='v0.3.0')){const expected=expectedReleases.get(release.id);assert.ok(expected,'Unexpected release: stop before deleting');assert.equal(release.updated_at,expected.updatedAt);assert.equal(release.tag_name,expected.tag);}
const refsToDelete=[];
// Validate the entire plan before the first deletion. Missing entries make retries idempotent.
for(const [kind,list]of [['tags',plan.tags],['heads',plan.branches]])for(const item of list){assert.notEqual(item.name,'main');assert.notEqual(item.name,'v0.3.0');const ref=await api(`/git/ref/${kind}/${encodeURIComponent(item.name)}`);if(ref){assert.equal(ref.object.sha,item.sha,`Changed ref ${kind}/${item.name}`);refsToDelete.push({name:`refs/${kind}/${item.name}`,sha:item.sha});}}
await mkdir('.agent-runtime',{recursive:true});
try{
 for(const item of plan.releases){const latest=await api(`/releases/${item.id}`);if(latest){assert.equal(latest.id,item.id);assert.equal(latest.tag_name,item.tag);assert.equal(latest.updated_at,item.updatedAt,'Release changed before deletion');await api(`/releases/${item.id}`,'DELETE');}assert.equal(await api(`/releases/${item.id}`),null);receipt.releases.push(item.id);}
 const origin=new URL(execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'}).trim());
 assert.equal(origin.protocol,'https:');assert.equal(origin.hostname,'github.com');assert.ok(!origin.username&&!origin.password);assert.equal(origin.pathname.replace(/\.git$/,'').toLowerCase(),'/'+repository.toLowerCase());
 const askpass='.agent-runtime/git-askpass.sh';
 await writeFile(askpass,'#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token;; *) printf "%s\\n" "$GH_TOKEN";; esac\n',{mode:0o700});
 const gitEnv={...process.env,GIT_ASKPASS:resolve(askpass),GIT_TERMINAL_PROMPT:'0'};
 deleteRefsWithLease(refsToDelete,{env:gitEnv});
 for(const [kind,list,key]of [['tags',plan.tags,'tags'],['heads',plan.branches,'branches']])for(const item of list){assert.equal(await api(`/git/ref/${kind}/${encodeURIComponent(item.name)}`),null);receipt[key].push(item.name);}
 const control=await api('/git/ref/heads/dev_history_reset_030');if(control){assert.equal(control.object.sha,process.env.GITHUB_SHA);deleteRefsWithLease([{name:'refs/heads/dev_history_reset_030',sha:process.env.GITHUB_SHA}],{env:gitEnv});}
 receipt.completed=true;
}finally{await writeFile('.agent-runtime/history-reset-receipt.json',JSON.stringify(receipt,null,2)+'\n');}
console.log(JSON.stringify({completed:true,releases:receipt.releases.length,tags:receipt.tags.length,branches:receipt.branches.length}));
