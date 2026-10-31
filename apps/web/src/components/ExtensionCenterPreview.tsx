/* finesse · register=product · shell=real-workspace · palette=white+quiet-jade · type=system-humanist · material=flat-paper · SOUL=6 SPECTACLE=1 DENSITY=7 */
import { useState } from 'react';
import { ArrowRight, ArrowUpRight, CalendarBlank, CaretRight, Check, CheckCircle, Clock, FileText, Lightning, MagnifyingGlass, Pause, PlugsConnected, Plus, ShieldCheck, Sparkle, Stack, UploadSimple } from '@phosphor-icons/react';
import type { RecordListItem } from '../model';
import { Button, Modal } from './ui';
import { Select } from './Select';
import './ExtensionCenterPreview.css';

export type ExtensionView = 'skills' | 'plugins' | 'runs' | 'schedule' | 'assistant';
type Skill = { id:string; name:string; description:string; version:string; enabled:boolean; icon:typeof Sparkle };
const initialSkills:Skill[] = [
  {id:'review',name:'会议复盘',description:'串联多场会议的进展、结论与待办',version:'1.2.0',enabled:true,icon:Stack},
  {id:'decisions',name:'决策追踪',description:'提取决策依据，追踪后续变化',version:'1.0.3',enabled:true,icon:CheckCircle},
  {id:'terms',name:'术语整理',description:'归集项目术语与讨论上下文',version:'1.1.0',enabled:false,icon:FileText},
];
const navigation = [
  {id:'skills',label:'Skills'}, {id:'plugins',label:'插件'}, {id:'runs',label:'运行任务'}, {id:'schedule',label:'自动化'}, {id:'assistant',label:'会议助手'},
] as const;
const runExamples = [
  {id:'r1',name:'产品周会复盘',skill:'会议复盘',state:'整理中',tone:'active',when:'刚刚',materials:'3 场会议'},
  {id:'r2',name:'交付决策跟进',skill:'决策追踪',state:'排队中',tone:'',when:'2 分钟前',materials:'2 场会议'},
  {id:'r3',name:'术语表更新',skill:'术语整理',state:'等待处理',tone:'warn',when:'8 分钟前',materials:'1 场会议'},
  {id:'r4',name:'需求评审复盘',skill:'会议复盘',state:'已完成',tone:'success',when:'今天 10:32',materials:'2 场会议'},
];

function Toggle({checked,label,onChange}:{checked:boolean;label:string;onChange:()=>void}) {
  return <button type="button" className="ec-toggle" role="switch" aria-checked={checked} aria-label={label} onClick={onChange}><span/></button>;
}

