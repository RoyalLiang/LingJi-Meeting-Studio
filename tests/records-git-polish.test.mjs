import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {renderMarkdown} from '../apps/web/src/markdown.mjs';
import {includeBackendDependency,includeBackendSource} from '../scripts/prepare-client-backend.mjs';
import vm from 'node:vm';
import {transform} from 'esbuild';

async function component(file,name,request,statusFeed=async()=>({enabled:true,recent:[]})){
  const source=await readFile(new URL('../apps/web/src/components/'+file,import.meta.url),'utf8');
  const code=(await transform(source,{loader:'tsx',jsx:'automatic',format:'cjs'})).code;
  const slots=[],effects=[];let cursor=0,initial=true;
  const jsx=(type,props)=>({type,props}),exports={};
  const react={useId:()=>`field-${cursor++}`,useState:value=>{const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useRef:value=>{const i=cursor++;return slots[i]??=( {current:value});},useCallback:fn=>fn,useMemo:fn=>fn(),useEffect:fn=>{if(initial)effects.push(fn);}};
  const sandbox={exports,module:{exports},Intl,Date,Event,document:{visibilityState:'visible'},window:{dispatchEvent(){}},AbortController,setInterval:()=>1,clearInterval(){},require:id=>id==='react'?react:id==='react-dom'?{createPortal:node=>node}:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='../api'?{api:request,messageOf:error=>error.message,ApiError:Error,getAuthGeneration:()=>1}:id==='../git-sync-feed'?{invalidateGitSyncStatus(){},gitSyncStatus:statusFeed}:new Proxy({},{get:(_target,key)=>String(key)})};
  vm.runInNewContext(code,sandbox);
  const render=props=>{cursor=0;const tree=sandbox.module.exports[name](props);if(initial){initial=false;effects.splice(0).forEach(fn=>fn());}return tree;};
  return render;
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];}
const words=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).map(words).join('');
const checkbox=(tree,label)=>nodes(nodes(tree).find(n=>n.type==='label'&&words(n).includes(label))).find(n=>n.type==='input');

test('Git task displays recording wait and reading progress instead of an empty running message',async()=>{
  const render=await component('GitAutomation.tsx','GitTask',async()=>({}));
  const job={id:'synthetic',recordId:'source',title:'合成任务',status:'queued',phase:'organize',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),activity:{state:'queued',reason:'recording',startedAt:Date.now()},progress:{read:0,total:1,pagesRead:0,totalPages:3}};
  let text=words(render({job,close(){},changed(){}}));
  assert.match(text,/正在录音，后台整理将在停止采集后继续/);assert.match(text,/已阅读 0\/3 页会议材料/);
  text=words(render({job:{...job,status:'running',activity:{state:'running',startedAt:Date.now()},progress:{...job.progress,pagesRead:1}},close(){},changed(){}}));
  assert.match(text,/正在请求模型，用量将在响应后更新/);assert.match(text,/已阅读 1\/3 页会议材料/);
});

test('Git future consent can be reselected after editing a scope-affecting option',async()=>{
  const render=await component('GitAutomation.tsx','GitAutomation',async path=>path==='/workspaces'?{workspaces:[]}:{configured:true,enabled:true,root:'https://git.example.test/project-hub',prompt:'整理已确认内容',skillIds:['meeting-review'],projects:[],recent:[],mode:'mr'});
  const props={extensions:[]};render(props);await new Promise(resolve=>setTimeout(resolve,0));
  let tree=render(props);assert.equal(checkbox(tree,'允许将今后').props.checked,true);
  nodes(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'保留完整引用与人工修订'}});
  tree=render(props);assert.equal(checkbox(tree,'允许将今后').props.checked,false);
  checkbox(tree,'允许将今后').props.onChange({target:{checked:true}});
  tree=render(props);assert.equal(checkbox(tree,'允许将今后').props.checked,true);
});
test('a removed selected task cannot prevent the latest Git task list from refreshing',async()=>{
 const old={id:'old',title:'旧任务',status:'failed',phase:'organize',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},fresh={...old,id:'new',title:'新任务'};
 const render=await component('GitAutomation.tsx','GitAutomation',async path=>{if(path==='/workspaces')return {workspaces:[]};if(path.includes('/tasks/'))throw Object.assign(new Error('任务已不可用'),{status:404});return {configured:true,enabled:true,recent:[old],root:'https://git.example.test/root',prompt:'保持引用',skillIds:['meeting-review'],projects:[],mode:'mr'};},async()=>({enabled:true,recent:[fresh]}));
 const props={extensions:[]};render(props);await new Promise(resolve=>setTimeout(resolve,0));let tree=render(props);nodes(tree).find(node=>node.type==='Button'&&words(node).startsWith('任务记录')).props.onClick();tree=render(props);nodes(tree).find(node=>node.type==='TaskHistory').props.children([old]).flatMap(nodes).find(node=>node.props?.className==='git-history-row').props.onClick();await new Promise(resolve=>setTimeout(resolve,0));tree=render(props);
 assert.ok(nodes(tree).find(node=>node.type==='TaskHistory').props.revision.includes('new'),'live feed forces independent history to refresh');assert.ok(!nodes(tree).some(node=>node.props?.job?.id==='old'));
});

