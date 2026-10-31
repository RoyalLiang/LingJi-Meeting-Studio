// Throwaway fixed export and independent meeting extensions. No real platform or agent runtime.
const icons={close:'<path d="m6 6 12 12M18 6 6 18"/>',doc:'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 16h6"/>',tree:'<rect x="3" y="9" width="5" height="6" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="16" y="16" width="5" height="5" rx="1"/><path d="M8 12h4V5.5h4M12 12v6.5h4"/>',puzzle:'<path d="M4 9V4h5a3 3 0 1 1 6 0h5v6a3 3 0 1 0 0 6v4h-6a3 3 0 1 0-6 0H4v-6a3 3 0 1 0 0-5z"/>',record:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 8h10M7 12h7M7 16h5"/>',play:'<path d="m9 5 11 7-11 7z"/>',upload:'<path d="M12 15V3m-5 5 5-5 5 5M4 14v6h16v-6"/>',check:'<path d="m5 12 4 4L19 6"/>',lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',link:'<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m3 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>'};
const icon=(name)=>`<span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]||icons.doc}</svg></span>`;
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon).replace(/^<span class="icon">|<\/span>$/g,''));
const feishu=`<svg class="feishu-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="#2c78f5" d="m2 13 6-8 6 4-5 6z"/><path fill="#1cc6a2" d="m9 15 6-9 7 2-7 11z"/></svg>`;
const meeting={title:'产品体验周会',revision:3,transcriptRevision:12,topics:[{title:'产品主线',items:['先保证纪要可用、可追溯','导出保留 Markdown 与飞书云文档']},{title:'导入与协作',items:['纪要导入飞书云文档','主题树导入为可编辑画板']},{title:'独立扩展能力',items:['Skill 支持复盘与有来源的问答','pi harness 仍处于可行性评估']}],actions:[{text:'整理飞书导入内容映射',owner:'陈屿',due:'11 月 2 日'},{text:'完成扩展中心交互评审',owner:'周宁',due:'11 月 3 日'}]};
const nodeCount=1+meeting.topics.reduce((sum,topic)=>sum+1+topic.items.length,0);
console.assert(nodeCount===10,'Mindmap root, branches and leaves must reconcile');
console.assert(meeting.actions.length===2,'Preview action table count');

function documentPreview(inMeeting=false){return `<div class="preview-pane"><div class="section-label"><span>${inMeeting?'当前纪要':'云文档效果预览'}</span><span class="muted">${inMeeting?'3 个主题 · 保留人工修订':'保留标题层级、表格与引用'}</span></div><article class="document-frame"><div class="document-toolbar"><span class="provider-title">${inMeeting?icon('record')+'智能纪要':feishu+'飞书云文档 <span class="muted">/ 目标效果</span>'}</span><span>${inMeeting?'引用可追溯':'新建文档 · 权限继承'}</span></div><div class="paper"><div class="overline">产品与设计 / 会议纪要</div><h2>${meeting.title}</h2><div class="doc-meta">2026.10.30　·　42 分钟　·　纪要 v3 / 转录 v12</div><div class="callout">先收敛纪要导出，再独立推进会议扩展能力：保留 Markdown 与飞书云文档；Skill 暂不承担导出。</div><h3 id="topic-product">体验与产品方向</h3><ul><li>首版聚焦会议内容的整理与回顾。${scope.sources?'<span class="citation">[1] 08:24</span>':''}</li><li>纪要保留版本和来源，支持回到讨论现场。</li></ul><h3 id="topic-collaboration">导入与协作</h3><ul><li>云文档保留主题、结论与行动候选。</li><li>画板以主题树呈现，让讨论结构可以继续编辑。${scope.sources?'<span class="citation">[2] 16:10</span>':''}</li></ul>${scope.actions?`<h3 id="topic-actions">行动候选 <span class="tag">待负责人确认</span></h3><table class="doc-table"><thead><tr><th>事项</th><th>负责人</th><th>计划时间</th></tr></thead><tbody>${meeting.actions.map(a=>`<tr><td>${a.text}</td><td>${a.owner}</td><td>${a.due}</td></tr>`).join('')}</tbody></table>`:''}${scope.notes?'<h3>人工笔记</h3><p class="subtitle">先验证导入内容与引用一致，再确定正式接入范围。</p>':''}${scope.sources?'<div class="doc-source">引用原文（随快照保留）<br>[1] 08:24 林知夏：「先把会后的整理与回顾做好。」<br>[2] 16:10 陈屿：「树状结构放到画板上，还能继续编辑。」</div>':'<div class="doc-source">本次不导出引用原文。纪要版本信息仍会保留。</div>'}</div></article><div class="preview-caption"><span>${inMeeting?'示例纪要 · 仅供流程预览':'示意效果 · 非飞书真实页面'}</span><span>人工修订内容优先</span></div></div>`;}
function boardPreview(){return `<div class="preview-pane"><div class="section-label"><span>云文档效果预览</span><span class="muted">纪要正文 + 内嵌画板组件</span></div><article class="document-frame"><div class="document-toolbar"><span class="provider-title">${feishu}飞书云文档 <span class="muted">/ 目标效果</span></span><span>新建文档 · 权限继承</span></div><div class="paper component-paper"><div class="overline">产品与设计 / 会议纪要</div><h2>${meeting.title}</h2><div class="doc-meta">2026.10.30　·　42 分钟　·　纪要 v3 / 转录 v12</div><div class="callout">先打通飞书云文档导入；纪要树作为文档内的画板组件，和正文、引用保存在一起。</div><h3>讨论脉络</h3><div class="board-frame"><div class="board-toolbar"><span class="provider-title">${icon('tree')}纪要画板 <span class="muted">/ 云文档组件</span></span><span>思维导图</span></div><div class="board-grid"><div class="mindmap"><div class="node root">产品体验周会<small>2026.10.30 · 纪要 v3</small></div><div class="map-groups">${meeting.topics.map((t,i)=>`<div class="map-group"><div class="node branch">${t.title}</div>${t.items.map(text=>`<div class="node leaf">${text}<small>${scope.sources?`引用 ${Math.min(i+1,2)} · 转录 v12`:'仅纪要内容'}</small></div>`).join('')}</div>`).join('')}</div></div></div><div class="board-bottom"><span class="node-count">${nodeCount} 个节点 · 3 个主题</span><span>文档内可继续编辑</span></div></div>${scope.actions?`<h3>行动候选 <span class="tag">待负责人确认</span></h3><table class="doc-table"><thead><tr><th>事项</th><th>负责人</th><th>计划时间</th></tr></thead><tbody>${meeting.actions.map(a=>`<tr><td>${a.text}</td><td>${a.owner}</td><td>${a.due}</td></tr>`).join('')}</tbody></table>`:''}${scope.notes?'<h3>人工笔记</h3><p class="subtitle">先验证导入内容与引用一致，再确定正式接入范围。</p>':''}${scope.sources?'<div class="doc-source">引用原文（与画板保存在同一文档）<br>[1] 08:24 林知夏：「先把会后的整理与回顾做好。」<br>[2] 16:10 陈屿：「树状结构放到画板上，还能继续编辑。」</div>':''}</div></article><div class="preview-caption"><span>画板是云文档内的组件 · 非独立发布类型</span><span>原生树效果仍待飞书实测</span></div></div>`;}

