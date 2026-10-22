document.addEventListener('DOMContentLoaded',()=>{
 document.querySelectorAll('.variant').forEach(root=>{
  let time=516,playing=false,rate=1;const surface=root.querySelector('.playback-surface');
  const format=t=>`${Math.floor(t/60).toString().padStart(2,'0')}:${Math.floor(t%60).toString().padStart(2,'0')}`;
  const update=()=>{time=Math.max(0,Math.min(2838,time));root.querySelectorAll('.current-time').forEach(n=>n.textContent=format(time));root.querySelectorAll('[type=range]').forEach(n=>n.value=time);surface.style.setProperty('--progress',`${time/2838*100}%`);const jump=root.querySelector('.jump-input input');if(jump)jump.value=format(time);root.dataset.time=time;root.dataset.rate=rate;};
  root.querySelectorAll('[data-skip]').forEach(b=>b.onclick=()=>{time+=Number(b.dataset.skip);update();});
  root.querySelectorAll('[type=range]').forEach(n=>n.oninput=()=>{time=Number(n.value);update();});
  root.querySelector('select').onchange=e=>{rate=Number(e.target.value);update();};
  root.querySelector('.play-control').onclick=e=>{playing=!playing;root.querySelector('.play-control').classList.toggle('is-playing',playing);};
  root.querySelector('.player-entry')?.addEventListener('click',()=>surface.classList.toggle('hidden-player'));
  root.querySelector('.close-player')?.addEventListener('click',()=>surface.classList.add('hidden-player'));
  root.querySelector('.jump-input button')?.addEventListener('click',()=>{const parts=root.querySelector('.jump-input input').value.split(':').map(Number);if(parts.length===2&&parts.every(Number.isFinite)){time=parts[0]*60+parts[1];update();}});
  setInterval(()=>{if(playing){time+=rate;update();}},1000);update();
 });
 const entry=document.querySelector('.variant-B .player-entry'), panel=document.querySelector('.variant-B .popover-player');
 const position=()=>{if(!entry||!panel||document.body.dataset.variant!=='B')return;const h=entry.closest('.unified-header').getBoundingClientRect(),a=entry.getBoundingClientRect(),center=a.left+a.width/2-h.left,left=Math.max(16,Math.min(h.width-panel.offsetWidth-16,center-panel.offsetWidth/2));panel.style.left=left+'px';panel.style.right='auto';panel.style.setProperty('--tip',(center-left-5)+'px');};
 requestAnimationFrame(position);addEventListener('resize',position);
 const note=document.createElement('span');note.className='prototype-note';note.textContent='版式预览 · 示例会议';document.body.append(note);
});