test('stale workspace analysis is an incident-scoped inline notice rather than a navigation toast',async()=>{
  const render=await component('WorkspaceHome.tsx','WorkspaceHome',async()=>({workspace:{name:'项目资料'},totals:{meetings:1,completed:1,withTranscript:1,withMinutes:0,staleMinutes:0,seconds:60},activity:[],topics:[],summaries:[],decisions:[],actions:[],topicCount:0,analysis:{status:'stale',runId:'incident-a',preview:'',coverage:{included:1,available:1}}}));
  const props={scope:'workspace-a',records:[],query:'',modelReady:true,disabled:false};render(props);await new Promise(resolve=>setTimeout(resolve,0));
  const notice=nodes(render(props)).find(n=>n.type==='FeedbackNotice'&&n.props.message.includes('旧分析已隐藏'));
  assert.ok(notice);assert.equal(notice.props.inline,true);assert.match(notice.props.dismissalKey,/workspace-a.*incident-a/);
});

test('GFM renders nested content, escaped pipes, tasks, code, and isolated footnotes',()=>{
  const html=renderMarkdown('# 标题\n\n- **重点**\n  - 嵌套 `code`\n- [x] 已确认\n\n| 内容 | 结果 |\n| --- | --- |\n| A \\| B | 好 |\n\n```js\nconst value = "<script>";\n```\n\n引用[^1]\n\n[^1]: 片段一','source-one');
  assert.match(html,/<ul>[\s\S]*<ul>/);assert.match(html,/<input[^>]+checked/);assert.match(html,/<td>A \| B<\/td>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/href="#source-one-1"/);assert.match(html,/id="source-one-1"/);
});
test('backend filter drops development-only files and duplicate SDK build, keeping runtime and licenses',()=>{
  for(const name of ['dist/provider.js','dist/assets/schema.json','dist/runtime.node','LICENSE','dist/worker.wasm'])assert.equal(includeBackendDependency(`/tmp/pkg/node_modules/provider/${name}`),true,name);
  for(const name of ['dist/provider.js.map','dist/provider.d.ts','dist/provider.d.mts','tests/fixture.js','docs/guide.md','README.md'])assert.equal(includeBackendDependency(`/tmp/pkg/node_modules/provider/${name}`),false,name);
  assert.equal(includeBackendDependency('C:\\app\\node_modules\\@larksuiteoapi\\node-sdk\\es\\index.js'),false);
  assert.equal(includeBackendDependency('/tmp/node_modules/@larksuiteoapi/node-sdk/lib/index.js'),true);
  for(const path of ['openai/src/index.ts','@anthropic-ai/sdk/src/index.ts','@google/genai/dist/web/index.mjs','@google/genai/dist/index.mjs','@google/genai/dist/index.cjs'])assert.equal(includeBackendDependency(`/tmp/node_modules/${path}`),false,path);
  for(const path of ['openai/index.mjs','openai/index.js','@anthropic-ai/sdk/index.mjs','@google/genai/dist/node/index.mjs','@google/genai/dist/node/index.cjs','openai/LICENSE','@google/genai/LICENSE'])assert.equal(includeBackendDependency(`/tmp/node_modules/${path}`),true,path);
  assert.equal(includeBackendSource('/tmp/packages/records/src/record.d.mts'),false);
  assert.equal(includeBackendSource('/tmp/services/records/src/audio-backup.mjs'),true);
});

test('backend pruning preserves vendored notices and every traversed parent',async()=>{
  for(const name of ['openai/src/_vendor/partial-json-parser/LICENSE','openai/src/_vendor/zod-to-json-schema/LICENSE','openai/src/internal/qs/LICENSE.md','@anthropic-ai/sdk/src/internal/qs/LICENSE.md']){
    const file=new URL('../node_modules/'+name,import.meta.url),path=fileURLToPath(file).replaceAll('\\','/');
    assert.ok((await readFile(file,'utf8')).length>100,name);
    assert.equal(includeBackendDependency(path),true,name);
    const segments=path.split('/');for(let end=1;end<segments.length;end++)assert.equal(includeBackendDependency(segments.slice(0,end).join('/')),true,name);
  }
});

