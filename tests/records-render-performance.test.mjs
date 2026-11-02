import test from 'node:test';import assert from 'node:assert/strict';import{createRequire}from'node:module';import{resolve}from'node:path';import vm from'node:vm';import{build}from'esbuild';import React from'react';import{renderToStaticMarkup}from'react-dom/server';
const require=createRequire(resolve('package.json'));
async function load(entry){const output=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom']});const module={exports:{}};vm.runInNewContext(output.outputFiles[0].text,{module,exports:module.exports,require,console});return module.exports;}
const {MinutesTree}=await load('apps/web/src/components/MinutesViews.tsx');
const {applyRecordDelta}=await load('apps/web/src/record-subscription.ts');const {Transcript}=await load('apps/web/src/components/Transcript.tsx');const {updateMinutesDraftItem}=await load('apps/web/src/components/Minutes.tsx');
const delta=(cursor,changes={})=>({baseCursor:String(cursor),cursor:String(cursor+1),set:{pendingChunks:1},remove:[],segments:{upsert:[],remove:[],...changes}});
test('metadata delta preserves segment collection identity and prior objects',()=>{const record={cursor:'1',segments:[{id:'a',text:'original'}],title:'same'};const next=applyRecordDelta(record,delta(1));assert.equal(next.segments,record.segments);assert.notEqual(next,record);assert.equal(next.segments[0],record.segments[0]);assert.equal(next.cursor,'2');});
test('actual upsert/remove/order still replace collection without mutating previous data',()=>{const record={cursor:'1',segments:[{id:'a',text:'original'},{id:'b',text:'keep'}]};const next=applyRecordDelta(record,delta(1,{upsert:[{id:'a',text:'changed'}],order:['b','a']}));assert.notEqual(next.segments,record.segments);assert.equal(next.segments[0],record.segments[1]);assert.equal(next.segments[1].text,'changed');assert.equal(record.segments[0].text,'original');const removed=applyRecordDelta(record,delta(1,{remove:['a']}));assert.deepEqual([...removed.segments].map(s=>s.id),['b']);assert.equal(applyRecordDelta(record,delta(1,{order:[]})).segments.length,0);});
const segment=(id,revision=1)=>({id,revision,startMs:0,endMs:1000,speaker:'synthetic',text:'synthetic',sourceId:'source'});const render=(segments,topics)=>renderToStaticMarkup(React.createElement(Transcript,{record:{id:'synthetic',capture:'completed',sources:[],speakers:[],segments,transcriptRevision:1,liveMinutes:{transcriptRevision:1,topics}},highlighted:'',save:async()=>true}));
test('topic index keeps first match and overlap membership semantics',()=>{const a=segment('a'),b=segment('b'),ref=s=>({segmentId:s.id,revision:s.revision});const html=render([a,b],[{title:'First-topic',summary:'first',evidence:[ref(a)]},{title:'Second-topic',summary:'second',evidence:[ref(a),ref(b)]}]);assert.match(html,/First-topic/);assert.doesNotMatch(html,/Second-topic/,'b belongs to second but previous a is also second member, so no new chapter header');});
test('topic evidence is keyed by both segment ID and revision',()=>{const html=render([segment('a',2)],[{title:'Stale-topic',summary:'old',evidence:[{segmentId:'a',revision:1}]}]);assert.doesNotMatch(html,/Stale-topic/);});
test('exact Transcript source reads topic evidence linearly on 3000 segments',()=>{let reads=0;const n=3000,segments=Array.from({length:n},(_,i)=>({...segment(`s${i}`),startMs:i*1000})),topics=Array.from({length:30},(_,i)=>({title:`t${i}`,summary:'synthetic',evidence:[]}));for(let i=0;i<n;i++)topics[i%30].evidence.push({get segmentId(){reads++;return`s${i}`;},revision:1});render(segments,topics);assert.ok(reads<=n*5,`expected <=${n*5}, got ${reads}; old source: 4,804,500`);console.log('topic evidence reads',reads);});
test('editing shares frozen evidence and untouched sections/items, replacing only target path',()=>{const snapshot=[segment('a')],evidence=[{segmentId:'a',revision:1}],draft={title:'synthetic',revision:1,evidenceSnapshot:snapshot,sections:[{heading:'A',items:[{text:'first',evidence},{text:'second',evidence}]},{heading:'B',items:[{text:'keep',evidence}]}]};const next=updateMinutesDraftItem(draft,0,0,'new');assert.notEqual(next,draft);assert.notEqual(next.sections,draft.sections);assert.notEqual(next.sections[0],draft.sections[0]);assert.notEqual(next.sections[0].items[0],draft.sections[0].items[0]);assert.equal(next.evidenceSnapshot,snapshot);assert.equal(next.sections[1],draft.sections[1]);assert.equal(next.sections[0].items[1],draft.sections[0].items[1]);assert.equal(next.sections[0].items[0].evidence,evidence);assert.equal(draft.sections[0].items[0].text,'first');assert.equal(next.sections[0].items[0].text,'new');assert.equal(updateMinutesDraftItem(next,0,0,'new'),next);assert.equal(updateMinutesDraftItem(null,0,0,'new'),null);});


test('tree cards keep speakers and content without a source icon row',()=>{
 const ref={segmentId:'a',revision:1};
 const minutes={title:'Synthetic',transcriptRevision:1,sections:[{heading:'Topic',items:[{text:'Detail',evidence:[ref]}]}],topics:[{id:'t',title:'Topic',summary:'Summary',evidence:[ref]}],tables:[],actions:[],evidenceSnapshot:[segment('a')]};
 const html=renderToStaticMarkup(React.createElement(MinutesTree,{minutes,speakerMap:new Map([['a:1','说话人1']]),cite:()=>{}}));
 assert.match(html,/minutes-tree is-compact/);assert.match(html,/branch-summary/);
 assert.match(html,/Summary/);assert.match(html,/Detail/);assert.match(html,/说话人1/);
 assert.doesNotMatch(html,/citation-entry/);assert.equal(minutes.topics[0].evidence[0],ref);
});

const {MarkdownPreview}=await load('apps/web/src/components/MarkdownPreview.tsx');
test('export preview renders headings lists tables emphasis and references safely',()=>{
 const html=renderToStaticMarkup(React.createElement(MarkdownPreview,{text:'# 标题\n\n## 结论\n- **已确认**内容[^1]\n\n| 对象 | 数值 |\n| --- | --- |\n| A | 2 |\n\n[^1]: 原文 <img src=x onerror=alert(1)>'}));
 assert.match(html,/<h2>标题<\/h2>/);assert.match(html,/<strong>已确认<\/strong>/);assert.match(html,/<table>/);assert.match(html,/<sup>/);assert.doesNotMatch(html,/<img|onerror="/);assert.match(html,/&lt;img/);
});

const {topicBranches}=await load('apps/web/src/minutes-views.ts');
test('topic grouping indexes topics once on thousands of unmatched items',()=>{
 let reads=0;const topics=Array.from({length:30},(_,i)=>({id:`t${i}`,get title(){reads++;return `Topic${i}`;},summary:'',evidence:[]}));
 const items=Array.from({length:3000},(_,i)=>({text:`item${i}`,evidence:[]}));
 const branches=topicBranches({topics,sections:[{heading:'Other',items}],actions:[]});
 assert.equal(branches.at(-1).items.length,3000);assert.equal(branches.at(-1).items[0],items[0]);assert.ok(reads<3100,`topic title reads: ${reads}`);
});

test('assistant Markdown handles ordered lists, incomplete fences and safe links',async()=>{
 const {MarkdownPreview}=await load('apps/web/src/components/MarkdownPreview.tsx');
 const html=renderToStaticMarkup(React.createElement(MarkdownPreview,{text:'## 草稿\n1. **决定**\n2. *待确认*\n\n[来源](https://example.com)\n[拒绝](javascript:alert(1))\n\n```js\nconst value = "<script>";'}));
 assert.match(html,/<ol>/);assert.match(html,/<em>待确认<\/em>/);assert.match(html,/href="https:\/\/example.com"/);assert.doesNotMatch(html,/href="javascript:/);assert.match(html,/<pre><code>/);assert.doesNotMatch(html,/<script>/);
});
