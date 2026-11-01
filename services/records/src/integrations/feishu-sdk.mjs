import {DomainError,requireThat} from '../../../../packages/records/src/record.mjs';

const quiet={error(){},warn(){},info(){},debug(){},trace(){}};
export async function createFeishuSdk({appId,appSecret,signal},{loadSdk=()=>import('@larksuiteoapi/node-sdk')}={}){
  const sdk=await loadSdk();signal.throwIfAborted();
  const httpInstance={request:config=>sdk.defaultHttpInstance.request({...config,maxRedirects:0,maxContentLength:10*1024*1024,maxBodyLength:10*1024*1024,timeout:Math.min(config.timeout||20000,20000),signal:AbortSignal.any([signal,...(config.signal?[config.signal]:[])])})};
  httpInstance.post=(url,data)=>httpInstance.request({method:'POST',url,data});
  const common={appId,appSecret,domain:sdk.Domain.Feishu,logger:quiet,httpInstance};
  const client=new sdk.Client({...common,appType:sdk.AppType.SelfBuild,cache:new sdk.DefaultCache()});
  const ws=new sdk.WSClient({...common,autoReconnect:true,handshakeTimeoutMs:15000,wsConfig:{pingTimeout:15}});
  const dispatcher=new sdk.EventDispatcher({logger:quiet}).register({});
  const close=()=>ws.close({force:true});signal.addEventListener('abort',close,{once:true});
  return {
    async start(){try{signal.throwIfAborted();await ws.start({eventDispatcher:dispatcher});signal.throwIfAborted();requireThat(ws.getConnectionStatus().state!=='failed','feishu_connection_failed',502);}catch{close();throw new DomainError('feishu_connection_failed',502);}},
    status:()=>ws.getConnectionStatus(),
    request:(url,{body,signal:requestSignal}={})=>client.request({url,method:body?'POST':'GET',...(body?{data:body}:{}),...(requestSignal?{signal:requestSignal}:{})}),
    close(){signal.removeEventListener('abort',close);close();}
  };
}
