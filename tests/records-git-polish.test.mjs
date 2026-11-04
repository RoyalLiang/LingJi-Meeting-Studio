import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown} from '../apps/web/src/markdown.mjs';
import {includeBackendDependency} from '../scripts/prepare-client-backend.mjs';

test('GFM renders nested content, escaped pipes, tasks, code, and isolated footnotes',()=>{
  const html=renderMarkdown('# 标题\n\n- **重点**\n  - 嵌套 `code`\n- [x] 已确认\n\n| 内容 | 结果 |\n| --- | --- |\n| A \\| B | 好 |\n\n```js\nconst value = "<script>";\n```\n\n引用[^1]\n\n[^1]: 片段一','source-one');
  assert.match(html,/<ul>[\s\S]*<ul>/);assert.match(html,/<input[^>]+checked/);assert.match(html,/<td>A \| B<\/td>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/href="#source-one-1"/);assert.match(html,/id="source-one-1"/);
});
test('backend filter drops development-only files and duplicate SDK build, keeping runtime and licenses',()=>{
  for(const name of ['dist/provider.js','dist/assets/schema.json','dist/runtime.node','LICENSE','dist/worker.wasm'])assert.equal(includeBackendDependency(`/tmp/pkg/node_modules/provider/${name}`),true,name);
  for(const name of ['dist/provider.js.map','dist/provider.d.ts','dist/provider.d.mts','tests/fixture.js','docs/guide.md','README.md'])assert.equal(includeBackendDependency(`/tmp/pkg/node_modules/provider/${name}`),false,name);
  assert.equal(includeBackendDependency('C:\\app\\node_modules\\@larksuiteoapi\\node-sdk\\es\\index.js'),false);
  assert.equal(includeBackendDependency('/tmp/node_modules/@larksuiteoapi/node-sdk/lib/index.js'),true);
});