const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scope = {sources:true,actions:true,notes:false};
const screens = ['meeting','export','feishu','skills','select','chat','review','receipt'];
const labels = ['会议纪要','导出方式','飞书导出','扩展中心','选择会议 Skill','会议助手','检查飞书导出','飞书导出回执'];
const params = new URLSearchParams(location.search);
let screen = params.get('screen') || ({doc:'feishu',board:'feishu',skill:'skills'}[params.get('variant')]) || 'meeting';
if (!screens.includes(screen)) screen = 'meeting';
const skills = [
  {id:'review',name:'会议复盘',description:'梳理讨论的共识、分歧与待确认事项，回答有来源的会议问题。',origin:'内置示例',installed:true,enabled:true,version:'1.0.0',target:'只读会议助手'},
  {id:'risk',name:'风险与决策梳理',description:'区分明确决策、讨论提议和行动候选；标记需要继续确认的风险。',origin:'内置示例',installed:true,enabled:true,version:'1.0.0',target:'只读会议助手'},
  {id:'terms',name:'会议术语解释',description:'结合本场上下文解释术语，给出引用与待核实内容，不修改原始纪要。',origin:'本地包示例',installed:false,enabled:false,version:'0.1.0',target:'只读会议助手'}
];
let assistantPane='chat', exportPane='settings', extensionView='list';
let extensionTab = params.get('tab')==='plugins'?'plugins':'skills', pluginDetail='meeting-data';
let selectedSkill = 'review', detailSkill = 'review', connected = true, includeBoard = params.get('variant') === 'board';
let messages = [], streaming = false, timer, candidate = null, confirmation = '', executionKey = '', execution = '', executionTimer, failNext = false;
const assistantScope={sources:true,actions:true,notes:false};
let initialRequest='这场会议形成了哪些共识，还有什么需要确认？';
let title = `${meeting.title} · 2026.10.30`, destination = '产品与设计 / 会议纪要';
const baseBody=()=>`# ${meeting.title}\n\n> 示例内容 · 纪要 v3 / 转录 v12 · 人工修订\n\n${meeting.topics.map(t=>`## ${t.title}\n${t.items.map(i=>'- '+i).join('\n')}`).join('\n\n')}${scope.actions?'\n\n## 行动候选\n'+meeting.actions.map(a=>`- ${a.text}（${a.owner} / ${a.due}）`).join('\n'):''}${scope.sources?'\n\n## 引用原文\n[1] 08:24 林知夏：先把会后的整理与回顾做好。\n[2] 16:10 陈屿：树状结构放到画板上，还能继续编辑。':''}${scope.notes?'\n\n## 人工笔记\n先核实内容映射，再确定接入范围。':''}`;
const analysisBody=()=>`# 会议复盘与待确认事项\n\n## 已形成的共识\n- 纪要导出聚焦 Markdown 与飞书云文档。\n- 画板保留为云文档内组件。\n- Skill 与插件作为独立扩展能力，暂不承担导出。\n\n## 仍需确认\n- 飞书真实租户的资源权限与画板渲染尚未验证。\n- pi 的接入范围与工具权限需要单独验证。${assistantScope.actions?'\n\n## 后续行动候选\n'+meeting.actions.map(a=>`- ${a.text}（${a.owner} / ${a.due}）`).join('\n'):''}${assistantScope.sources?'\n\n## 对应引用\n[1] 08:24 林知夏：先把会后的整理与回顾做好。\n[2] 16:10 陈屿：树状结构放到画板上，还能继续编辑。':''}${assistantScope.notes?'\n\n## 选中的笔记\n先核实内容映射，再确定接入范围。':''}`;
let draft = {revision:1,body:analysisBody(),edited:false};
const app = document.querySelector('#app');
const skill = () => skills.find(s => s.id === selectedSkill);
const readySkills = () => skills.filter(s => s.installed && s.enabled);
function toast(message) { const el=document.querySelector('#toast'); el.textContent=message; el.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.hidden=true,3500); }
function stopStream() { clearInterval(timer); if(streaming){streaming=false;messages.at(-1).stopped=true;} }
function go(next) {
  if (streaming && next !== 'chat') stopStream();
  document.querySelectorAll('dialog[open]').forEach(d=>d.close());
  if (next === 'review') confirmation='';
  screen=next; history.replaceState(null,'',`?screen=${screen}`); render(); window.scrollTo(0,0);
}
function heading(name,description,actions='') { return `<section class="page-heading"><div><h1>${name}</h1><p class="subtitle">${description}</p></div><div class="heading-actions">${actions}</div></section>`; }
const button = (text,action,primary=false,disabled=false) => `<button class="button ${primary?'primary':''}" data-action="${action}" ${disabled?'disabled':''}>${text}</button>`;
function meetingPage() {
  return heading(meeting.title,'2026 年 10 月 30 日 · 42 分钟 · 林知夏、陈屿、周宁',button(`${icon('puzzle')}会议助手`,'select')+button(`${icon('upload')}导出`,'export',true))+`<div class="meeting-tabs"><b>智能纪要</b><span>转录</span><span>人工笔记</span><small>已保存 · 人工修订版</small></div><div class="meeting-layout">${documentPreview(true)}<aside class="context-panel"><h3>会议目录</h3><a href="#topic-product"><span class="outline-index">1</span>体验与产品方向</a><a href="#topic-collaboration"><span class="outline-index">2</span>导入与协作</a><a href="#topic-actions"><span class="outline-index">3</span>行动候选</a><div class="rule"></div><h4>本场会议</h4><p>${meeting.topics.length} 个讨论主题<br>${meeting.actions.length} 项行动候选<br>纪要 v3 / 转录 v12</p><div class="rule"></div><p>助手只读所选内容。<br>导出使用独立固定流程。</p></aside></div>`;
}
function scopes(assistant=false) {
  const selected=assistant?assistantScope:scope;
  return `<div class="scope-title">${assistant?'助手可读取的内容':'导出内容'}</div><label class="check-row"><input checked disabled type="checkbox">已保存的纪要 <small>v3 · 人工修订</small></label>${[['actions','行动候选','不创建任务'],['sources','引用原文','仅引用片段'],['notes','人工笔记','默认不勾选']].map(([key,name,hint])=>`<label class="check-row"><input type="checkbox" ${assistant?'data-assistant-scope':'data-scope'}="${key}" ${selected[key]?'checked':''}>${name}<small>${hint}</small></label>`).join('')}`;
}
function connection() { return `<div class="connection"><div class="provider-title">${feishu}<div><b>飞书 · 产品与设计团队</b><small>${connected?'已连接 · 演示':'需要连接 · 演示'}</small></div></div><button class="plain" data-action="connect">${connected?'模拟断开':'模拟连接'}</button></div>`; }
function feishuPage() {
  return heading('导出到飞书','创建一份云文档，画板作为正文内的可选组件。',button('返回导出方式','export'))+`<div class="export-pane-tabs"><button data-export-pane="settings" class="${exportPane==='settings'?'active':''}">导出设置</button><button data-export-pane="preview" class="${exportPane==='preview'?'active':''}">内容预览</button></div><div class="publish-layout" data-pane="${exportPane}">${includeBoard?boardPreview():documentPreview()}<aside class="settings-panel"><h2>飞书云文档</h2>${connection()}<label class="field">目标文件夹<select id="destination"><option>产品与设计 / 会议纪要</option><option>我的空间 / 会议纪要</option></select></label><label class="field">文档标题<input id="title" value="${esc(title)}"></label><div class="scope-title">文档组件</div><label class="check-row"><input id="include-board" type="checkbox" ${includeBoard?'checked':''}>插入纪要画板<small>可编辑大纲树</small></label><p class="helper">正文、画板、表格和引用保存在同一文档中。</p>${scopes()}<div class="rule"></div>${button('下一步：检查导出内容','feishu-review',true,!connected)}<p class="helper">当前为演示，不创建真实文档。</p></aside></div>`;
}
const plugins=[
  {id:'meeting-data',name:'会议内容工具',type:'内置能力',status:'已启用 · 演示',description:'只向助手提供用户选中的会议快照和引用，不开放整个工作目录。',capabilities:['读取所选会议纪要','读取勾选的引用与笔记'],enabled:true},
  {id:'feishu',name:'飞书云文档连接',type:'内置连接',status:'独立授权',description:'供固定的飞书导出流程使用。启用会议 Skill 不会获得这项写入能力。',capabilities:['读取用户选定的文件夹','经本次确认后创建文档'],enabled:true},
  {id:'knowledge',name:'会议资料检索',type:'MCP 扩展提议',status:'待验证',description:'在用户明确选定的资料库中检索，结果附带来源；本轮没有接入。',capabilities:['检索选定资料库（只读）'],enabled:false}
];
function extensionTabs(){return `<div class="extension-tabs"><button data-extension-tab="skills" class="${extensionTab==='skills'?'active':''}">Skills <small>方法与知识</small></button><button data-extension-tab="plugins" class="${extensionTab==='plugins'?'active':''}">插件与连接 <small>程序能力</small></button></div>`;}
function skillsPage() {
  const current=skills.find(s=>s.id===detailSkill), plugin=plugins.find(p=>p.id===pluginDetail);
  const library=extensionTab==='skills'?`<div class="library-heading"><h2>技能库 <small>${skills.filter(s=>s.installed).length} 已安装</small></h2><span class="tag">独立会议能力</span></div>${skills.map(s=>`<button class="skill-row ${current.id===s.id?'selected-skill':''}" data-detail="${s.id}">${icon('puzzle')}<div><h3>${s.name}<span class="tag">${s.installed?(s.enabled?'已启用':'已停用'):'未安装'}</span></h3><p>${s.description}</p><small>${s.origin} · v${s.version} · ${s.target}</small></div><span>›</span></button>`).join('')}`:`<div class="library-heading"><h2>插件与连接</h2><span class="tag">工具权限独立管理</span></div>${plugins.map(p=>`<button class="skill-row ${plugin.id===p.id?'selected-skill':''}" data-plugin="${p.id}">${icon(p.id==='feishu'?'doc':'link')}<div><h3>${p.name}<span class="tag">${p.status}</span></h3><p>${p.description}</p><small>${p.type}</small></div><span>›</span></button>`).join('')}`;
  const detail=extensionTab==='skills'?`<p class="mini-label">Skill 详情</p><h2>${current.name}</h2><p class="subtitle">${current.description}</p><dl><dt>来源</dt><dd>${current.origin}</dd><dt>版本</dt><dd>v${current.version}</dd><dt>兼容性</dt><dd>指引与资料 · 浏览器可用</dd><dt>可用工具</dt><dd>会议内容工具 · 仅限本场</dd></dl><h4>使用范围</h4><p class="helper">读取所选纪要与引用<br>生成独立分析与问答<br>不改写纪要，不执行导出</p><details class="skill-package"><summary>查看技能包内容</summary><div class="manifest">SKILL.md<br>references/review-guide.md</div></details><div class="notice">只读你选中的会议内容，不改写纪要，也不会对外发送。</div>${current.installed?button(current.enabled?'停用 Skill':'启用 Skill','toggle-skill')+button('在本场会议中使用','use-skill',true,!current.enabled):button('预览并安装','install',true)}`:`<p class="mini-label">${plugin.type}</p><h2>${plugin.name}</h2><p class="subtitle">${plugin.description}</p><dl><dt>状态</dt><dd>${plugin.status}</dd><dt>范围</dt><dd>${plugin.id==='feishu'?'选定飞书文件夹':'用户明确选择的资料'}</dd><dt>授权</dt><dd>${plugin.id==='feishu'?'连接授权 + 每次导出确认':'工具能力白名单'}</dd></dl><h4>能力清单</h4><ul class="capability-list">${plugin.capabilities.map(c=>`<li>${c}</li>`).join('')}</ul>${plugin.id==='feishu'?connection():plugin.id==='meeting-data'?button(plugin.enabled?'停用内容工具':'启用内容工具','toggle-plugin'):button('等待兼容性验证','unavailable',false,true)}<div class="notice">${plugin.id==='meeting-data'?'仅能读取当前选中的会议快照与引用，不访问其他会议。':plugin.id==='feishu'?'此连接只服务飞书导出，会议助手不会自动获得写入权限。':'此连接尚未验证兼容性，当前不会加载或运行。'}</div>`;
  return heading('扩展中心','Skills 决定如何理解会议；插件与连接提供程序能力。导出保持独立。',(extensionTab==='skills'?button('导入 Skill','install',true):'')+button('返回纪要','meeting'))+extensionTabs()+`<div class="management-layout" data-view="${extensionView}"><section class="skill-library">${library}<div class="library-note">${extensionTab==='skills'?'使用时只处理你选中的会议内容，已安装的 Skill 可随时启停。':'每个连接分别授权。启用 Skill 不会自动开放工具或外部写入权限。'}</div></section><aside class="settings-panel skill-detail"><button class="detail-back" data-action="extension-list">${icon('arrow')}${extensionTab==='skills'?'返回技能列表':'返回连接列表'}</button>${detail}</aside></div>`;
}
function selectPage() {
  return heading('打开会议助手','选择已启用的 Skill，基于这场会议做复盘、问答或风险梳理。',button('扩展中心','skills'))+`<div class="selection-layout"><section class="skill-library"><div class="library-heading"><h2>选择会议 Skill</h2><span class="tag">暂不提供导出</span></div>${readySkills().length?readySkills().map(s=>`<button class="skill-choice ${selectedSkill===s.id?'chosen':''}" data-select="${s.id}"><span class="radio-dot"></span><div><h3>${s.name}</h3><p>${s.description}</p><small>${s.origin} · ${s.target}</small></div>${icon('arrow')}</button>`).join(''):'<div class="empty"><h3>还没有可用的 Skill</h3><p>先在扩展中心安装或启用一个 Skill。</p>'+button('前往扩展中心','skills',true)+'</div>'}<div class="library-note">助手生成独立结果，不替换已保存的纪要，也不调用飞书导出。</div></section><aside class="settings-panel"><h2>限定本次读取范围</h2>${scopes(true)}<label class="field">想了解什么<textarea id="initial-request" rows="4">${esc(initialRequest)}</textarea></label><div class="source-strip">产品体验周会<br><small>纪要 v3 / 转录 v12 · 只读快照</small></div>${button('开始会议分析 '+icon('arrow'),'start-chat',true,!readySkills().some(s=>s.id===selectedSkill)||!plugins[0].enabled)}<p class="helper">${plugins[0].enabled?'不会读取其他会议或执行外部操作。':'会议内容工具已停用，请先到扩展中心启用。'}</p></aside></div>`;
}
function draftPreview() {
  return `<section class="artifact"><div class="artifact-header"><div><p class="mini-label">独立分析结果</p><h3>${skill().name} <span class="tag">${draft.revision?'v'+draft.revision:'待生成'}${draft.edited?' · 人工编辑':''}</span></h3></div><button class="plain" data-action="edit-draft" ${streaming?'disabled':''}>编辑分析稿</button></div><div class="artifact-body">${!draft.revision?'<div class="draft-empty"><h3>正在形成分析结果</h3><p>Skill 只处理这次选择的会议快照。完成后可查看引用或继续提问。</p><small>不会更改原始纪要或触发导出。</small></div>':draft.body.split('\n').map(line=>line.startsWith('# ')?`<h2>${esc(line.slice(2))}</h2>`:line.startsWith('## ')?`<h4>${esc(line.slice(3))}</h4>`:line.startsWith('- ')?`<p class="draft-item">${esc(line.slice(2))}</p>`:line?`<p>${esc(line)}</p>`:'').join('')}</div><div class="artifact-footer">基于纪要 v3 / 转录 v12 · 独立分析，不回写原始纪要</div></section>`;
}
function conversation() {
  if(!messages.length)messages=[{role:'user',text:'这场会议形成了哪些共识，还有什么需要确认？'},{role:'assistant',text:'已根据纪要 v3 和转录 v12 整理了共识与待确认事项。导出保留 Markdown 与飞书云文档；Skill 和插件转为独立的会议扩展能力。pi 的接入仍需验证。对应引用与分析结果见结果区。'}];
  return messages.map(m=>`<div class="message ${m.role}"><div class="speaker">${m.role==='user'?'林知夏':`${icon('puzzle')}${skill().name}`}${m.role==='assistant'?'<small>Skill · 模拟回复</small>':''}</div><div class="message-body">${esc(m.text).replace(/\n/g,'<br>')}${m===messages.at(-1)&&streaming?'<span class="stream-caret">▍</span>':''}</div>${m.stopped?'<small class="muted">已停止分析 · 已有结果保持不变</small>':''}</div>`).join('');
}
function chatPage() {
  return heading('会议助手','基于当前会议复盘与问答，结论保留原文引用。',button('更换 Skill','select')+button('返回纪要','meeting'))+`<div class="chat-context"><span>${icon('puzzle')}${skill().name} · v${skill().version}</span><span class="meeting-reference">${meeting.title}<small>纪要 v3 / 转录 v12</small></span><span>只读当前会议 · 不对外发送</span></div><div class="mobile-pane-tabs"><button data-assistant-pane="chat" class="${assistantPane==='chat'?'active':''}">对话</button><button data-assistant-pane="result" class="${assistantPane==='result'?'active':''}">分析结果</button></div><div class="chat-layout" data-pane="${assistantPane}"><section class="chat-pane"><div class="pane-header"><h2>对话</h2><span>可继续追问</span></div><div class="thread" id="thread" role="log" aria-label="会议助手对话" aria-live="polite">${conversation()}</div><div id="candidate-banner">${candidateMarkup()}</div><div class="chat-suggestions"><button data-prompt="哪些结论已确定，哪些仍是提议？">区分决策与提议</button><button data-prompt="请突出风险与待确认事项，并保留来源。">梳理待确认事项</button><button class="plain" data-action="regenerate">重新演示分析</button></div><form id="chat-form"><label for="chat-input" class="sr-only">向会议助手提问</label><textarea id="chat-input" rows="2" placeholder="例如：有哪些尚未达成共识的问题？" ${streaming?'disabled':''}></textarea><div class="composer-footer"><small>${streaming?'正在流式分析 · 本地模拟，可停止':'只读所选会议；不改写纪要，不导出。'}</small>${streaming?'<button type="button" class="button" data-action="stop-stream">停止分析</button>':'<button type="submit" class="button primary">发送 '+icon('arrow')+'</button>'}</div></form></section><div id="artifact-region">${draftPreview()}</div></div>`;
}
function candidateMarkup() {return candidate?`<div class="notice candidate"><b>新的整理建议已就绪</b><p>人工草稿保持原样，只有采用后才会替换。</p><details><summary>查看建议内容</summary><pre>${esc(candidate.body)}</pre></details>${button('保留人工稿','keep-draft')}${button('采用新建议','apply-candidate',true)}</div>`:'';}
const snapshotKey=()=>JSON.stringify([meeting.revision,meeting.transcriptRevision,scope,title,destination,includeBoard,connected]);
function reviewPage() {
  return heading('检查飞书导出','核对当前纪要、内嵌组件和目标位置。修改内容后，需要重新确认。',button('返回配置','feishu'))+`<div class="review-layout"><div>${includeBoard?boardPreview():documentPreview()}</div><aside class="settings-panel"><h2>本次飞书导出</h2><dl><dt>目标</dt><dd>飞书云文档</dd><dt>文档组件</dt><dd>${includeBoard?'正文与内嵌纪要画板':'纪要正文'}</dd><dt>内容版本</dt><dd>纪要 v3 · 人工修订</dd><dt>转录来源</dt><dd>v12 · ${scope.sources?'附引用原文':'不含引用原文'}</dd><dt>执行方式</dt><dd>内置固定导出流程</dd></dl>${connection()}<label class="field">目标文件夹<select id="destination"><option>产品与设计 / 会议纪要</option><option>我的空间 / 会议纪要</option></select></label><label class="field">文档标题<input id="title" value="${esc(title)}"></label><div class="notice">按目标文件夹权限创建。Skill 与插件不会自动介入此次导出。</div><p class="helper">不发送原始录音、完整转录或群消息；不创建任务。</p><label class="consent"><input id="export-consent" type="checkbox">已核对内容、目标与本次写入范围</label>${button('模拟确认飞书导出','execute',true,true)}<details class="demo-controls"><summary>原型异常状态</summary><label class="check-row"><input id="simulate-failure" type="checkbox" ${failNext?'checked':''}>模拟执行失败</label></details></aside></div>`;
}

