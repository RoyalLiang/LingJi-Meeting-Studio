import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

export function successfulCandidate(runs,{tag,sourceRevision,workflowRevision,runId}) {
  return runs.find(run=>String(run.id)!==String(runId)&&(run.event==='workflow_dispatch'||run.event==='push'&&run.head_branch==='main')&&run.conclusion==='success'&&run.head_sha===workflowRevision&&(run.event==='workflow_dispatch'?run.display_title===`Candidate ${tag} · ${sourceRevision}`:sourceRevision===workflowRevision&&run.display_title===`Candidate main · ${sourceRevision}`));
}
export async function verifyPreviewCandidate({repository,tag,sourceRevision,workflowRevision,runId,token,request=fetch}) {
  assert.match(repository,/^[\w.-]+\/[\w.-]+$/);
  assert.match(tag,/^v\d+\.\d+\.\d+(?:\.\d+)?$/);
  for(const sha of [sourceRevision,workflowRevision])assert.match(sha,/^[a-f0-9]{40}$/);
  for(let page=1;page<=10;page++){
    const response=await request(`https://api.github.com/repos/${repository}/actions/workflows/preview-release.yml/runs?per_page=100&page=${page}`,{headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'}});
    assert.ok(response.ok,`Cannot verify candidate runs: HTTP ${response.status}`);
    const {workflow_runs:runs}=await response.json();assert.ok(Array.isArray(runs));
    const candidate=successfulCandidate(runs,{tag,sourceRevision,workflowRevision,runId});if(candidate)return candidate;
    if(runs.length<100)break;
  }
  throw new Error(`No successful candidate for ${tag}, source ${sourceRevision}, controller ${workflowRevision}; run preview-release.yml with publish=false first`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const candidate=await verifyPreviewCandidate({repository:process.env.GITHUB_REPOSITORY,tag:process.env.RELEASE_TAG,sourceRevision:process.env.SOURCE_SHA,workflowRevision:process.env.WORKFLOW_SHA,runId:process.env.GITHUB_RUN_ID,token:process.env.GITHUB_TOKEN});
  console.log(`Verified candidate ${candidate.html_url}`);
}
