import { networkAgent } from '../network-proxy.mjs';
import {DomainError,requireThat} from '../../../../packages/records/src/record.mjs';

const quiet={error(){},warn(){},info(){},debug(){},trace(){}};
export async function createFeishuSdk({appId,appSecret,signal},{loadSdk=()=>import('@larksuiteoapi/node-sdk')}={}){
  const sdk=await loadSdk();signal.throwIfAborted();
  // SDK request formatting spreads data into an object, so pass FormData through to its authenticated transport.
  const httpInstance={request:({multipart,...config})=>sdk.defaultHttpInstance.request({...config,...(multipart?{data:multipart,headers:{...config.headers,'Content-Type':'multipart/form-data'}}:{}),proxy:false,maxRedirects:0,maxContentLength:10*1024*1024,maxBodyLength:10*1024*1024,timeout:Math.min(config.timeout||20000,20000),signal:AbortSignal.any([signal,...(config.signal?[config.signal]:[])])})};
  httpInstance.post=(url,data)=>httpInstance.request({method:'POST',url,data});
  const common={appId,appSecret,agent:networkAgent(),domain:sdk.Domain.Feishu,logger:quiet,httpInstance};
  const client=new sdk.Client({...common,appType:sdk.AppType.SelfBuild,cache:new sdk.DefaultCache()});
  const ws=new sdk.WSClient({...common,autoReconnect:true,handshakeTimeoutMs:15000,wsConfig:{pingTimeout:15}});
  const dispatcher=new sdk.EventDispatcher({logger:quiet}).register({});
  const close=()=>ws.close({force:true});signal.addEventListener('abort',close,{once:true});
  return {
    async start(){try{signal.throwIfAborted();await ws.start({eventDispatcher:dispatcher});signal.throwIfAborted();requireThat(ws.getConnectionStatus().state!=='failed','feishu_connection_failed',502);}catch{close();throw new DomainError('feishu_connection_failed',502);}},
    status:()=>ws.getConnectionStatus(),
    request:(url,{body,method=body?'POST':'GET',signal:requestSignal}={})=>client.request({url,method,...(body instanceof FormData?{multipart:body}:body?{data:body}:{}),...(requestSignal?{signal:requestSignal}:{})}),
    close(){signal.removeEventListener('abort',close);close();}
  };
}
