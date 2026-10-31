// Throwaway end-to-end export prototype. Every stream and platform operation is simulated.
const icons={doc:'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 16h6"/>',tree:'<rect x="3" y="9" width="5" height="6" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="16" y="16" width="5" height="5" rx="1"/><path d="M8 12h4V5.5h4M12 12v6.5h4"/>',puzzle:'<path d="M4 9V4h5a3 3 0 1 1 6 0h5v6a3 3 0 1 0 0 6v4h-6a3 3 0 1 0-6 0H4v-6a3 3 0 1 0 0-5z"/>',record:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 8h10M7 12h7M7 16h5"/>',play:'<path d="m9 5 11 7-11 7z"/>',upload:'<path d="M12 15V3m-5 5 5-5 5 5M4 14v6h16v-6"/>',check:'<path d="m5 12 4 4L19 6"/>',lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',link:'<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m3 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>'};
const icon=(name)=>`<span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]||icons.doc}</svg></span>`;
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon).replace(/^<span class="icon">|<\/span>$/g,''));
const feishu=`<svg class="feishu-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="#2c78f5" d="m2 13 6-8 6 4-5 6z"/><path fill="#1cc6a2" d="m9 15 6-9 7 2-7 11z"/></svg>`;
const meeting={title:'产品体验周会',revision:3,transcriptRevision:12,topics:[{title:'体验与产品方向',items:['首版聚焦会议内容的整理与回顾','保留引用，随时回到讨论现场']},{title:'导入与协作',items:['纪要导入飞书云文档','主题树导入为可编辑画板']},{title:'发布与后续行动',items:['先预览，再由用户确认发布','发布流程保留人工修改']}],actions:[{text:'整理飞书导入内容映射',owner:'陈屿',due:'11 月 2 日'},{text:'完成引导发布交互评审',owner:'周宁',due:'11 月 3 日'}]};
const nodeCount=1+meeting.topics.reduce((sum,topic)=>sum+1+topic.items.length,0);
console.assert(nodeCount===10,'Mindmap root, branches and leaves must reconcile');
console.assert(meeting.actions.length===2,'Preview action table count');

