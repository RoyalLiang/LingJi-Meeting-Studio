import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
const source=await Promise.all(['api.ts','downloads.ts','provider-settings.ts'].map(async file=>stripTypeScriptTypes(await readFile(new URL(`../apps/web/src/${file}`,import.meta.url),'utf8'),{mode:'transform'}).replace(/^import .*$/gm,'').replace(/export /g,'')));
function harness(fetch){const sandbox={exports:{},fetch,URL,AbortSignal,location:{origin:'https://studio.example'},performance:{now:()=>0},trace:()=>{}};vm.runInNewContext(source.join('\n')+'\nObject.assign(exports,{fetchDownload,protocolForAddress,api});',sandbox);return sandbox.exports;}
test('backup reads authenticated response before returning a named download and preserves HTTP errors',async()=>{
  const blob={size:200};let request;
  const h=harness(async(href,options)=>{request={href,options};return{ok:true,blob:async()=>blob,headers:new Map([['content-disposition','attachment; filename="meeting.json"']])};});
  const file=await h.fetchDownload('/api/records/example/export?format=json');
  assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.cache,'no-store');assert.equal(file.filename,'meeting.json');assert.equal(file.blob,blob);
  const failed=harness(async()=>({ok:false,status:401,json:async()=>({error:'session_expired'})}));
  await assert.rejects(failed.fetchDownload('/api/records/example/export?format=json'),error=>error.code==='session_expired'&&error.message.includes('登录已过期'));
  const proxy=harness(async()=>({ok:false,status:502,json:async()=>{throw Error('html');}}));
  await assert.rejects(proxy.fetchDownload('/api/records/example/export?format=json'),error=>error.code==='download_failed');
});
test('address editing prefers Responses while recognizing explicit legacy Chat paths',()=>{
  const {protocolForAddress}=harness(()=>{});
  assert.equal(protocolForAddress('https://models.example/v1'),'responses');
  assert.equal(protocolForAddress('https://models.example/v1/responses'),'responses');
  assert.equal(protocolForAddress('https://models.example/v1/chat/completions?region=cn'),'chat-completions');
});
test('downloads preserve Unicode meeting filenames and fall back for malformed encoding',async()=>{
  const h=header=>harness(async()=>({ok:true,blob:async()=>({size:10}),headers:new Map([['content-disposition',header]])}));
  assert.equal((await h("attachment; filename=\"meeting.wav\"; filename*=UTF-8''%E4%BC%9A%E8%AE%AE.wav").fetchDownload('/api/records/r/audio/s?download=1')).filename,'会议.wav');
  assert.equal((await h("attachment; filename=\"meeting.wav\"; filename*=UTF-8''%XX.wav").fetchDownload('/api/records/r/audio/s?download=1')).filename,'meeting.wav');
});

const followSource=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/components/useContentFollow.ts',import.meta.url),'utf8'),{mode:'transform'}).replace(/^import .*$/gm,'').replace(/export /g,'');
function followHarness(){
  const slots=[],pending=[],frames=new Map(),listeners=new Map(),windowListeners=new Map();
  let cursor=0,nextFrame=0,resize,api,props={update:'initial',paused:false,enabled:true};
  const container={scrollTop:1000,scrollHeight:1500,clientHeight:500,getBoundingClientRect:()=>({top:0,bottom:500}),
    scrollTo({top}){this.scrollTop=top;},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const root={closest:()=>container},end={getBoundingClientRect:()=>({bottom:container.scrollHeight-container.scrollTop})};
  const memo=(callback,deps)=>{const index=cursor++,old=slots[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))slots[index]={deps,callback};return slots[index].callback;};
  const effect=(callback,deps)=>{const index=cursor++,old=slots[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))pending.push(()=>{old?.cleanup?.();slots[index]={deps,cleanup:callback()};});};
  const sandbox={exports:{},useRef:value=>slots[cursor++]||=( {current:value} ),useCallback:memo,useEffect:effect,useLayoutEffect:effect,
    useState:value=>{const index=cursor++;slots[index]||={value};return[slots[index].value,value=>{slots[index].value=value;}];},
    requestAnimationFrame:fn=>{const id=++nextFrame;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
    ResizeObserver:class{constructor(fn){resize=fn;}observe(){}disconnect(){resize=undefined;}},
    window:{addEventListener:(name,fn)=>windowListeners.set(name,fn),removeEventListener:name=>windowListeners.delete(name)}};
  vm.runInNewContext(followSource+'\nexports.useContentFollow=useContentFollow;',sandbox);
  function render(next={}){props={...props,...next};cursor=0;api=sandbox.exports.useContentFollow(props.update,props.paused,undefined,props.enabled);api.root.current=root;api.end.current=end;pending.splice(0).forEach(fn=>fn());return api;}
  function settle(){for(let pass=0;frames.size&&pass<10;pass++){const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());}}
  render();settle();
  return{container,render,settle,dispatch:(name,event={})=>listeners.get(name)?.(event),pauseReading:()=>windowListeners.get('meeting:pause-follow')?.(),resize:()=>resize?.(),get api(){return api;},
    close(){slots.forEach(slot=>slot?.cleanup?.());assert.equal(listeners.size+windowListeners.size+frames.size,0);}};
}