function receiptPage() {
  const failed=execution==='failed',busy=execution==='running';
  return heading(busy?'正在导出飞书':failed?'飞书导出演示未完成':'飞书导出演示已完成',busy?'按已确认的计划逐步执行，不调用 Skill。':failed?'本次执行在写入前模拟失败，没有创建任何外部资源。':'这是本地模拟回执，未创建真实飞书文档。',button('返回纪要','meeting'))+`<section class="receipt-panel"><div class="receipt-symbol">${busy?'…':failed?'!':'✓'}</div><h2>${busy?'正在准备导出':failed?'模拟连接中断':'固定导出流程已走通'}</h2><p>飞书云文档 · ${includeBoard?'含内嵌纪要画板':'纪要正文'}</p><div class="execution-steps"><div>✓ 冻结纪要 v3 / 转录 v12</div><div>${busy?'…':failed?'!':'✓'} 检查目标与写入范围</div><div>${busy||failed?'○':'✓'} 模拟写入并核对结果</div><div>${busy||failed?'○':'✓'} 生成回执</div></div><dl><dt>计划编号</dt><dd>demo-feishu-1030</dd><dt>来源</dt><dd>纪要 v3 / 转录 v12</dd><dt>内容</dt><dd>已保存的人工修订版</dd><dt>目标</dt><dd>${esc(destination)}</dd></dl><div class="receipt-actions">${busy?'':failed?button('返回检查','review')+button('模拟重试同一计划','retry',true):button('返回会议纪要','meeting',true)+button('查看导出配置','feishu')}</div><p class="helper">真实实现需保存资源 ID、内容摘要与阶段回执。未知写入结果先核对远端，不能盲目重建。</p></section>`;
}
function render() {
  const views={meeting:meetingPage,export:meetingPage,feishu:feishuPage,skills:skillsPage,select:selectPage,chat:chatPage,review:reviewPage,receipt:receiptPage};
  document.body.dataset.screen=screen;
  app.innerHTML=views[screen]();
  document.querySelector('#breadcrumb').textContent=screen==='skills'?'工作空间设置 / 扩展中心':'产品与设计 / 产品体验周会';
  document.querySelector('#screen-label').textContent=`${String(screens.indexOf(screen)+1).padStart(2,'0')} / 08 · 预览 ${labels[screens.indexOf(screen)]}`;
  document.querySelectorAll('[data-go]').forEach(el=>el.onclick=()=>go(el.dataset.go));
  document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
  document.querySelectorAll('[data-assistant-pane]').forEach(el=>el.onclick=()=>{assistantPane=el.dataset.assistantPane;document.querySelector('.chat-layout').dataset.pane=assistantPane;document.querySelectorAll('[data-assistant-pane]').forEach(b=>b.classList.toggle('active',b.dataset.assistantPane===assistantPane));});
  document.querySelectorAll('[data-export-pane]').forEach(el=>el.onclick=()=>{exportPane=el.dataset.exportPane;document.querySelector('.publish-layout').dataset.pane=exportPane;document.querySelectorAll('[data-export-pane]').forEach(b=>b.classList.toggle('active',b.dataset.exportPane===exportPane));});
  document.querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>action(el.dataset.action));
  document.querySelectorAll('[data-detail]').forEach(el=>el.onclick=()=>{detailSkill=el.dataset.detail;extensionView='detail';render();});
  document.querySelectorAll('[data-extension-tab]').forEach(el=>el.onclick=()=>{extensionTab=el.dataset.extensionTab;extensionView='list';history.replaceState(null,'',`?screen=skills&tab=${extensionTab}`);render();});
  document.querySelectorAll('[data-plugin]').forEach(el=>el.onclick=()=>{pluginDetail=el.dataset.plugin;extensionView='detail';render();});
  document.querySelectorAll('[data-assistant-scope]').forEach(el=>el.onchange=()=>{assistantScope[el.dataset.assistantScope]=el.checked;render();});
  document.querySelectorAll('[data-select]').forEach(el=>el.onclick=()=>{selectedSkill=el.dataset.select;render();});
  document.querySelectorAll('[data-scope]').forEach(el=>el.onchange=()=>{scope[el.dataset.scope]=el.checked;confirmation='';render();});
  document.querySelector('#include-board')?.addEventListener('change',e=>{includeBoard=e.target.checked;render();});
  document.querySelector('#destination')?.addEventListener('change',e=>{destination=e.target.value;invalidateConfirmation();});
  if(document.querySelector('#destination'))document.querySelector('#destination').value=destination;
  document.querySelector('#initial-request')?.addEventListener('input',e=>initialRequest=e.target.value);
  document.querySelector('#title')?.addEventListener('input',e=>{title=e.target.value;invalidateConfirmation();});
  document.querySelector('#export-consent')?.addEventListener('change',e=>{confirmation=e.target.checked?snapshotKey():'';document.querySelector('[data-action=execute]').disabled=!confirmation||!connected;});
  document.querySelector('#simulate-failure')?.addEventListener('change',e=>failNext=e.target.checked);
  document.querySelectorAll('[data-prompt]').forEach(el=>el.onclick=()=>startStream(el.dataset.prompt));
  document.querySelector('#chat-form')?.addEventListener('submit',e=>{e.preventDefault();const text=document.querySelector('#chat-input').value.trim();if(text)startStream(text);});
  if(screen==='export')document.querySelector('#export-dialog').showModal();
}
function invalidateConfirmation(){confirmation='';const input=document.querySelector('#export-consent');if(input)input.checked=false;const execute=document.querySelector('[data-action=execute]');if(execute)execute.disabled=true;}
function suggestedBody(prompt) {
  let body=analysisBody();
  if(/决策|提议/.test(prompt))body=body.replace('会议复盘与待确认事项','决策与提议核对').replace('## 已形成的共识','## 已明确的方向');
  if(/风险|待确认/.test(prompt))body=body.replace('会议复盘与待确认事项','会议风险与待确认事项');
  return body;
}
function startStream(prompt) {
  if(streaming)return;
  if(!plugins[0].enabled||!readySkills().some(s=>s.id===selectedSkill)){toast('请先启用所选 Skill 与会议内容工具。');return;}
  messages.push({role:'user',text:prompt},{role:'assistant',text:''}); streaming=true; confirmation=''; screen='chat';history.replaceState(null,'','?screen=chat');render();
  const response=Array.from(`我会按你的要求调整：「${prompt}」\n\n先核对纪要 v3 与转录 v12，再整理关键共识和两项后续行动。只读取本次选择的会议内容，不读取其他会议，也不执行导出。\n\n${draft.edited?'当前有人工编辑，我会先提供整理建议，等待你决定是否采用。':'分析结果完成后会显示在结果区，可以继续提问；不会改写纪要。'}\n\n以上为示例分析，未调用真实模型。`);
  let offset=0;
  timer=setInterval(()=>{
    offset+=5;messages.at(-1).text=response.slice(0,offset).join('');
    const thread=document.querySelector('#thread');if(thread){thread.innerHTML=conversation();thread.scrollTop=thread.scrollHeight;}
    if(offset>=response.length){
      clearInterval(timer);streaming=false;
      const next={revision:draft.revision+1,body:suggestedBody(prompt),edited:false};
      if(draft.edited)candidate=next;else draft=next;
      render();
    }
  },90);
}
function execute(retry=false) {
  if(retry&&executionKey!==snapshotKey()){toast('原导出计划已变化，请重新检查并确认。');return;}
  if(!retry&&confirmation!==snapshotKey()){toast('内容或目标已变化，请重新核对并确认。');return;}
  if(!connected){toast('请先连接飞书。');return;}
  if(!retry)executionKey=snapshotKey();
  execution='running';go('receipt');clearTimeout(executionTimer);
  executionTimer=setTimeout(()=>{execution=failNext?'failed':'done';failNext=false;if(screen==='receipt')render();},1500);
}
function download(body,name) {const blob=new Blob([body],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('示例 Markdown 已开始下载。');}
function action(name) {
  if(screens.includes(name)){go(name);return;}
  if(name==='connect'){connected=!connected;invalidateConfirmation();render();toast(connected?'已模拟连接飞书，没有执行真实授权。':'已模拟断开飞书。');}
  if(name==='extension-list'){extensionView='list';render();}
  if(name==='toggle-plugin'){plugins[0].enabled=!plugins[0].enabled;plugins[0].status=plugins[0].enabled?'已启用 · 演示':'已停用';render();}
  if(name==='install')document.querySelector('#install-dialog').showModal();
  if(name==='toggle-skill'){const s=skills.find(s=>s.id===detailSkill);s.enabled=!s.enabled;render();}
  if(name==='use-skill'){selectedSkill=detailSkill;go('select');}
  if(name==='start-chat'){const request=document.querySelector('#initial-request').value.trim();if(!plugins[0].enabled||!readySkills().some(s=>s.id===selectedSkill))return;draft={revision:0,body:'',edited:false};messages=[];candidate=null;go('chat');messages=[];startStream(request||'整理本场纪要，保留决策与引用。');}
  if(name==='regenerate')startStream('重新复盘本场会议，保留引用与待确认事项。');
  if(name==='stop-stream'){stopStream();render();}
  if(name==='edit-draft'){document.querySelector('#draft-editor').value=draft.body;document.querySelector('#editor-dialog').showModal();}
  if(name==='apply-candidate'){draft=candidate;candidate=null;confirmation='';render();}
  if(name==='keep-draft'){candidate=null;render();}

  if(name==='feishu-review')go('review');
  if(name==='execute')execute();
  if(name==='retry')execute(true);

}
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('cancel',()=>{if(dialog.id==='export-dialog')go('meeting');});
for(const el of document.querySelectorAll('[data-close]'))el.onclick=()=>{document.querySelector('#'+el.dataset.close).close();if(el.dataset.close==='export-dialog')go('meeting');};
document.querySelector('#markdown-export').onclick=()=>{download(baseBody(),'产品体验周会-纪要示例.md');document.querySelector('#export-dialog').close();go('meeting');};
document.querySelector('#feishu-export').onclick=()=>go('feishu');

document.querySelector('#install-consent').onchange=e=>document.querySelector('#install-confirm').disabled=!e.target.checked;
document.querySelector('#install-confirm').onclick=()=>{const s=skills.find(s=>s.id==='terms');s.installed=true;s.enabled=true;detailSkill=s.id;extensionView='detail';document.querySelector('#install-dialog').close();go('skills');toast('示例技能已安装到本页内存，刷新后清除。');};
document.querySelector('#save-editor').onclick=()=>{draft={revision:draft.revision+1,body:document.querySelector('#draft-editor').value,edited:true};confirmation='';document.querySelector('#editor-dialog').close();render();};
function cycle(delta){const index=screens.indexOf(screen);go(screens[(index+delta+screens.length)%screens.length]);}
document.querySelector('#previous').onclick=()=>cycle(-1);document.querySelector('#next').onclick=()=>cycle(1);
document.addEventListener('keydown',e=>{if(e.target.closest('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open]'))return;if(e.key==='ArrowLeft')cycle(-1);if(e.key==='ArrowRight')cycle(1);});
console.assert(skills.filter(s=>s.installed).length===2,'Two built-in example skills');
console.assert(baseBody().includes('云文档')&&nodeCount===10,'Document snapshot and 10-node board');
console.assert(suggestedBody('区分决策与提议').includes('决策与提议核对'),'Skill changes analysis, not export');
console.assert(!suggestedBody('私密整理要求示例').includes('私密整理要求示例'),'Instructions stay out of exported content');
render();