function documentPreview(inMeeting=false){return `<div class="preview-pane"><div class="section-label"><span>${inMeeting?'当前纪要':'云文档效果预览'}</span><span class="muted">${inMeeting?'3 个主题 · 保留人工修订':'保留标题层级、表格与引用'}</span></div><article class="document-frame"><div class="document-toolbar"><span class="provider-title">${inMeeting?icon('record')+'智能纪要':feishu+'飞书云文档 <span class="muted">/ 目标效果</span>'}</span><span>${inMeeting?'引用可追溯':'新建文档 · 权限继承'}</span></div><div class="paper"><div class="overline">产品与设计 / 会议纪要</div><h2>${meeting.title}</h2><div class="doc-meta">2026.10.30　·　42 分钟　·　纪要 v3 / 转录 v12</div><div class="callout">围绕「让会议内容继续流动」达成共识：先打通飞书导入，再用可安装的技能，引导用户完成跨平台发布。</div><h3>01　体验与产品方向</h3><ul><li>首版聚焦会议内容的整理与回顾。${scope.sources?'<span class="citation">[1] 08:24</span>':''}</li><li>纪要保留版本和来源，支持回到讨论现场。</li></ul><h3>02　导入与协作</h3><ul><li>云文档保留主题、结论与行动候选。</li><li>画板以主题树呈现，让讨论结构可以继续编辑。${scope.sources?'<span class="citation">[2] 16:10</span>':''}</li></ul>${scope.actions?`<h3>03　行动候选 <span class="tag">待负责人确认</span></h3><table class="doc-table"><thead><tr><th>事项</th><th>负责人</th><th>计划时间</th></tr></thead><tbody>${meeting.actions.map(a=>`<tr><td>${a.text}</td><td>${a.owner}</td><td>${a.due}</td></tr>`).join('')}</tbody></table>`:''}${scope.notes?'<h3>人工笔记</h3><p class="subtitle">先验证导入内容与引用一致，再确定正式接入范围。</p>':''}${scope.sources?'<div class="doc-source">引用原文（随快照保留）<br>[1] 08:24 林知夏：「先把会后的整理与回顾做好。」<br>[2] 16:10 陈屿：「树状结构放到画板上，还能继续编辑。」</div>':'<div class="doc-source">本次不导出引用原文。纪要版本信息仍会保留。</div>'}</div></article><div class="preview-caption"><span>${inMeeting?'示例纪要 · 仅供流程预览':'示意效果 · 非飞书真实页面'}</span><span>人工修订内容优先</span></div></div>`;}
function boardPreview(){return `<div class="preview-pane"><div class="section-label"><span>云文档效果预览</span><span class="muted">纪要正文 + 内嵌画板组件</span></div><article class="document-frame"><div class="document-toolbar"><span class="provider-title">${feishu}飞书云文档 <span class="muted">/ 目标效果</span></span><span>新建文档 · 权限继承</span></div><div class="paper component-paper"><div class="overline">产品与设计 / 会议纪要</div><h2>${meeting.title}</h2><div class="doc-meta">2026.10.30　·　42 分钟　·　纪要 v3 / 转录 v12</div><div class="callout">先打通飞书云文档导入；纪要树作为文档内的画板组件，和正文、引用保存在一起。</div><h3>讨论脉络</h3><div class="board-frame"><div class="board-toolbar"><span class="provider-title">${icon('tree')}纪要画板 <span class="muted">/ 云文档组件</span></span><span>思维导图</span></div><div class="board-grid"><div class="mindmap"><svg viewBox="0 0 670 458" aria-hidden="true"><path d="M145 230H165Q180 230 180 215V111Q180 96 202 96M165 230H202M180 230V342Q180 356 202 356M318 96H334Q348 96 348 80V68Q348 62 371 62M348 80V124Q348 130 371 130M318 225H334Q348 225 348 205V198Q348 194 371 194M348 205V253Q348 258 371 258M318 356H334Q348 356 348 337V330Q348 324 371 324M348 337V383Q348 389 371 389"/></svg><div class="node root">产品体验周会<small style="display:block;font-size:11px;font-weight:400;margin-top:4px;color:#d8e7dc">2026.10.30 · 纪要 v3</small></div>${meeting.topics.map((t,i)=>`<div class="node branch ${['one','two','three'][i]}">${t.title}</div>${t.items.map((text,j)=>`<div class="node leaf l${i*2+j+1}">${text}<small>${scope.sources?`引用 ${Math.min(i+1,2)} · 转录 v12`:'仅纪要内容 · 不含引用原文'}</small></div>`).join('')}`).join('')}</div></div><div class="board-bottom"><span class="node-count">${nodeCount} 个节点 · 3 个主题</span><span>文档内可继续编辑</span></div></div>${scope.actions?`<h3>行动候选 <span class="tag">待负责人确认</span></h3><table class="doc-table"><thead><tr><th>事项</th><th>负责人</th><th>计划时间</th></tr></thead><tbody>${meeting.actions.map(a=>`<tr><td>${a.text}</td><td>${a.owner}</td><td>${a.due}</td></tr>`).join('')}</tbody></table>`:''}${scope.notes?'<h3>人工笔记</h3><p class="subtitle">先验证导入内容与引用一致，再确定正式接入范围。</p>':''}${scope.sources?'<div class="doc-source">引用原文（与画板保存在同一文档）<br>[1] 08:24 林知夏：「先把会后的整理与回顾做好。」<br>[2] 16:10 陈屿：「树状结构放到画板上，还能继续编辑。」</div>':''}</div></article><div class="preview-caption"><span>画板是云文档内的组件 · 非独立发布类型</span><span>原生树效果待租户实测</span></div></div>`;}

