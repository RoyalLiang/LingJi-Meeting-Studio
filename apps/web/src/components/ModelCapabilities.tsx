type Profile={contextWindow?:number;maxOutputTokens?:number;nativeTools?:boolean;strictOutput?:boolean;parallelTools?:boolean;promptCache?:boolean;prices?:{input?:number;output?:number;cacheRead?:number;cacheWrite?:number}};
export function ModelCapabilities({draft,change,disabled}:{draft:Record<string,string>;change:(key:string,value:string)=>void;disabled:boolean}){
 let profiles:Record<string,Profile>={};try{profiles=JSON.parse(draft.LLM_MODEL_PROFILES||'{}');}catch{/* Keep a repairable blank form for invalid legacy configuration. */}
 const key=`${draft.LLM_PROTOCOL}:${draft.LLM_MODEL}`,profile=profiles[key]||{};
 const update=(patch:Partial<Profile>)=>change('LLM_MODEL_PROFILES',JSON.stringify({...profiles,[key]:{...profile,...patch}}));
 const price=(field:'input'|'output'|'cacheRead'|'cacheWrite',value:number|undefined)=>update({prices:{...profile.prices,[field]:value}});
 const amount=(label:string,value:number|undefined,onChange:(number:number|undefined)=>void)=> <label className="field"><span>{label}</span><input type="number" min={0} step="any" disabled={disabled} value={value??''} onChange={event=>onChange(event.target.value===''?undefined:Number(event.target.value))}/></label>;
 return <details className="model-capabilities"><summary>模型能力与任务预算</summary><p className="settings-mode-note">按当前模型与协议保存。能力和单价以服务商资料为准；未登记的模型使用兼容模式，未报告的费用保持未知。</p>
 <input type="hidden" name="LLM_MODEL_PROFILES" value={draft.LLM_MODEL_PROFILES||'{}'}/>
 <div className="settings-dependent-fields">{amount('上下文长度 · token',profile.contextWindow??16384,value=>update({contextWindow:value}))}{amount('单轮输出上限 · token',profile.maxOutputTokens??4096,value=>update({maxOutputTokens:value}))}
 {(['nativeTools','strictOutput','parallelTools','promptCache'] as const).map((field,index)=><label className="checkbox-label" key={field}><input type="checkbox" disabled={disabled} checked={Boolean(profile[field])} onChange={event=>update({[field]:event.target.checked})}/>{['原生工具调用','严格结果格式','并行只读工具','服务端支持提示缓存'][index]}</label>)}
 {amount('输入单价 · USD / 百万 token',profile.prices?.input,value=>price('input',value))}{amount('输出单价 · USD / 百万 token',profile.prices?.output,value=>price('output',value))}{amount('缓存读取 · USD / 百万 token',profile.prices?.cacheRead,value=>price('cacheRead',value))}
 {amount('缓存写入 · USD / 百万 token',profile.prices?.cacheWrite,value=>price('cacheWrite',value))}
 <label className="field"><span>单任务预算 · USD（0 为不设上限）</span><input type="number" min={0} step="0.01" name="MEETING_TASK_BUDGET_USD" value={draft.MEETING_TASK_BUDGET_USD||'0'} disabled={disabled} onChange={event=>change('MEETING_TASK_BUDGET_USD',event.target.value)}/></label>
 </div></details>;
}