test('upward wheel and near-tail scroll in the same batch keep following paused through streamed growth',()=>{
  const h=followHarness();
  try{
    h.container.scrollTop-=24;
    h.dispatch('wheel',{deltaY:-24});h.dispatch('scroll');
    assert.equal(h.render().following,false);
    for(let update=1;update<=8;update++){h.container.scrollHeight+=60;h.render({update:String(update)});h.resize();h.settle();assert.equal(h.container.scrollTop,976);assert.equal(h.api.following,false);}
    h.api.resume();h.render();h.settle();assert.equal(h.api.following,true);assert.equal(h.container.scrollTop,h.container.scrollHeight-h.container.clientHeight);
  }finally{h.close();}
});

test('touch, keyboard and source navigation preserve reading intent until explicit resume',()=>{
  for(const action of ['touchmove','keydown','meeting:pause-follow']){
    const h=followHarness();
    try{
      if(action==='meeting:pause-follow')h.pauseReading();else h.dispatch(action,{key:'PageUp'});
      h.dispatch('scroll');assert.equal(h.render().following,false);
      h.render({enabled:false});h.container.scrollHeight+=120;h.render({update:'next-job',enabled:true});h.resize();h.settle();assert.equal(h.api.following,false);assert.equal(h.container.scrollTop,1000);
      h.api.enable();h.render();h.settle();assert.equal(h.api.following,true);assert.equal(h.container.scrollTop,1120);
    }finally{h.close();}
  }
});

test('common requests normalize WebKit pattern and malformed JSON failures while preserving abort and HTTP domain errors', async () => {
  const network = harness(async () => { throw new SyntaxError('The string did not match the expected pattern'); });
  await assert.rejects(network.api('/records'), error => error.code === 'service_unavailable' && !error.message.includes('pattern'));
  await assert.rejects(network.fetchDownload('/api/records/example/export?format=json'), error => error.code === 'service_unavailable');
  const malformed = harness(async () => ({ok:true,status:200,json:async()=>{throw new SyntaxError('The string did not match the expected pattern');}}));
  await assert.rejects(malformed.api('/records/example','PATCH',{notes:'saved?'}), error => error.code === 'invalid_response' && error.message.includes('尚未确认'));
  await assert.rejects(harness(async()=>({ok:true,status:200,json:async()=>null})).api('/records'),error=>error.code==='invalid_response');
  const aborted = Object.assign(new Error('aborted'), {name:'AbortError'});
  await assert.rejects(harness(async()=>{throw aborted;}).api('/records'), error => error === aborted);
  const rejected = harness(async()=>({ok:false,status:409,json:async()=>({error:'segment_revision_conflict'})}));
  await assert.rejects(rejected.api('/records/example','PATCH',{}), error => error.status === 409 && error.code === 'segment_revision_conflict');
});

test('background minutes requests never disable or release unrelated blocking actions',async()=>{
 const app=await readFile(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
 const mutation=app.slice(app.indexOf('  const mutate = useCallback('),app.indexOf('  const saveTranscript ='));
 const busy=[];let resolve;
 const sandbox={useCallback:fn=>fn,exports:{},setBusy:value=>busy.push(value),setError(){},api:async()=>new Promise(r=>{resolve=r;}),refresh:async()=>{},loadList:async()=>{},showToast(){},activeId:{current:'record'},messageOf:e=>e.message,Promise};
 vm.runInNewContext(stripTypeScriptTypes(mutation,{mode:'transform'})+'\nexports.mutate=mutate;',sandbox);
 const background=sandbox.exports.mutate('/records/record/minutes','POST',{},false);assert.deepEqual(busy,[]);resolve();await background;assert.deepEqual(busy,[]);
 const blocking=sandbox.exports.mutate('/records/record','PATCH',{});assert.deepEqual(busy,[true]);resolve();await blocking;assert.deepEqual(busy,[true,false]);
 const generation=app.slice(app.indexOf('generate={async (template,mode)'),app.indexOf(' edit={async minutes'));
 assert.match(generation,/mutate\([\s\S]*?}, false\)/,'the actual regenerate caller must use nonblocking mutation');
});

test('regeneration guards double clicks locally and always releases its own loading state',async()=>{
 const source=await readFile(new URL('../apps/web/src/components/Minutes.tsx',import.meta.url),'utf8');
 const start=source.indexOf('  async function regenerate()'),end=source.indexOf('\n  }',start)+4;
 assert.equal((source.match(/generate\(template,mode\)/g)||[]).length,1,'all retry entry points must share the guarded regenerate action');
 assert.match(source,/label:'重新整理',run:\(\)=>void regenerate\(\),disabled:busy \|\| generating/);
 const states=[];let calls=0,resolve;
 const sandbox={exports:{},submitting:{current:false},setGenerating:value=>states.push(value),template:'meeting',mode:'model',generate:async()=>{calls++;await new Promise(r=>{resolve=r;});}};
 vm.runInNewContext(source.slice(start,end)+'\nexports.regenerate=regenerate;',sandbox);
 const request=sandbox.exports.regenerate();await sandbox.exports.regenerate();assert.equal(calls,1);assert.deepEqual(states,[true]);resolve();await request;assert.deepEqual(states,[true,false]);
 sandbox.generate=async()=>{throw Error('fixture failure');};await assert.rejects(sandbox.exports.regenerate(),/fixture failure/);assert.equal(sandbox.submitting.current,false);assert.deepEqual(states,[true,false,true,false]);
});