const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scope = {sources:true,actions:true,notes:false};
const screens = ['meeting','export','feishu','skills','select','chat','review','receipt'];
const labels = ['会议纪要','导出方式','飞书导出','技能管理','选择 Skill','流式聊天','检查与确认','导出回执'];
const params = new URLSearchParams(location.search);
let screen = params.get('screen') || ({doc:'feishu',board:'feishu',skill:'skills'}[params.get('variant')]) || 'meeting';
if (!screens.includes(screen)) screen = 'meeting';
const skills = [
  {id:'weekly',name:'团队周报',description:'把讨论整理为进展、共识与后续行动；通过聊天调整口吻和篇幅。',origin:'内置示例',installed:true,enabled:true,version:'1.0.0',target:'飞书云文档'},
  {id:'outline',name:'结构化纪要',description:'按主题重排纪要，保留引用，输出可以继续编辑的 Markdown。',origin:'内置示例',installed:true,enabled:true,version:'1.0.0',target:'Markdown 文件'},
  {id:'brief',name:'飞书项目简报',description:'面向项目协作整理简报，检查目标文档与内容范围后导出。',origin:'本地包示例',installed:false,enabled:false,version:'0.1.0',target:'飞书云文档'}
];
let selectedSkill = 'weekly', detailSkill = 'weekly', connected = true, includeBoard = params.get('variant') === 'board';
let messages = [], streaming = false, timer, candidate = null, confirmation = '', executionKey = '', execution = '', executionTimer, failNext = false;
let initialRequest = '整理为适合团队阅读的项目周报，保留关键决策与行动候选。';
let title = `${meeting.title} · 2026.10.30`, destination = '产品与设计 / 会议纪要', exportType = 'custom';
const baseBody = () => `# 产品体验周会 · 团队周报\n\n> 示例内容 · 纪要 v3 / 转录 v12\n\n## 本周共识\n- 聚焦会后整理与回顾，保留讨论来源。\n- 飞书导出以云文档为目标，纪要树作为文档内画板组件。\n- 自定义导出通过 Skill 和流式聊天整理，确认后再执行。\n${scope.actions?'\n## 后续行动\n'+meeting.actions.map(a=>`- ${a.text}（${a.owner} / ${a.due}）`).join('\n'):''}${scope.sources?'\n\n## 引用原文\n[1] 08:24 林知夏：先把会后的整理与回顾做好。\n[2] 16:10 陈屿：树状结构放到画板上，还能继续编辑。':''}${scope.notes?'\n\n## 人工笔记\n先核实内容映射，再确定接入范围。':''}`;
let draft = {revision:1,body:baseBody(),edited:false};
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
function heading(name,description,actions='') { return `<section class="page-heading"><div><p class="eyebrow">${screen==='skills'?'工作空间设置':'产品与设计 / 产品体验周会'}</p><h1>${name}</h1><p class="subtitle">${description}</p></div><div class="heading-actions">${actions}</div></section>`; }
const button = (text,action,primary=false,disabled=false) => `<button class="button ${primary?'primary':''}" data-action="${action}" ${disabled?'disabled':''}>${text}</button>`;
function meetingPage() {
  return heading(meeting.title,'2026 年 10 月 30 日 · 42 分钟 · 林知夏、陈屿、周宁',button(`${icon('upload')}导出`,'export',true))+`<div class="meeting-tabs"><b>智能纪要</b><span>转录</span><span>人工笔记</span><small>已保存 · 人工修订版</small></div><div class="meeting-layout">${documentPreview(true)}<aside class="context-panel"><p class="mini-label">本场会议</p><h3>从讨论到可执行的共识</h3><p>纪要 v3，引用转录 v12。<br>3 个主题 · 2 项行动候选</p><div class="rule"></div><h4>引用仍在身边</h4><p>整理与导出都保留版本。<br>原始录音不会随纪要发送。</p><div class="rule"></div><h4>当前状态</h4><p>会议已结束<br>人工修订已保存</p></aside></div>`;
}
function scopes() {
  return `<div class="scope-title">使用的会议内容</div><label class="check-row"><input checked disabled type="checkbox">已保存的纪要 <small>v3 · 人工修订</small></label>${[['actions','行动候选','不创建任务'],['sources','引用原文','仅引用片段'],['notes','人工笔记','默认不勾选']].map(([key,name,hint])=>`<label class="check-row"><input type="checkbox" data-scope="${key}" ${scope[key]?'checked':''}>${name}<small>${hint}</small></label>`).join('')}`;
}
function connection() { return `<div class="connection"><div class="provider-title">${feishu}<div><b>飞书 · 产品与设计团队</b><small>${connected?'已连接 · 演示':'需要连接 · 演示'}</small></div></div><button class="plain" data-action="connect">${connected?'模拟断开':'模拟连接'}</button></div>`; }
function feishuPage() {
  return heading('导出到飞书','创建一份云文档，画板作为正文内的可选组件。',button('返回导出方式','export'))+`<div class="publish-layout">${includeBoard?boardPreview():documentPreview()}<aside class="settings-panel"><h2>飞书云文档</h2>${connection()}<label class="field">目标文件夹<select id="destination"><option>产品与设计 / 会议纪要</option><option>我的空间 / 会议纪要</option></select></label><label class="field">文档标题<input id="title" value="${esc(title)}"></label><div class="scope-title">文档组件</div><label class="check-row"><input id="include-board" type="checkbox" ${includeBoard?'checked':''}>插入纪要画板<small>可编辑大纲树</small></label><p class="helper">正文、画板、表格和引用保存在同一文档中。</p>${scopes()}<div class="rule"></div>${button('下一步：检查导出内容','feishu-review',true,!connected)}<p class="helper">当前为演示，不创建真实文档。</p></aside></div>`;
}
function skillsPage() {
  const current=skills.find(s=>s.id===detailSkill);
  return heading('技能管理','在程序内安装、检查和管理 Skill。自定义导出只使用已安装且启用的技能。',button('导入技能包','install',true)+button('返回纪要','meeting'))+`<div class="management-layout"><section class="skill-library"><div class="library-heading"><h2>技能库 <small>${skills.filter(s=>s.installed).length} 已安装</small></h2><span class="tag">内置 Skill 能力 · 规划</span></div>${skills.map(s=>`<button class="skill-row ${current.id===s.id?'selected-skill':''}" data-detail="${s.id}">${icon('puzzle')}<div><h3>${s.name}<span class="tag">${s.installed?(s.enabled?'已启用':'已停用'):'未安装'}</span></h3><p>${s.description}</p><small>${s.origin} · v${s.version} · ${s.target}</small></div><span>›</span></button>`).join('')}<div class="library-note">Skill 是流程和知识，不是平台账号。平台授权与每次外部写入的确认由程序管理。</div></section><aside class="settings-panel skill-detail"><p class="mini-label">技能详情</p><h2>${current.name}</h2><p class="subtitle">${current.description}</p><dl><dt>来源</dt><dd>${current.origin}</dd><dt>版本</dt><dd>v${current.version}</dd><dt>兼容性</dt><dd>仅指引与资料 · 浏览器可用</dd></dl><h4>使用的能力</h4><p class="helper">读取所选纪要与引用<br>通过聊天生成导出草稿<br>${current.target==='Markdown 文件'?'经确认后下载本地文件':'经确认后创建飞书云文档'}</p><div class="manifest">SKILL.md<br>references/publishing-guide.md</div><div class="notice">安装不会运行脚本，也不会自动授予外部写入权限。</div>${current.installed?button(current.enabled?'停用技能':'启用技能','toggle-skill')+button('用于自定义导出','use-skill',true,!current.enabled):button('预览并安装','install',true)}<div class="rule"></div><h4>平台连接</h4>${connection()}<p class="helper">需要脚本、命令或本地 stdio 的技能包，应显示兼容性要求，不能静默执行。</p></aside></div>`;
}
function selectPage() {
  return heading('自定义导出','先选择 Skill，再通过聊天把这场纪要整理成你需要的内容。',button('返回导出方式','export'))+`<div class="selection-layout"><section class="skill-library"><div class="library-heading"><h2>选择一个已安装的 Skill</h2><button class="plain" data-go="skills">管理技能 →</button></div>${readySkills().length?readySkills().map(s=>`<button class="skill-choice ${selectedSkill===s.id?'chosen':''}" data-select="${s.id}"><span class="radio-dot"></span><div><h3>${s.name}</h3><p>${s.description}</p><small>${s.origin} · 输出到${s.target}</small></div>${icon('arrow')}</button>`).join(''):'<div class="empty"><h3>还没有可用的 Skill</h3><p>先安装或启用一个技能，才能开始自定义导出。</p>'+button('前往技能管理','skills',true)+'</div>'}<div class="library-note">内置示例可直接使用。你也可以先到技能管理中安装自己的技能包。</div></section><aside class="settings-panel"><h2>这次要整理什么</h2>${scopes()}<label class="field">告诉 Skill 你的要求<textarea id="initial-request" rows="4">${esc(initialRequest)}</textarea></label><div class="source-strip">产品体验周会<br><small>纪要 v3 / 转录 v12 · 只读快照</small></div>${button('开始流式聊天 '+icon('arrow'),'start-chat',true,!readySkills().some(s=>s.id===selectedSkill))}<p class="helper">此处只开始整理，导出前还会检查内容和目标位置。</p></aside></div>`;
}
function draftPreview() {
  return `<section class="artifact"><div class="artifact-header"><div><p class="mini-label">导出草稿</p><h3>${skill().name} <span class="tag">${draft.revision?'v'+draft.revision:'待生成'}${draft.edited?' · 人工编辑':''}</span></h3></div><button class="plain" data-action="edit-draft" ${streaming?'disabled':''}>编辑</button></div><div class="artifact-body">${!draft.revision?'<div class="draft-empty"><h3>等待第一版导出草稿</h3><p>Skill 正在根据所选纪要整理。完成后，可在这里检查和编辑内容。</p><small>来源仍为纪要 v3 / 转录 v12，原稿不会改变。</small></div>':draft.body.split('\n').map(line=>line.startsWith('# ')?`<h2>${esc(line.slice(2))}</h2>`:line.startsWith('## ')?`<h4>${esc(line.slice(3))}</h4>`:line.startsWith('- ')?`<p class="draft-item">${esc(line.slice(2))}</p>`:line?`<p>${esc(line)}</p>`:'').join('')}</div><div class="artifact-footer">基于纪要 v3 / 转录 v12 · ${streaming?'正在整理下一版，当前草稿保持可见':'草稿与来源绑定，确认后才会导出'}</div></section>`;
}
function conversation() {
  if(!messages.length) messages=[{role:'user',text:'整理为适合团队阅读的项目周报，保留关键决策与行动候选。'},{role:'assistant',text:'已整理好第一版周报。关键共识、两项后续行动和引用原文都在草稿区。你可以继续调整篇幅和口吻，或检查导出内容。'}];
  return messages.map(m=>`<div class="message ${m.role}"><div class="speaker">${m.role==='user'?'林知夏':`${icon('puzzle')}${skill().name}`}${m.role==='assistant'?'<small>Skill · 模拟回复</small>':''}</div><div class="message-body">${esc(m.text).replace(/\n/g,'<br>')}${m===messages.at(-1)&&streaming?'<span class="stream-caret">▍</span>':''}</div>${m.stopped?'<small class="muted">已停止生成 · 草稿没有被覆盖</small>':''}</div>`).join('');
}
function chatPage() {
  return heading('自定义导出','通过聊天逐步整理，在草稿区检查这一次真正要导出的内容。',button('更换 Skill','select')+button('检查并导出','custom-review',true,streaming||!!candidate||!draft.revision))+`<div class="chat-context"><span>${icon('puzzle')}${skill().name} · v${skill().version}</span><span>来源：纪要 v3 / 转录 v12</span><span>${skill().target}${skill().target==='飞书云文档'?(connected?' · 已连接（演示）':' · 需要连接'):''}</span></div><div class="chat-layout"><section class="chat-pane"><div class="thread" id="thread" role="log" aria-label="自定义导出对话" aria-live="polite">${conversation()}</div><div id="candidate-banner">${candidateMarkup()}</div><div class="chat-suggestions"><button data-prompt="请压缩成给管理层看的三点简报。">压缩成三点简报</button><button data-prompt="请保留原文引用，突出后续行动。">突出后续行动</button><button class="plain" data-action="regenerate">重新演示生成</button></div><form id="chat-form"><label for="chat-input" class="sr-only">向 Skill 提出调整要求</label><textarea id="chat-input" rows="2" placeholder="例如：语气简洁一些，保留决策与引用…" ${streaming?'disabled':''}></textarea><div class="composer-footer"><small>${streaming?'正在流式生成 · 本地模拟，可随时停止':'草稿不会自动外发；可继续对话或直接编辑。'}</small>${streaming?'<button type="button" class="button" data-action="stop-stream">停止生成</button>':'<button type="submit" class="button primary">发送 '+icon('arrow')+'</button>'}</div></form></section><div id="artifact-region">${draftPreview()}</div></div>`;
}
function candidateMarkup() {return candidate?`<div class="notice candidate"><b>新的整理建议已就绪</b><p>人工草稿保持原样，只有采用后才会替换。</p><details><summary>查看建议内容</summary><pre>${esc(candidate.body)}</pre></details>${button('保留人工稿','keep-draft')}${button('采用新建议','apply-candidate',true)}</div>`:'';}
const snapshotKey=()=>JSON.stringify([draft.revision,draft.body,selectedSkill,scope,title,destination,includeBoard,exportType,connected]);
function reviewPage() {
  return heading('检查并确认导出','检查最终内容、接收位置与可见范围。修改内容后，需要重新确认。',button(exportType==='custom'?'返回聊天':'返回配置',exportType==='custom'?'chat':'feishu'))+`<div class="review-layout"><div>${exportType==='feishu'?(includeBoard?boardPreview():documentPreview()):draftPreview()}</div><aside class="settings-panel"><h2>本次导出</h2><dl><dt>方式</dt><dd>${exportType==='custom'?'自定义导出 / '+skill().name:'飞书导出'}</dd><dt>目标</dt><dd>${exportType==='custom'?skill().target:'飞书云文档'}</dd><dt>文档组件</dt><dd>${targetIsFeishu()&&includeBoard?'正文与内嵌纪要画板':'纪要正文'}</dd><dt>内容版本</dt><dd>草稿 v${draft.revision} / 纪要 v3</dd><dt>转录来源</dt><dd>v12 · ${scope.sources?'附引用原文':'不含引用原文'}</dd></dl>${targetIsFeishu()?`${connection()}<label class="field">目标文件夹<select id="destination"><option>产品与设计 / 会议纪要</option><option>我的空间 / 会议纪要</option></select></label><label class="field">文档标题<input id="title" value="${esc(title)}"></label><div class="notice">按目标文件夹权限创建。最终可见范围仍需真实飞书核验。</div>`:'<div class="notice">下载到本机，不连接外部平台。</div>'}<p class="helper">不发送原始录音、完整转录或群消息；不创建任务。</p><label class="consent"><input id="export-consent" type="checkbox">已核对内容、目标与本次写入范围</label>${button('模拟确认导出','execute',true,true)}<details class="demo-controls"><summary>原型异常状态</summary><label class="check-row"><input id="simulate-failure" type="checkbox" ${failNext?'checked':''}>模拟执行失败</label></details></aside></div>`;
}
function targetIsFeishu(){return exportType==='feishu'||skill().target==='飞书云文档';}
function receiptPage() {
  const failed=execution==='failed',busy=execution==='running';
  return heading(busy?'正在导出':failed?'导出演示未完成':'导出演示已完成',busy?'保留当前草稿和计划，按阶段展示进度。':failed?'本次执行在写入前模拟失败，没有创建任何外部资源。':'这是本地模拟回执，未创建真实飞书文档。',button('返回纪要','meeting'))+`<section class="receipt-panel"><div class="receipt-symbol">${busy?'…':failed?'!':'✓'}</div><h2>${busy?'正在准备导出':failed?'模拟连接中断':'内容已整理，流程已走通'}</h2><p>${targetIsFeishu()?'飞书云文档':'Markdown 文件'} · ${targetIsFeishu()&&includeBoard?'包含纪要画板组件':'纪要正文'}</p><div class="execution-steps"><div>✓ 冻结草稿 v${draft.revision}</div><div>${busy?'…':failed?'!':'✓'} 检查目标与写入范围</div><div>${busy||failed?'○':'✓'} ${targetIsFeishu()?'模拟写入并核对结果':'准备示例 Markdown'}</div><div>${busy||failed?'○':'✓'} 生成回执</div></div><dl><dt>计划编号</dt><dd>demo-export-1030</dd><dt>来源</dt><dd>纪要 v3 / 转录 v12</dd><dt>草稿</dt><dd>v${draft.revision}${draft.edited?' · 人工编辑':''}</dd><dt>目标</dt><dd>${targetIsFeishu()?esc(destination):'本机下载'}</dd></dl><div class="receipt-actions">${busy?'':failed?button('返回检查','review')+button('模拟重试同一计划','retry',true):button('下载示例 Markdown','download-draft',true)+button('返回聊天继续调整','chat')}</div><p class="helper">真实实现需保存资源 ID、内容摘要与阶段回执。未知写入结果应先核对远端，不能盲目重建。</p></section>`;
}
function render() {
  const views={meeting:meetingPage,export:meetingPage,feishu:feishuPage,skills:skillsPage,select:selectPage,chat:chatPage,review:reviewPage,receipt:receiptPage};
  app.innerHTML=views[screen]();
  document.querySelector('#breadcrumb').textContent=screen==='skills'?'工作空间设置 / 技能管理':'产品与设计 / 产品体验周会';
  document.querySelector('#screen-label').textContent=`${String(screens.indexOf(screen)+1).padStart(2,'0')} / 08 · ${labels[screens.indexOf(screen)]}`;
  document.querySelectorAll('[data-go]').forEach(el=>el.onclick=()=>go(el.dataset.go));
  document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
  document.querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>action(el.dataset.action));
  document.querySelectorAll('[data-detail]').forEach(el=>el.onclick=()=>{detailSkill=el.dataset.detail;render();});
  document.querySelectorAll('[data-select]').forEach(el=>el.onclick=()=>{selectedSkill=el.dataset.select;render();});
  document.querySelectorAll('[data-scope]').forEach(el=>el.onchange=()=>{scope[el.dataset.scope]=el.checked;confirmation='';render();});
  document.querySelector('#include-board')?.addEventListener('change',e=>{includeBoard=e.target.checked;render();});
  document.querySelector('#destination')?.addEventListener('change',e=>{destination=e.target.value;invalidateConfirmation();});
  if(document.querySelector('#destination'))document.querySelector('#destination').value=destination;
  document.querySelector('#initial-request')?.addEventListener('input',e=>initialRequest=e.target.value);
  document.querySelector('#title')?.addEventListener('input',e=>{title=e.target.value;invalidateConfirmation();});
  document.querySelector('#export-consent')?.addEventListener('change',e=>{confirmation=e.target.checked?snapshotKey():'';document.querySelector('[data-action=execute]').disabled=!confirmation||(targetIsFeishu()&&!connected);});
  document.querySelector('#simulate-failure')?.addEventListener('change',e=>failNext=e.target.checked);
  document.querySelectorAll('[data-prompt]').forEach(el=>el.onclick=()=>startStream(el.dataset.prompt));
  document.querySelector('#chat-form')?.addEventListener('submit',e=>{e.preventDefault();const text=document.querySelector('#chat-input').value.trim();if(text)startStream(text);});
  if(screen==='export')document.querySelector('#export-dialog').showModal();
}
function invalidateConfirmation(){confirmation='';const input=document.querySelector('#export-consent');if(input)input.checked=false;const execute=document.querySelector('[data-action=execute]');if(execute)execute.disabled=true;}
function suggestedBody(prompt) {
  let body=baseBody();
  if(/三点|管理层|简报/.test(prompt))body=body.replace('团队周报','管理层简报').replace('## 本周共识','## 三点重点');
  if(/突出.*行动|重点.*行动/.test(prompt))body=body.replace('## 后续行动','## 重点跟进');
  return body;
}
function startStream(prompt) {
  if(streaming)return;
  messages.push({role:'user',text:prompt},{role:'assistant',text:''}); streaming=true; confirmation=''; screen='chat';history.replaceState(null,'','?screen=chat');render();
  const response=Array.from(`我会按你的要求调整：「${prompt}」\n\n先核对纪要 v3 与转录 v12，再整理关键共识和两项后续行动。引用原文按本次选择保留，原始录音不导出。\n\n${draft.edited?'当前有人工编辑，我会先提供整理建议，等待你决定是否采用。':'新草稿完成后会显示在草稿区；你可以继续对话，也可以检查导出内容。'}\n\n本回复为固定逻辑的本地流式演示，没有调用真实模型。`);
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
  if(targetIsFeishu()&&!connected){toast('请先连接飞书。');return;}
  if(!retry)executionKey=snapshotKey();
  execution='running';go('receipt');clearTimeout(executionTimer);
  executionTimer=setTimeout(()=>{execution=failNext?'failed':'done';failNext=false;if(screen==='receipt')render();},1500);
}
function download(body,name) {const blob=new Blob([body],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('示例 Markdown 已开始下载。');}
function action(name) {
  if(screens.includes(name)){go(name);return;}
  if(name==='connect'){connected=!connected;invalidateConfirmation();render();toast(connected?'已模拟连接飞书，没有执行真实授权。':'已模拟断开飞书。');}
  if(name==='install')document.querySelector('#install-dialog').showModal();
  if(name==='toggle-skill'){const s=skills.find(s=>s.id===detailSkill);s.enabled=!s.enabled;render();}
  if(name==='use-skill'){selectedSkill=detailSkill;go('select');}
  if(name==='start-chat'){const request=document.querySelector('#initial-request').value.trim();if(!readySkills().some(s=>s.id===selectedSkill))return;exportType='custom';draft={revision:0,body:'',edited:false};messages=[];candidate=null;go('chat');messages=[];startStream(request||'整理本场纪要，保留决策与引用。');}
  if(name==='regenerate')startStream('重新整理本场纪要，保留来源与行动候选。');
  if(name==='stop-stream'){stopStream();render();}
  if(name==='edit-draft'){document.querySelector('#draft-editor').value=draft.body;document.querySelector('#editor-dialog').showModal();}
  if(name==='apply-candidate'){draft=candidate;candidate=null;confirmation='';render();}
  if(name==='keep-draft'){candidate=null;render();}
  if(name==='custom-review'){if(!draft.revision){toast('请先生成导出草稿。');return;}exportType='custom';go('review');}
  if(name==='feishu-review'){exportType='feishu';draft={revision:1,body:baseBody(),edited:false};go('review');}
  if(name==='execute')execute();
  if(name==='retry')execute(true);
  if(name==='download-draft')download(draft.body,'产品体验周会-导出示例.md');
}
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('cancel',()=>{if(dialog.id==='export-dialog')go('meeting');});
for(const el of document.querySelectorAll('[data-close]'))el.onclick=()=>{document.querySelector('#'+el.dataset.close).close();if(el.dataset.close==='export-dialog')go('meeting');};
document.querySelector('#markdown-export').onclick=()=>{download(baseBody(),'产品体验周会-纪要示例.md');document.querySelector('#export-dialog').close();go('meeting');};
document.querySelector('#feishu-export').onclick=()=>{exportType='feishu';go('feishu');};
document.querySelector('#custom-export').onclick=()=>{exportType='custom';includeBoard=false;go('select');};
document.querySelector('#install-consent').onchange=e=>document.querySelector('#install-confirm').disabled=!e.target.checked;
document.querySelector('#install-confirm').onclick=()=>{const s=skills.find(s=>s.id==='brief');s.installed=true;s.enabled=true;detailSkill=s.id;document.querySelector('#install-dialog').close();go('skills');toast('示例技能已安装到本页内存，刷新后清除。');};
document.querySelector('#save-editor').onclick=()=>{draft={revision:draft.revision+1,body:document.querySelector('#draft-editor').value,edited:true};confirmation='';document.querySelector('#editor-dialog').close();render();};
function cycle(delta){const index=screens.indexOf(screen);go(screens[(index+delta+screens.length)%screens.length]);}
document.querySelector('#previous').onclick=()=>cycle(-1);document.querySelector('#next').onclick=()=>cycle(1);
document.addEventListener('keydown',e=>{if(e.target.closest('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open]'))return;if(e.key==='ArrowLeft')cycle(-1);if(e.key==='ArrowRight')cycle(1);});
console.assert(skills.filter(s=>s.installed).length===2,'Two built-in example skills');
console.assert(baseBody().includes('纪要树作为文档内画板组件'),'Whiteboard belongs to cloud document');
console.assert(suggestedBody('压缩为三点管理层简报').includes('## 三点重点'),'Demo prompt changes draft structure');
console.assert(!suggestedBody('私密整理要求示例').includes('私密整理要求示例'),'Instructions stay out of exported content');
render();
