const status=document.getElementById('share-status'), token=location.pathname.split('/').at(-1);
let checking=false, timer;
function expire(){clearTimeout(timer);if(status){status.textContent='此链接已到期或已撤销，请向发布者索取新的链接。';document.querySelector('main')?.replaceChildren(status);}document.title='链接已失效 · 聆记';}
async function check(){
  if(checking || document.hidden || !status)return;
  if(Date.now()>=Number(status.dataset.expires)){expire();return;}
  checking=true;
  try{const response=await fetch(`/api/shared/${token}/status`,{cache:'no-store',signal:AbortSignal.timeout(10000)});if(response.status===404 || response.status===410){expire();return;}if(!response.ok)throw new Error();status.textContent='只读快照 · 有效至 '+new Date(Number(status.dataset.expires)).toLocaleString('zh-CN')+'。已保存的副本无法收回。';}
  catch{status.textContent='暂无法确认链接状态，当前显示已载入的快照。';}
  finally{checking=false;}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check();});
if(status){timer=setTimeout(expire,Math.max(0,Number(status.dataset.expires)-Date.now()));setInterval(()=>void check(),60000);void check();}
