import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRepository} from '../services/records/src/repository.mjs';
import {createExtensions} from '../services/records/src/integrations/extensions.mjs';
const sha='c'.repeat(40),source='https://git.example.test/team/skills';
const files={'skills/alpha/SKILL.md':'---\nname: alpha\ndescription: Review risks\n---\n# Risk review\n\n**Keep citations**.','skills/beta/SKILL.md':'---\nname: beta\ndescription: Review decisions\n---\n# Decision review\n\n- Preserve edits'};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'lingji-bundles-')),repo=await createRepository({root,databaseUrl:''});let reads=0;
 const request=async(value,options)=>{reads++;assert.equal(options.headers['PRIVATE-TOKEN'],'synthetic-private-token');const u=new URL(value);if(u.pathname.includes('/commits/'))return {status:200,headers:{},text:JSON.stringify({id:sha})};if(u.pathname.endsWith('/tree'))return {status:200,headers:{},text:JSON.stringify(Object.keys(files).map(path=>({name:'SKILL.md',type:'blob',path})))};const path=decodeURIComponent(u.pathname.split('/files/')[1]),body=files[path];return body?{status:200,headers:{},text:JSON.stringify({file_path:path,encoding:'base64',size:Buffer.byteLength(body),content:Buffer.from(body).toString('base64')})}:{status:404,headers:{},text:'{}'};};
 const open=()=>createExtensions(repo,{request,localAccount:true}),extensions=await open();t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});return {repo,extensions,open,reads:()=>reads,input:{provider:'gitlab',source,token:'synthetic-private-token',ref:'main',path:'skills'}};
}
test('private repository token persists across new sessions and different child directories',async t=>{
 const h=await fixture(t);await h.extensions.skillPreview({...h.input,path:'skills/alpha'},'owner');const reopened=await h.open();const preview=await reopened.skillPreview({...h.input,path:'skills/beta',token:''},'owner');assert.equal(preview.name,'beta');assert.equal(preview.hasToken,true);await assert.rejects(reopened.skillPreview({...h.input,path:'skills/beta',token:''},'other'));
});
test('multiple child skills install together and their local details need no repository access',async t=>{
 const h=await fixture(t);const result=await h.extensions.installSkill('owner',{...h.input,paths:['skills/alpha','skills/beta'],expectedVersion:sha,confirmed:true});assert.equal(result.items.length,2);const count=h.reads(),detail=await h.extensions.detail('owner',result.items[0].id);assert.match(detail.content,/# Risk review/);assert.equal(h.reads(),count);assert.ok(!JSON.stringify(result).includes('synthetic-private-token'));await assert.rejects(h.extensions.detail('other',result.items[0].id),{code:'extension_not_found'});
});
test('top-level bundle and independent skills share a fenced, deduplicated multi-skill scope',async t=>{
 const h=await fixture(t),bundle=await h.extensions.installSkill('owner',{...h.input,bundle:true,expectedVersion:sha,confirmed:true});assert.equal(bundle.bundle,true);assert.equal(bundle.members.length,2);await h.extensions.change('owner',bundle.id,{enabled:true,expectedVersion:bundle.version});
 const one=await h.extensions.installSkill('owner',{...h.input,path:'skills/alpha',expectedVersion:sha,confirmed:true});await h.extensions.change('owner',one.id,{enabled:true,expectedVersion:sha});const scope=await h.extensions.snapshot('owner',{skillIds:[bundle.id,one.id],skillVersions:{[bundle.id]:bundle.version,[one.id]:sha}});assert.equal(scope.skills.length,2);assert.equal(scope.guides.length,2);await h.extensions.validate('owner',scope);await h.extensions.change('owner',one.id,{enabled:false});await assert.rejects(h.extensions.validate('owner',scope),{code:'extension_version_changed'});
});

test('a malformed member leaves the whole batch uninstalled',async t=>{
 const h=await fixture(t),before=files['skills/beta/SKILL.md'];files['skills/beta/SKILL.md']='invalid file';
 try{await assert.rejects(h.extensions.installSkill('owner',{...h.input,paths:['skills/alpha','skills/beta'],expectedVersion:sha,confirmed:true}),{code:'invalid_remote_skill'});assert.equal((await h.extensions.list('owner')).length,0);}finally{files['skills/beta/SKILL.md']=before;}
});

test('Pi loads selected bundle guidance through a scoped tool and keeps its source versions',async t=>{
 const h=await fixture(t),bundle=await h.extensions.installSkill('owner',{...h.input,bundle:true,expectedVersion:sha,confirmed:true});await h.extensions.change('owner',bundle.id,{enabled:true,expectedVersion:bundle.version});
 const {createModels}=await import('@earendil-works/pi-ai/models'),{fauxProvider,fauxAssistantMessage:message,fauxToolCall:call}=await import('@earendil-works/pi-ai/providers/faux'),{createMeetingAgentRuntime}=await import('../services/records/src/meeting-agent.mjs'),{createRecord}=await import('../packages/records/src/record.mjs');
 const models=createModels(),fake=fauxProvider({provider:'bundle-test',models:[{id:'test'}],tokensPerSecond:Infinity});models.setProvider(fake.provider);const r=createRecord('owner',{title:'风险评审'});Object.assign(r,{segments:[{id:'seg',revision:1,text:'保留引用',startMs:0,endMs:1000}],transcriptRevision:1,minutesRevision:1});await h.repo.insert(r);
 const scope=await h.extensions.snapshot('owner',{skillIds:[bundle.id],skillVersions:{[bundle.id]:bundle.version}});fake.setResponses([context=>{assert.doesNotMatch(JSON.stringify(context),/Keep citations/);return message(call('read_selected_skill',{key:scope.guides[0].key}),{stopReason:'toolUse'});},context=>{assert.match(JSON.stringify(context),/Keep citations/);return message(call('read_selected_meeting',{recordId:r.id}),{stopReason:'toolUse'});},message(JSON.stringify({summary:'按 Skill 保留引用',decisions:[{text:'保留引用',evidence:[{recordId:r.id,segmentId:'seg',revision:1}]}],actions:[]}))]);
 const agent=await createMeetingAgentRuntime({repo:h.repo,extensions:h.extensions,models,model:{provider:'bundle-test',modelId:'test'}});
 try{const task=await agent.request('owner',{recordIds:[r.id],prompt:'根据集合梳理风险',requestId:'bundle-task',scopeConfirmed:true,skillIds:[bundle.id],skillVersions:{[bundle.id]:bundle.version}});let result;for(let i=0;i<100;i++){result=await agent.get('owner',task.id);if(['completed','failed','blocked'].includes(result.status))break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.skills[0].version,bundle.version);assert.doesNotMatch(JSON.stringify(result),/synthetic-private-token/);}finally{await agent.close();}
});


test('changing bundle membership at the same commit fences the old scope even after re-enabling',async t=>{
 const h=await fixture(t),all=await h.extensions.installSkill('owner',{...h.input,bundle:true,expectedVersion:sha,confirmed:true});await h.extensions.change('owner',all.id,{enabled:true,expectedVersion:all.version});const scope=await h.extensions.snapshot('owner',{skillIds:[all.id],skillVersions:{[all.id]:all.version}});
 const subset=await h.extensions.installSkill('owner',{...h.input,bundle:true,paths:['skills/alpha'],expectedVersion:sha,confirmed:true});assert.equal(subset.commit,sha);assert.notEqual(subset.version,all.version);assert.equal(subset.enabled,false);await h.extensions.change('owner',subset.id,{enabled:true,expectedVersion:subset.version});await assert.rejects(h.extensions.validate('owner',scope),{code:'extension_version_changed'});
});

test('reinstallation cannot restore a concurrently disabled or removed Skill',async t=>{
 for(const remove of [false,true]){const h=await fixture(t),item=await h.extensions.installSkill('owner',{...h.input,path:'skills/alpha',expectedVersion:sha,confirmed:true});await h.extensions.change('owner',item.id,{enabled:true,expectedVersion:item.version});const save=h.repo.saveExtensions.bind(h.repo);let changed=false;h.repo.saveExtensions=async(...args)=>{if(!changed){changed=true;if(remove)await h.extensions.remove('owner',item.id);else await h.extensions.change('owner',item.id,{enabled:false});}return save(...args);};await assert.rejects(h.extensions.installSkill('owner',{...h.input,path:'skills/alpha',expectedVersion:sha,confirmed:true}),{code:'extension_version_changed'});const row=await h.repo.get(item.id);assert.equal(row.enabled,false);if(remove)assert.equal(row.deleted,true);}
});

test('Markdown examples and missing documents do not prevent collection installation',async t=>{
  const h=await fixture(t),before=files['skills/alpha/SKILL.md'];
  files['skills/alpha/SKILL.md']+='\n\n`[example](../inline.md)`\n\n```md\n[example](../fenced.md)\n```\n\n[模板](文件名.md)\n[指引](参考.md)\n\n~~~md\n[example](../longer-fence.md)\n~~~~\n\n``inline with ` [example](../inline-run.md)``\n\n```md\n[example](../unclosed-fence.md)';
  files['skills/alpha/参考.md']='实际指引';
  try{const preview=await h.extensions.skillPreview({...h.input,path:'skills/alpha'},'owner');assert.match(preview.content,/实际指引/);assert.ok(preview.warnings.some(w=>w.includes('文件名.md')));const bundle=await h.extensions.installSkill('owner',{...h.input,bundle:true,expectedVersion:sha,confirmed:true});assert.equal(bundle.members.length,2);}
  finally{files['skills/alpha/SKILL.md']=before;delete files['skills/alpha/参考.md'];}
});

test('Markdown references cannot traverse outside a selected skill',async t=>{
  const h=await fixture(t),before=files['skills/alpha/SKILL.md'];files['skills/alpha/SKILL.md']+='\n[escape](../outside.md)';
  try{await assert.rejects(h.extensions.skillPreview({...h.input,path:'skills/alpha'},'owner'),{code:'invalid_remote_skill'});}finally{files['skills/alpha/SKILL.md']=before;}
});

test('a collection can contain both its root skill and nested child skills',async t=>{
  const h=await fixture(t);files['skills/SKILL.md']='---\nname: parent\ndescription: Parent guide\n---\n# Parent';
  try{const catalog=await h.extensions.skillPreview({...h.input,bundle:true},'owner');assert.equal(catalog.choices.length,3);assert.ok(catalog.choices.some(c=>c.path==='skills'));const bundle=await h.extensions.installSkill('owner',{...h.input,bundle:true,expectedVersion:sha,confirmed:true});assert.equal(bundle.members.length,3);await h.extensions.change('owner',bundle.id,{enabled:true,expectedVersion:bundle.version});const scope=await h.extensions.snapshot('owner',{skillIds:[bundle.id],skillVersions:{[bundle.id]:bundle.version}});assert.equal(scope.guides.length,3);assert.ok(scope.guides.some(g=>g.name==='parent'));}
  finally{delete files['skills/SKILL.md'];}
});