// shortcut: all extension state is local preview data; replace only after the runtime design is approved.
export default function ExtensionCenterPreview({view,navigate,records,openRecord}:{view:ExtensionView;navigate:(view:ExtensionView)=>void;records:RecordListItem[];openRecord:(id:string)=>void}) {
  const [skills,setSkills]=useState(initialSkills),[search,setSearch]=useState(''),[filter,setFilter]=useState('all');
  const [drawer,setDrawer]=useState<{kind:string;id?:string}|null>(null),[detailTab,setDetailTab]=useState('overview');
  const [plugins,setPlugins]=useState([true,true,false]);
  const [rules,setRules]=useState([{id:'after',name:'会后自动复盘',event:'ended',skill:'review',enabled:true},{id:'weekly',name:'每周决策回顾',event:'weekly',skill:'decisions',enabled:false}]);
  const [ruleName,setRuleName]=useState(''),[ruleSkill,setRuleSkill]=useState('review'),[trigger,setTrigger]=useState('ended');
  const [assistantSkillId,setAssistantSkillId]=useState('review');
  const [selected,setSelected]=useState<string[]>([]),[draftSelected,setDraftSelected]=useState<string[]>([]),[prompt,setPrompt]=useState(''),[notice,setNotice]=useState('');
  const [runs,setRuns]=useState(runExamples);
  const skill=skills.find(item=>item.id===drawer?.id);
  const run=runs.find(item=>item.id===drawer?.id);
  const chosen=records.filter(item=>selected.includes(item.id));
  const enabledSkills=skills.filter(item=>item.enabled),assistantSkill=enabledSkills.find(item=>item.id===assistantSkillId)||enabledSkills[0];
  function show(kind:string,id?:string) {
    if(kind==='sources')setDraftSelected(selected);
    if(kind==='rule'){const rule=rules.find(item=>item.id===id);setRuleName(rule?.name||'');setRuleSkill(rule?.skill||'review');setTrigger(rule?.event||'ended');}
    setNotice('');setDetailTab('overview');setDrawer({kind,id});
  }
  function switchView(next:ExtensionView) { setSearch('');setFilter('all');setNotice('');setDrawer(null);navigate(next); }
  function toggleSkill(id:string) {
    if(skills.find(item=>item.id===id)?.enabled)setRules(items=>items.map(item=>item.skill===id?{...item,enabled:false}:item));
    setSkills(items=>items.map(item=>item.id===id?{...item,enabled:!item.enabled}:item));
  }
  const drawerTitle = drawer?.kind==='skill'?skill?.name:drawer?.kind==='plugin'?'会议资料':drawer?.kind==='run'?run?.name:drawer?.kind==='rule'?(drawer.id?'编辑自动化':'新建自动化'):drawer?.kind==='sources'?'选择会议':drawer?.kind==='plan'?'任务预览':drawer?.kind==='import'?'导入 Skill':'添加插件';
  const visibleSkills=skills.filter(item=>(filter==='all'||(filter==='enabled'?item.enabled:!item.enabled))&&`${item.name}${item.description}`.includes(search));
  return <section className="extension-center" aria-label="扩展中心开发预览">
    <header className="ec-heading"><div><h1>扩展中心</h1><span className="ec-preview-label">开发预览 · 示例数据</span></div>
      {view==='skills'&&<Button onClick={()=>show('import')}><UploadSimple size={16}/>导入 Skill</Button>}
      {view==='plugins'&&<Button onClick={()=>show('connect')}><Plus size={16}/>添加插件</Button>}
      {view==='schedule'&&<Button onClick={()=>show('rule')}><Plus size={16}/>新建自动化</Button>}
      {view==='runs'&&<Button onClick={()=>switchView('assistant')}><Plus size={16}/>新建任务</Button>}
    </header>
    <nav className="ec-navigation" aria-label="扩展中心导航">{navigation.map(item=><button key={item.id} aria-current={view===item.id?'page':undefined} onClick={()=>switchView(item.id)}>{item.label}</button>)}</nav>
    {notice&&<div className="ec-notice" role="status"><Check size={16}/>{notice}</div>}
    {view==='skills'&&<>
      <div className="ec-toolbar"><h2>已安装 <span>{skills.length}</span></h2><div className="ec-tools"><div className="ec-search"><MagnifyingGlass size={16}/><input type="search" aria-label="搜索 Skills" placeholder="搜索 Skills" value={search} onChange={event=>setSearch(event.target.value)}/></div><Select label="筛选 Skills" value={filter} onChange={setFilter} options={[{value:'all',label:'全部状态'},{value:'enabled',label:'已启用'},{value:'disabled',label:'已停用'}]}/></div></div>
      <div className="ec-skill-list">{visibleSkills.map(item=><article className="ec-skill-row" key={item.id}><div className="ec-icon"><item.icon size={22}/></div><button className="ec-item-name" onClick={()=>show('skill',item.id)}><strong>{item.name}</strong><span>{item.description}</span></button><span className="ec-version">v{item.version}</span><span className={`ec-state ${item.enabled?'success':''}`}>{item.enabled?'已启用':'已停用'}</span><Toggle checked={item.enabled} label={`${item.enabled?'停用':'启用'}${item.name}`} onChange={()=>toggleSkill(item.id)}/><Button variant="ghost" className="ec-detail-button" aria-label={`查看${item.name}`} onClick={()=>show('skill',item.id)}><CaretRight size={17}/></Button></article>)}{!visibleSkills.length&&<div className="ec-empty">没有匹配的 Skill</div>}</div>
      <div className="ec-section-title"><h2>发现更多</h2></div>
      <div className="ec-discover">{[{name:'访谈洞察',text:'从访谈中归纳主题与原话依据',icon:Sparkle},{name:'行动跟进',text:'聚合待办，整理负责人和截止日期',icon:CheckCircle}].map(item=><article key={item.name}><div className="ec-card-heading"><div className="ec-icon"><item.icon size={21}/></div><strong>{item.name}</strong></div><p>{item.text}</p><div className="ec-card-footer"><span>聆记 · 内置</span><Button onClick={()=>{setNotice('安装流程将在运行底座接入后开放。');}}>查看能力<ArrowUpRight size={14}/></Button></div></article>)}</div>
    </>}
    {view==='plugins'&&<>
      <div className="ec-toolbar"><h2>已添加 <span>3</span></h2></div>
      <div className="ec-plugin-list">{[{name:'会议资料',text:'读取会议转录、纪要与来源引用',kind:'内置',icon:FileText},{name:'团队知识库',text:'搜索团队文档，补充会议背景',kind:'MCP',icon:PlugsConnected},{name:'文档解析',text:'提取上传文档中的文字与表格',kind:'插件',icon:Stack}].map((item,index)=><article className="ec-plugin-row" key={item.name}><div className="ec-icon"><item.icon size={23}/></div><div className="ec-item-name"><strong>{item.name}<span className="ec-tag">{item.kind}</span></strong><span>{item.text}</span></div><span className={`ec-state ${plugins[index]?'success':''}`}>{plugins[index]?'已启用':'未启用'}</span><Toggle checked={plugins[index]} label={`${plugins[index]?'停用':'启用'}${item.name}`} onChange={()=>setPlugins(items=>items.map((value,i)=>i===index?!value:value))}/><Button onClick={()=>index===0?show('plugin'):setNotice('连接配置将在运行底座接入后开放。')}>管理</Button></article>)}</div>
      <div className="ec-permission-summary"><ShieldCheck size={20}/><div><strong>按任务授权</strong><p>运行前确认会议范围、所用工具与外部写入。</p></div></div>
    </>}
    {view==='runs'&&<>
      <div className="ec-run-summary">{[{label:'进行中',value:runs.filter(item=>['整理中','排队中'].includes(item.state)).length,tone:'active'},{label:'等待处理',value:runs.filter(item=>item.state==='等待处理').length,tone:'warn'},{label:'今日完成',value:runs.filter(item=>item.state==='已完成').length,tone:'success'}].map(item=><div key={item.label}><span className={`ec-dot ${item.tone}`}/><span>{item.label}</span><strong>{item.value}</strong></div>)}</div>
      <div className="ec-toolbar"><h2>全部任务</h2><Select label="筛选任务状态" value={filter} onChange={setFilter} options={[{value:'all',label:'全部状态'},{value:'active',label:'进行中'},{value:'warn',label:'等待处理'},{value:'success',label:'已完成'}]}/></div>
      <div className="ec-run-table"><div className="ec-table-head"><span>任务</span><span>状态</span><span>会议范围</span><span>更新时间</span><span/></div>{runs.filter(item=>filter==='all'||(filter==='active'?['整理中','排队中'].includes(item.state):filter==='warn'?item.state==='等待处理':item.state==='已完成')).map(item=><button className="ec-run-row" key={item.id} onClick={()=>show('run',item.id)}><div><strong>{item.name}</strong><span>{item.skill}</span></div><span className={`ec-state ${item.tone}`}>{item.state}</span><span>{item.materials}</span><time>{item.when}</time><CaretRight size={17}/></button>)}</div>
    </>}
    {view==='schedule'&&<>
      <div className="ec-toolbar"><h2>我的自动化 <span>{rules.length}</span></h2></div>
      <div className="ec-rule-list">{rules.map(item=><article className="ec-rule" key={item.id}><div className="ec-rule-top"><div className="ec-icon">{item.event==='ended'?<Lightning size={22}/>:<CalendarBlank size={22}/>}</div><div><h3>{item.name}</h3><span className={`ec-state ${item.enabled?'success':''}`}>{item.enabled?'已启用':'已停用'}</span></div><Toggle checked={item.enabled} label={`${item.enabled?'停用':'启用'}${item.name}`} onChange={()=>{if(!item.enabled&&!skills.find(skill=>skill.id===item.skill)?.enabled){setNotice('请先启用此规则使用的 Skill。');return;}setRules(values=>values.map(rule=>rule.id===item.id?{...rule,enabled:!rule.enabled}:rule));}}/></div><dl><div><dt>触发条件</dt><dd>{item.event==='ended'?'会议结束后':'每周五 17:00'}</dd></div><div><dt>使用 Skill</dt><dd>{skills.find(skill=>skill.id===item.skill)?.name}{!skills.find(skill=>skill.id===item.skill)?.enabled?' · 已停用':''}</dd></div><div><dt>会议范围</dt><dd>运行前确认</dd></div></dl><footer><span><Clock size={14}/>尚未接入运行</span><Button onClick={()=>show('rule',item.id)}>编辑</Button></footer></article>)}</div>
    </>}
    {view==='assistant'&&<div className="ec-assistant">
      <div className="ec-assistant-start"><div className="ec-assistant-mark"><Sparkle size={30}/></div><h2>从讨论到下一步</h2><p>选择会议，用 Skill 整理你关心的内容。</p><div className="ec-prompt-options">{['复盘本周产品进展','追踪会议中的决策','整理待办与负责人'].map(text=><button key={text} onClick={()=>setPrompt(text)}>{text}<ArrowUpRight size={14}/></button>)}</div></div>
      <div className="ec-composer"><div className="ec-composer-tools"><Button onClick={()=>show('sources')}><FileText size={16}/>{chosen.length?`${chosen.length} 场会议`:'选择会议'}<CaretRight size={14}/></Button><Select label="选择 Skill" value={assistantSkill?.id||''} onChange={setAssistantSkillId} disabled={!assistantSkill} options={enabledSkills.length?enabledSkills.map(item=>({value:item.id,label:item.name})):[{value:'',label:'暂无可用 Skill'}]}/></div><textarea aria-label="会议助手指令" placeholder="希望从这些会议中整理什么？" value={prompt} onChange={event=>setPrompt(event.target.value)}/><div className="ec-composer-bottom"><span>{chosen.length?'仅预览，不发送会议内容':'请先选择会议范围'}</span><Button variant="primary" disabled={!prompt.trim()||!chosen.length||!assistantSkill} onClick={()=>show('plan')}>预览任务<ArrowRight size={16}/></Button></div></div>
      {!!chosen.length&&<div className="ec-selected-sources">{chosen.map(item=><button key={item.id} onClick={()=>openRecord(item.id)}><FileText size={14}/>{item.title}<ArrowUpRight size={13}/></button>)}</div>}
    </div>}
    {drawer&&<div className="ec-preview-layer"><Modal title={drawerTitle||'扩展配置'} onClose={()=>setDrawer(null)}>
      <div className="ec-drawer-content">
        {drawer.kind==='skill'&&skill&&<><div className="ec-detail-identity"><div className="ec-icon"><skill.icon size={26}/></div><div><strong>{skill.name}</strong><span>v{skill.version} · 聆记</span></div><span className={`ec-state ${skill.enabled?'success':''}`}>{skill.enabled?'已启用':'已停用'}</span></div><div className="ec-detail-tabs">{[{id:'overview',label:'概览'},{id:'permissions',label:'权限'}].map(tab=><button key={tab.id} aria-pressed={detailTab===tab.id} onClick={()=>setDetailTab(tab.id)}>{tab.label}</button>)}</div>{detailTab==='overview'?<><section><h3>能力</h3><p>{skill.description}</p></section><section><h3>输出内容</h3><ul className="ec-check-list"><li><Check size={16}/>会议进展与关键结论</li><li><Check size={16}/>待办、负责人和待确认事项</li><li><Check size={16}/>关联原文与来源版本</li></ul></section><section><h3>使用方式</h3><div className="ec-inline-choice"><span>在会议助手中手动运行</span><ArrowRight size={16}/></div></section></>:<><section><h3>会议读取</h3><p>转录、纪要与笔记；每次运行单独选择范围。</p></section><section><h3>可用工具</h3><div className="ec-inline-choice"><FileText size={17}/><span>会议资料 · 只读</span><ShieldCheck size={17}/></div></section><section><h3>外部写入</h3><p>未授权</p></section></>}</>}
        {drawer.kind==='plugin'&&<><div className="ec-detail-identity"><div className="ec-icon"><FileText size={26}/></div><div><strong>会议资料</strong><span>聆记 · 内置插件</span></div><span className="ec-state success">只读</span></div><section><h3>可用工具 <span>3</span></h3>{['搜索会议','读取转录与纪要','获取来源引用'].map(name=><div className="ec-tool-row" key={name}><FileText size={16}/><span>{name}</span><Check size={16}/></div>)}</section><section><h3>权限范围</h3><p>仅限当前账户、当前任务选择的会议。</p><label className="ec-permission-choice"><span>允许读取会议材料</span><Toggle checked={plugins[0]} label="允许读取会议材料" onChange={()=>setPlugins(items=>items.map((value,i)=>i===0?!value:value))}/></label></section></>}
        {drawer.kind==='run'&&run&&<><div className="ec-run-detail-state"><span className={`ec-state ${run.tone}`}>{run.state}</span><span>{run.skill} · {run.materials}</span></div>{run.id==='r3'?<section className="ec-warning"><ShieldCheck size={20}/><div><h3>需要恢复指定版本</h3><p>此任务引用术语整理 v1.0.0。恢复该版本后才能继续。</p></div></section>:<ol className="ec-timeline">{['确认会议范围','读取会议材料','归纳与关联来源','保存整理结果'].map((text,index)=><li key={text} data-current={run.state==='整理中'&&index===2}><span>{run.state==='已完成'||(run.state==='整理中'&&index<2)?<Check size={13}/>:index+1}</span><div><strong>{text}</strong>{index===2&&run.state==='整理中'&&<p>正在整理会议主题</p>}</div></li>)}</ol>}<section><h3>运行配置</h3><dl className="ec-property-list"><div><dt>执行方式</dt><dd>Pi Durable · 方案预览</dd></div><div><dt>版本策略</dt><dd>任务锁定 Skill 版本</dd></div><div><dt>用量</dt><dd>尚未接入</dd></div></dl></section></>}
        {drawer.kind==='rule'&&<form id="ec-rule-form" onSubmit={event=>{event.preventDefault();const next={id:drawer.id||crypto.randomUUID(),name:ruleName.trim(),event:trigger,skill:ruleSkill,enabled:false};if(!next.name)return;setRules(items=>drawer.id?items.map(item=>item.id===drawer.id?{...next,enabled:item.enabled&&Boolean(skills.find(skill=>skill.id===ruleSkill)?.enabled)}:item):[...items,next]);setDrawer(null);setNotice('已保存本地规则预览。');}}><label>名称<input required maxLength={50} value={ruleName} onChange={event=>setRuleName(event.target.value)}/></label><label>触发条件<Select label="触发条件" value={trigger} onChange={setTrigger} options={[{value:'ended',label:'会议结束后'},{value:'weekly',label:'每周五 17:00'}]}/></label><label>使用 Skill<Select label="自动化 Skill" value={ruleSkill} onChange={setRuleSkill} options={skills.map(item=>({value:item.id,label:item.name+(item.enabled?'':' · 已停用')}))}/></label><div className="ec-warning"><ShieldCheck size={19}/><p>自动化运行前仍需确认会议读取与外部写入权限。</p></div></form>}
        {drawer.kind==='sources'&&<><div className="ec-source-list">{records.map(item=><label key={item.id}><input type="checkbox" checked={draftSelected.includes(item.id)} onChange={()=>setDraftSelected(values=>values.includes(item.id)?values.filter(id=>id!==item.id):[...values,item.id])}/><FileText size={19}/><span><strong>{item.title}</strong><small>{item.segments} 段转录 · {item.hasMinutes?'已有纪要':'尚无纪要'}</small></span></label>)}</div>{!records.length&&<div className="ec-empty">当前目录没有会议</div>}</>}
        {drawer.kind==='plan'&&<><section><h3>整理目标</h3><p>{prompt}</p></section><section><h3>会议范围 <span>{chosen.length}</span></h3>{chosen.map(item=><div className="ec-tool-row" key={item.id}><FileText size={17}/><span>{item.title}</span></div>)}</section><section><h3>运行能力</h3><dl className="ec-property-list"><div><dt>Skill</dt><dd>{assistantSkill?.name}</dd></div><div><dt>工具权限</dt><dd>会议资料 · 只读</dd></div><div><dt>外部写入</dt><dd>无</dd></div></dl></section><div className="ec-warning"><Pause size={19}/><p>运行底座待接入，本次预览不会执行任务。</p></div></>}
        {['import','connect'].includes(drawer.kind)&&<><div className="ec-upload"><UploadSimple size={30}/><h3>{drawer.kind==='import'?'导入 Skill 文件':'添加插件连接'}</h3><p>{drawer.kind==='import'?'SKILL.md 或 Skill 文件夹':'MCP 服务或本地插件包'}</p><Button disabled>{drawer.kind==='import'?'选择文件':'配置连接'}</Button></div><div className="ec-warning"><ShieldCheck size={19}/><p>安装、权限检查与工具发现将在运行底座接入后开放。</p></div></>}
      </div>
      <footer className="ec-drawer-footer"><Button onClick={()=>setDrawer(null)}>关闭</Button>{drawer.kind==='skill'&&skill&&<Button variant="primary" onClick={()=>{toggleSkill(skill.id);}}>{skill.enabled?'停用 Skill':'启用 Skill'}</Button>}{drawer.kind==='sources'&&<Button variant="primary" onClick={()=>{setSelected(draftSelected);setDrawer(null);}}>确认选择（{draftSelected.filter(id=>records.some(item=>item.id===id)).length}）</Button>}{drawer.kind==='rule'&&<Button variant="primary" form="ec-rule-form" type="submit">保存预览</Button>}{drawer.kind==='run'&&run&&['整理中','排队中'].includes(run.state)&&<Button onClick={()=>{setRuns(items=>items.map(item=>item.id===run.id?{...item,state:'已取消',tone:''}:item));}}>取消任务（预览）</Button>}</footer>
    </Modal></div>}
  </section>;
}
