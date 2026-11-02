import test from 'node:test';
import assert from 'node:assert/strict';
import{readFile}from'node:fs/promises';
import vm from'node:vm';
import{transform}from'esbuild';
const source=await readFile(new URL('../apps/web/src/components/FeishuAutomation.tsx',import.meta.url),'utf8');
const compiled=(await transform(source,{loader:'tsx',jsx:'automatic',format:'cjs'})).code;
const walk=(node,predicate)=>{if(!node||typeof node!=='object')return undefined;if(predicate(node))return node;for(const child of [node.props?.children].flat(Infinity)){const found=walk(child,predicate);if(found)return found;}};
const text=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).map(text).join('');
async function harness(){
 const slots=[],effects=[],writes=[];let cursor=0,tree;
 let policy={configured:true,enabled:true,folderToken:'folderOld',destinationEmail:'',includeBoard:true,includeNotes:false,includeEvidence:true,connectionChanged:false,recent:[{id:'history-failed',title:'旧会议',status:'failed',error:'feishu_permission_required'}]};
 const useState=initial=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];};
 const useRef=initial=>{const index=cursor++;return slots[index]||=( {current:initial});};
 const useEffect=(callback,deps)=>{const index=cursor++,previous=slots[index];if(!previous||deps.some((value,i)=>value!==previous[i])){slots[index]=deps;effects.push(callback);}};
 const api=async(_path,method='GET',body)=>{if(method==='PUT'){writes.push(body);policy={...policy,...body};}return policy;};
 const modules={react:{useState,useRef,useEffect},'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'Fragment'},'../api':{api,ApiError:class extends Error{constructor(code){super(code);this.code=code;}},messageOf:e=>e.code||e.message},'./ui':{Button:'Button'},'./ExternalLink':{ExternalLink:'ExternalLink'},'./Select':{Select:'Select'},'./FeedbackNotice':{FeedbackNotice:'FeedbackNotice'},'./FeishuConnection':{FeishuConnection:'FeishuConnection'}};
 const context={module:{exports:{}},exports:{},require:name=>modules[name],setInterval:()=>1,clearInterval:()=>{},document:{visibilityState:'visible'}};context.exports=context.module.exports;vm.runInNewContext(compiled,context);
 const render=()=>{cursor=0;tree=context.module.exports.FeishuAutomation();while(effects.length)effects.shift()();return tree;};
 const settle=async()=>{await new Promise(setImmediate);render();};
 const checkbox=label=>{const wrapper=walk(tree,node=>node.type==='label'&&text(node)===label);return wrapper&&walk(wrapper,node=>node.type==='input'&&node.props.type==='checkbox');};
 render();await settle();walk(tree,node=>node.type==='FeishuConnection').props.onChange({enabled:true,connected:true,appId:'synthetic'});render();
 return{render,settle,checkbox,writes,get tree(){return tree;},change(label,checked){const input=checkbox(label);assert.ok(input,'checkbox '+label);input.props.onChange({target:{checked}});render();}};
}
test('saved automatic-export consent stays visible across content choices and save',async()=>{
 const h=await harness(),grant='允许将今后结束的会议纪要自动发送到此位置';
 assert.equal(h.checkbox(grant)?.props.checked,true,'saved authorization remains visibly selected');
 h.change('随手笔记',true);assert.equal(h.checkbox(grant)?.props.checked,true);assert.equal(h.checkbox('纪要画板').props.checked,true);
 h.change('纪要画板',false);assert.equal(h.checkbox('随手笔记').props.checked,true);assert.equal(h.checkbox(grant)?.props.checked,true);
 const save=walk(h.tree,node=>node.type==='Button'&&text(node)==='保存设置');assert.equal(Boolean(save.props.disabled),false);save.props.onClick();await h.settle();
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].confirmed,true);assert.equal(h.writes[0].includeBoard,false);assert.equal(h.writes[0].includeNotes,true);assert.equal(h.checkbox(grant)?.props.checked,true);
});
test('changing export destination requires confirmation but keeps content choices',async()=>{
 const h=await harness(),grant='允许将今后结束的会议纪要自动发送到此位置';h.change('随手笔记',true);
 const label=walk(h.tree,node=>node.type==='label'&&text(node).startsWith('文件夹链接')),input=walk(label,node=>node.type==='input');input.props.onChange({target:{value:'folderNew'}});h.render();
 assert.equal(h.checkbox(grant)?.props.checked,false);assert.equal(h.checkbox('随手笔记').props.checked,true);assert.equal(h.checkbox('纪要画板').props.checked,true);
});
test('old automatic-export errors remain inline instead of replaying global toasts',async()=>{
 const h=await harness(),history=walk(h.tree,node=>node.props?.className?.includes('feishu-history'));assert.ok(history);assert.equal(walk(history,node=>node.type==='FeedbackNotice'),undefined);
});