test('Git save submits disabled edits and adopts the persisted normalized configuration',async()=>{
 const requests=[],policy={configured:true,enabled:true,root:'https://git.example.test/root',prompt:'原指令',skillIds:['meeting-review'],projects:[],recent:[],mode:'mr',directory:'docs/meetings'};
 const render=await component('GitAutomation.tsx','GitAutomation',async(path,method,body)=>{requests.push({path,method,body});if(path==='/workspaces')return{workspaces:[]};if(method==='PUT')return{...policy,...body,prompt:body.prompt.trim(),directory:'docs/updated'};return policy;});const props={extensions:[]};render(props);await new Promise(r=>setTimeout(r,0));let tree=render(props);
 nodes(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'  已关闭时更新  '}});tree=render(props);checkbox(tree,'启用 Git').props.onChange({target:{checked:false}});tree=render(props);nodes(tree).find(n=>n.type==='Button'&&words(n)==='保存设置').props.onClick();await new Promise(r=>setTimeout(r,0));tree=render(props);
 assert.equal(requests.filter(r=>r.method==='PUT').length,1);assert.equal(requests.find(r=>r.method==='PUT').body.enabled,false);assert.equal(nodes(tree).find(n=>n.type==='textarea').props.value,'已关闭时更新');assert.equal(nodes(tree).find(n=>n.type==='input'&&n.props.placeholder==='docs/meetings').props.value,'docs/updated');assert.equal(checkbox(tree,'启用 Git').props.checked,false);
});

test('Git project dropdown refreshes on open, coalesces quick reopens and uses single-line options',async()=>{
 let checks=0;const policy={configured:true,enabled:true,root:'https://git.example.test/root',prompt:'整理',skillIds:['meeting-review'],projects:[{id:10,name:'项目',path:'old/path'}],mappings:[{workspaceId:'workspace',projectId:10}],recent:[],mode:'mr'};
 const render=await component('GitAutomation.tsx','GitAutomation',async path=>path==='/workspaces'?{workspaces:[{id:'workspace',name:'项目'}]}:path.endsWith('/check')?(checks++,{projects:[{id:10,name:'项目',path:'new/current/path'},{id:20,name:'新仓库',path:'new/repository'}],group:{full_path:'root'}}):policy);const props={extensions:[]};render(props);await new Promise(r=>setTimeout(r,0));let tree=render(props),select=nodes(tree).find(n=>n.type==='Select'&&n.props.label==='映射目标项目 1');assert.equal(select.props.singleLine,true);select.props.onOpen();await new Promise(r=>setTimeout(r,0));tree=render(props);select=nodes(tree).find(n=>n.type==='Select'&&n.props.label==='映射目标项目 1');assert.equal(select.props.options[0].label,'new/current/path');assert.equal(select.props.options.length,2);select.props.onOpen();await new Promise(r=>setTimeout(r,0));assert.equal(checks,1);
});

test('opening task records and returning to grouped settings preserves an unsaved draft and revoked consent',async()=>{
 const requests=[],policy={configured:true,enabled:true,root:'https://git.example.test/root',prompt:'原指令',skillIds:['meeting-review'],projects:[],recent:[],mode:'mr'};
 const render=await component('GitAutomation.tsx','GitAutomation',async(path,method)=>{requests.push({path,method});return path==='/workspaces'?{workspaces:[]}:policy;});const props={extensions:[]};render(props);await new Promise(r=>setTimeout(r,0));let tree=render(props);
 nodes(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'尚未保存的整理指令'}});tree=render(props);nodes(tree).find(n=>n.type==='Button'&&words(n).startsWith('任务记录')).props.onClick();tree=render(props);assert.equal(nodes(tree).find(n=>n.props?.className==='git-settings').props.hidden,true);
 nodes(tree).find(n=>n.type==='Button'&&words(n)==='返回同步设置').props.onClick();tree=render(props);assert.equal(nodes(tree).find(n=>n.props?.className==='git-settings').props.hidden,false);assert.equal(nodes(tree).find(n=>n.type==='textarea').props.value,'尚未保存的整理指令');assert.equal(checkbox(tree,'允许将今后').props.checked,false);assert.equal(requests.filter(r=>r.method==='PUT').length,0);
});


test('task timeline keeps reported usage without displaying cost estimates',async()=>{
  const render=await component('TaskTimeline.tsx','TaskTimeline',async()=>({}));
  const text=words(render({timeline:[],ledger:{rounds:4,compactions:5,totalTokens:39911,cost:12.34}}));
  assert.match(text,/39,911/);assert.doesNotMatch(text,/费用|USD|12\.34/);
});

test('a recoverable failed Git task submits clarification to the existing retry route',async()=>{
  const requests=[],render=await component('GitAutomation.tsx','GitTask',async(path,method,body)=>{requests.push({path,method,body});return {...job,status:'queued',canRetryWithFeedback:false};});
  const job={id:'synthetic',recordId:'source',title:'合成同步',status:'failed',phase:'organize',error:'provider_http_504',canRetryWithFeedback:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const props={job,close(){},changed(){}};let tree=render(props);
  const textarea=nodes(tree.props.footer).find(node=>node.type==='textarea');assert.ok(textarea,'failed task must offer clarification');
  textarea.props.onChange({target:{value:'只同步确认内容'}});tree=render(props);
  nodes(tree.props.footer).find(node=>node.type==='Button'&&words(node)==='继续同步').props.onClick();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(requests[0].path,'/integrations/git-sync/tasks/synthetic/retry');assert.equal(requests[0].body.answer,'只同步确认内容');
});
