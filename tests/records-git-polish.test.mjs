import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {renderMarkdown} from '../apps/web/src/markdown.mjs';
import {includeBackendDependency,includeBackendSource} from '../scripts/prepare-client-backend.mjs';

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
