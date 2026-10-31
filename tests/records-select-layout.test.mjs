import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {transform} from 'esbuild';

test('workspace selection scrolls only its popup when the selected option is outside view', async()=>{
  const source=await readFile(new URL('../apps/web/src/components/Select.tsx',import.meta.url),'utf8');
  const code=(await transform(source.replace(/^import .*$/gm,''),{loader:'tsx',format:'cjs'})).code;
  const states=[],refs=[],effects=[],layouts=[];let cursor=0,refCursor=0;
  const viewport={width:800,height:600,addEventListener(){},removeEventListener(){}};
  const sandbox={module:{exports:{}},useEffect:fn=>effects.push(fn),useLayoutEffect:fn=>layouts.push(fn),useId:()=> 'workspace-popup',
    useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},
    useRef(value){return refs[refCursor++]??={current:value};},createPortal:element=>element,CaretDown:()=>null,Check:()=>null,
    document:{body:{},addEventListener(){},removeEventListener(){}},window:{visualViewport:viewport},visualViewport:viewport,
    innerWidth:800,innerHeight:600,addEventListener(){},removeEventListener(){}};
  sandbox.React={createElement:(tag,props,...children)=>typeof tag==='function'?tag({...props,children}):({tag,props,children})};
  vm.runInNewContext(code,sandbox);
  const options=Array.from({length:20},(_,i)=>({value:String(i),label:`工作目录 ${i}`}));
  const render=()=>{cursor=0;refCursor=0;effects.length=0;layouts.length=0;return sandbox.module.exports.Select({label:'选择工作目录',value:'19',options});};
  let tree=render();
  const menu={scrollTop:0,clientHeight:120,showPopover(){},hidePopover(){},querySelector(selector){
    const index=Number(selector.match(/"(\d+)"/)[1]);return {offsetTop:index*44,offsetHeight:44,scrollIntoView(){assert.fail('must not scroll the page or sidebar');}};
  }};
  refs[1].current=menu;refs[2].current={focus(){},getBoundingClientRect:()=>({left:24,width:220,top:250,bottom:287}),closest:()=>null};
  tree.children[1].props.onClick();tree=render();layouts.forEach(fn=>fn());tree=render();effects.forEach(fn=>fn());
  assert.equal(menu.scrollTop,760);
  tree.props.onKeyDown({key:'Home',preventDefault(){}});tree=render();effects.forEach(fn=>fn());
  assert.equal(menu.scrollTop,0);
});
