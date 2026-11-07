import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

export function deleteRefsWithLease(refs,{cwd,remote='origin',env=process.env}={}){
 if(!refs.length)return;
 for(const ref of refs){
  assert.match(ref.name,/^refs\/(heads|tags)\//);assert.notEqual(ref.name,'refs/heads/main');assert.notEqual(ref.name,'refs/tags/v0.3.0');assert.match(ref.sha,/^[a-f0-9]{40}$/);
  execFileSync('git',['check-ref-format',ref.name],{cwd,env,stdio:'pipe'});
 }
 execFileSync('git',['push','--atomic',...refs.map(ref=>`--force-with-lease=${ref.name}:${ref.sha}`),remote,...refs.map(ref=>`:${ref.name}`)],{cwd,env,stdio:'pipe',timeout:120000});
}
