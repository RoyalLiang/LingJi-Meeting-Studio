import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { DomainError, requireThat } from '../../../../packages/records/src/record.mjs';

export function publicAddress(value) {
  if(isIP(value)===4){const [a,b,c]=value.split('.').map(Number);return a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===88&&c===99))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);}
  if(isIP(value)===6){const [a,b]=value.toLowerCase().split(':');return /^[23][0-9a-f]{3}$/.test(a)&&a!=='2002'&&!(a==='2001'&&(parseInt(b||'0',16)<0x200||parseInt(b||'0',16)===0xdb8));}
  return false;
}
export const proxyAddress=value=>isIP(value)===4&&/^198\.(?:18|19)\./.test(value);
export function privateNetworkAddress(value) {
  if(isIP(value)!==4)return false;
  const [a,b]=value.split('.').map(Number);
  return a===10||a===172&&b>=16&&b<=31||a===192&&b===168;
}
export function remoteUrl(value) {
  let url;try{url=new URL(value);}catch{throw new DomainError('invalid_remote_url',400);}
  requireThat(typeof value==='string'&&value.length<=2048&&url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(!url.port||url.port==='443')&&!isIP(url.hostname)&&!url.hostname.endsWith('.local')&&url.hostname.includes('.'),'invalid_remote_url',400);
  return url;
}

// Pin the checked DNS address to the TLS request; redirects and DNS rebinding cannot reach local services.
export async function remoteRequest(value,{method='GET',headers={},body,signal,maxBytes=2*1024*1024,rpcId,allowProxyFakeIp=false,allowPrivateNetwork=false}={}) {
  const url=remoteUrl(value);let addresses;
  try{addresses=await lookup(url.hostname,{all:true,verbatim:true});}catch{throw new DomainError('remote_unavailable',502);}
  requireThat(addresses.length>0&&addresses.every(item=>publicAddress(item.address)||allowProxyFakeIp&&proxyAddress(item.address)||allowPrivateNetwork&&privateNetworkAddress(item.address)),'remote_address_rejected',400);
  const target=addresses[0];
  return new Promise((resolve,reject)=>{
    const request=https.request(url,{method,headers:{'User-Agent':'Lingji-Meeting-Studio',...headers},signal:AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])]),lookup:(_hostname,options,callback)=>{
      if(options?.all)callback(null,[target]);else callback(null,target.address,target.family);
    }},response=>{
      const chunks=[],decoder=new StringDecoder('utf8');let size=0,events='';
      response.on('data',chunk=>{
        size+=chunk.length;if(size>maxBytes){response.destroy();reject(new DomainError('remote_response_too_large',502));return;}
        chunks.push(chunk);
        if(rpcId&&String(response.headers['content-type']).includes('text/event-stream')){
          events+=decoder.write(chunk);let boundary;
          while((boundary=/\r?\n\r?\n/.exec(events))){
            const event=events.slice(0,boundary.index);events=events.slice(boundary.index+boundary[0].length);
            try{const data=JSON.parse(event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n'));
              if(data.id===rpcId){resolve({status:response.statusCode,headers:response.headers,text:`data: ${JSON.stringify(data)}\n\n`});response.destroy();return;}
            }catch{ /* Empty SSE heartbeats carry no JSON-RPC response. */ }
          }
        }
      });
      response.once('error',()=>reject(new DomainError('remote_unavailable',502)));
      response.once('end',()=>{if(size>maxBytes)return;if(response.statusCode>=300&&response.statusCode<400){reject(new DomainError('remote_redirect_rejected',400));return;}resolve({status:response.statusCode,headers:response.headers,text:Buffer.concat(chunks).toString('utf8')});});
    });
    request.once('error',()=>reject(new DomainError('remote_unavailable',502)));
    request.end(body);
  });
}
