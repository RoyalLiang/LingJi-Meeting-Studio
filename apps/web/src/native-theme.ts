export function initializeTheme(defaultTheme: 'dark' | 'light' = 'light'){
  const apply=(value:string|null)=>{
    document.documentElement.dataset.theme=value==='dark'||value==='light'?value:defaultTheme;
    document.dispatchEvent(new Event('meeting:theme'));
  };
  try{apply(localStorage.getItem('meeting-theme'));}catch{apply(null);}
  window.addEventListener('storage',event=>{
    if(event.key==='meeting-theme'||event.key===null)apply(event.newValue);
  });
}

export function nativeThemeSync(send:(theme:string)=>Promise<unknown>){
 let desired:string|undefined,applied:string|undefined,stopped=false,chain=Promise.resolve();
 return {
  set(theme:string|undefined){
   if(stopped||!['light','dark'].includes(theme||''))return chain;
   desired=theme;
   chain=chain.catch(()=>{}).then(async()=>{if(stopped||applied===desired)return;const next=desired!;await send(next);applied=next;});
   return chain;
  },
  stop(){stopped=true;}
 };
}
