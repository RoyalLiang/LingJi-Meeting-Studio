import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
const encode=promisify(gzip);
const compressed=new WeakMap();
const acceptsGzip=value=>{
  const entries=String(value||'').split(',').map(part=>part.trim().split(';'));
  const entry=entries.find(([name])=>name.toLowerCase()==='gzip')||entries.find(([name])=>name==='*');
  if(!entry)return false;const quality=entry.slice(1).find(value=>/^\s*q\s*=/i.test(value));
  return !quality||Number(quality.split('=')[1])>0;
};
// Buffer identity shares encoding work with the bounded record/static response caches.
export async function sendHttpPayload(res,status,payload,headers={}){
  const source=Buffer.isBuffer(payload)?payload:Buffer.from(payload);let body=source,encoding;
  if(source.length>=1024&&source.length<=24*1024*1024&&status===200&&acceptsGzip(res.req?.headers['accept-encoding'])&&/^(?:text\/|application\/(?:json|javascript)|image\/svg\+xml)/i.test(headers['Content-Type']||'')){
    let pending=compressed.get(source);if(!pending){pending=encode(source,{level:1}).catch(()=>source);compressed.set(source,pending);}
    const result=await pending;if(result.length<source.length){body=result;encoding='gzip';}
  }
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{...headers,Vary:[headers.Vary,'Accept-Encoding'].filter(Boolean).join(', '),'Content-Length':body.length,...(encoding?{'Content-Encoding':encoding}:{})});
  res.end(res.req?.method==='HEAD'?undefined:body);
}
