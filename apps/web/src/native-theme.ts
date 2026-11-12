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
