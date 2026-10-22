// THROWAWAY PROTOTYPE: playback controls inside the existing C meeting header; ?variant=A|B|C.
// Simulated transport only; production player is unchanged pending user selection.
// Synthetic display data only. No recording, API, persistence, or real meeting access.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Icons from '@phosphor-icons/react';

const directory = new URL('./', import.meta.url);
const icon = (name, size = 18, weight = 'regular') => renderToStaticMarkup(createElement(Icons[name], { size, weight, 'aria-hidden': true }));
const button = (name, label, extra = '') => `<button class="icon-button ${extra}" type="button" title="${label}" aria-label="${label}">${icon(name)}</button>`;
const skip = (direction) => `<button class="skip-control" type="button" data-skip="${direction * 15}" aria-label="${direction < 0 ? '后退' : '前进'} 15 秒" data-tip="${direction < 0 ? '后退' : '前进'} 15 秒">${icon(direction < 0 ? 'ArrowCounterClockwise' : 'ArrowClockwise',29)}<span>15</span></button>`;
const play = () => `<button class="play-control" type="button" aria-label="播放或暂停录音">${icon('Play',20,'fill')}<span class="pause-icon">${icon('Pause',20,'fill')}</span></button>`;
const transport = () => `<div class="transport-controls">${skip(-1)}${play()}${skip(1)}</div>`;
const rate = () => `<label class="speed-select"><span class="sr-only">播放速度</span><select aria-label="播放速度"><option value=".75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>${icon('CaretDown',11)}</label>`;
const time = () => `<div class="time-display"><b class="current-time">08:36</b><span>/</span><span>47:18</span></div>`;
const scrub = () => `<div class="scrub"><input type="range" min="0" max="2838" value="516" step="1" aria-label="录音进度"><span class="scrub-rail"></span></div>`;
const actions = (showPlay) => `<div class="meeting-actions" aria-label="会议操作">${showPlay ? `<button class="icon-button playback player-entry" type="button" aria-label="展开播放控制" title="播放控制">${icon('SpeakerHigh',19)}</button><span class="divider"></span>` : ''}${button('DownloadSimple','导出')}${button('ShareNetwork','分享')}${button('Translate','翻译')}${button('Archive','归档')}${button('GearSix','整理设置')}</div>`;
const meta = () => `<div class="meeting-meta"><span class="archived-pill">已结束</span><span>2026年10月22日</span><span class="meta-separator">·</span><span>47 分钟</span><span class="meta-separator">·</span><span>产品工作间</span></div>`;
const title = () => `<div class="title"><h1>产品体验与回听评审<button aria-label="编辑会议名称">${icon('PencilSimple',17)}</button></h1></div>`;
const summary = () => `<section class="recorder archived-recorder"><div class="capture-status"><span class="saved-icon">${icon('CheckCircle',23)}</span><div class="status-copy"><strong>本场会议已收好</strong><span>对话与每一个共识，都已留在这里</span></div></div><button class="new-record">${icon('Plus',16)}开启新会议</button></section>`;
const inline = () => `<section class="inline-playback playback-surface" aria-label="录音播放器"><span class="playback-label">${icon('Waveform',18)}会议录音</span>${transport()}${scrub()}${time()}${rate()}</section>`;
const popup = () => `<section class="popover-player playback-surface" aria-label="录音播放器"><div class="popover-top"><span>${icon('Waveform',18)}会议录音</span><span class="track-label">双音轨同步</span>${button('X','收起播放控制','close-player')}</div><div class="popup-timeline">${scrub()}<div class="popup-times"><span class="current-time">08:36</span><span>47:18</span></div></div><div class="popup-bottom">${rate()}${transport()}<span class="sync-tracks">${icon('Headphones',15)}${icon('Microphone',15)}</span></div></section>`;
const waveform = () => {
 const heights=Array.from({length:118},(_,i)=>7+Math.round(24*Math.abs(Math.sin(i*1.79)*Math.cos(i*.43))));
 return `<section class="waveform-player playback-surface" aria-label="录音播放器"><div class="wave-toolbar"><span class="playback-label">${icon('Waveform',18)}会议录音<span class="track-label">双音轨同步</span></span><label class="jump-input">${icon('Timer',15)}<input type="text" value="08:36" aria-label="跳转时间"><button aria-label="跳到此时间">${icon('ArrowRight',14)}</button></label></div><div class="wave-track"><div class="wave-bars">${heights.map(h=>`<i style="height:${h}px"></i>`).join('')}</div><span class="wave-cursor"><b class="current-time">08:36</b></span><input type="range" min="0" max="2838" value="516" step="1" aria-label="录音进度"></div><div class="wave-markers"><span>00:00</span><span>12:00</span><span>24:00</span><span>36:00</span><span>47:18</span></div><div class="wave-bottom">${time()}${transport()}${rate()}</div></section>`;
};
const heading = showPlay => `<div class="c-heading"><div>${title()}${meta()}</div>${actions(showPlay)}</div>`;
const variants={
 A:`<header class="unified-header">${heading(false)}${inline()}${summary()}</header>`,
 B:`<header class="unified-header">${heading(true)}${summary()}${popup()}</header>`,
 C:`<header class="unified-header">${heading(false)}${waveform()}${summary()}</header>`
};
const minutes=()=>`<section class="minutes-panel panel"><header class="section-heading"><div><span class="section-icon">${icon('Sparkle',20)}</span><h2>智能会议纪要</h2></div><span class="updated">已整理</span></header><div class="minutes-body"><div class="topic-heading"><span class="topic-number">01</span><div><h3>产品体验与用户反馈</h3><span class="time-range">04:20 – 12:36</span></div></div><p>讨论了本轮产品试用的反馈，明确优先改善会议回听与重点信息定位体验。</p><div class="decision"><span class="decision-label">已达成共识</span><p>下一轮评审以真实使用场景为依据，先确认体验，再评估结果。</p><button class="citation">${icon('Quotes',12)}查看 08:36 原话</button></div><div class="topic-heading second"><span class="topic-number">02</span><div><h3>后续安排与行动项</h3><span class="time-range">12:37 – 47:18</span></div></div><p>整理试用反馈和典型会议片段，在下次例会上集中回看与确认。</p></div><footer class="minutes-footer">${icon('LinkSimple',14)}每条结论都能回到原话。</footer></section>`;
const transcript=()=>`<section class="transcript-panel panel"><header class="section-heading"><div>${icon('Waveform',20)}<h2>会议转录</h2></div><span class="updated">双音轨</span></header><div class="transcript-body">${[['林','林晓','08:21','我们先把这次试用的反馈整理一下，挑出最影响体验的几个问题。'],['陈','陈一','08:36','回听时可以快速跳过已经确认的内容，把精力放在关键讨论上。'],['林','林晓','09:02','纪要里标出讨论对应的位置，下一次就能直接回到这段对话。']].map(([avatar,name,t,text])=>`<article class="segment ${t==='08:36'?'current-segment':''}"><div class="segment-heading"><span class="avatar">${avatar}</span><b>${name}</b><time>${t}</time></div><p>${text}</p></article>`).join('')}</div></section>`;
const sidebar = () => `<aside class="sidebar"><div class="brand"><span>${icon('Waveform', 25, 'bold')}</span><strong>聆记</strong><small>Meeting Studio</small></div><button class="new-meeting">${icon('Plus', 16)}快速记录</button><div class="rail-label">工作目录${icon('FolderPlus', 14)}</div><div class="directory">所有会议${icon('CaretDown', 14)}</div><div class="overview">${icon('House', 16)}目录概览</div><div class="rail-label history-label">我的记录<span>3</span></div><div class="meeting-list">${[['产品体验与发布评审','今天 12:30 · 正在记录'],['设计团队同步','今天 10:00 · 28 分钟'],['上周的项目复盘','10月16日 · 46 分钟']].map(([name, date], index) => `<div class="meeting-item ${index === 0 ? 'selected' : ''}">${icon('Microphone', 15)}<div><b>${name}</b><small>${date}</small></div>${index === 0 ? '<span class="list-dot"></span>' : ''}</div>`).join('')}</div><footer class="rail-footer"><span class="avatar">聆</span><div><b>本机空间</b><small>个人会议空间</small></div>${button('GearSix', '设置与诊断')}</footer></aside>`;
const toast = () => '';
const template = await readFile(new URL('template.html', directory), 'utf8');
const html = template.replace('<!--SIDEBAR-->', sidebar()).replace('<!--VARIANTS-->', Object.entries(variants).map(([key, header]) => `<section class="variant variant-${key}" data-variant="${key}">${header}<div class="content-grid">${minutes()}${transcript()}</div></section>`).join('')).replace('<!--TOAST-->', toast()).replace('<!--TOPICONS-->', `${icon('CaretRight', 12)}<span>会议详情</span>`).replace('<!--SEARCH-->', icon('MagnifyingGlass', 16)).replace('<!--SYNC-->', icon('CloudCheck', 17)).replace('<!--ARROWS-->', `${button('CaretLeft', '上一版')}<span id="variant-label"></span>${button('CaretRight', '下一版')}`);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname.endsWith('.html')) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
  if (url.pathname === '/playback-demo.js') { response.setHeader('Content-Type','text/javascript'); response.end(await readFile(new URL('playback-demo.js', directory))); return; }
  if (url.pathname === '/preview.css') { response.setHeader('Content-Type', 'text/css'); response.end(await readFile(new URL('preview.css', directory))); return; }
  response.writeHead(404); response.end();
});
server.listen(Number(process.env.PREVIEW_PORT || 4184), '127.0.0.1', () => console.log(`Read-only synthetic preview: http://127.0.0.1:${server.address().port}/?variant=A`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
