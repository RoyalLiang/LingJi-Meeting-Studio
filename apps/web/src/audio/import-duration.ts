export async function importDuration(file:File):Promise<number>{
  const media=new Audio(),url=URL.createObjectURL(file);
  try{
    const seconds=await new Promise<number>((resolve,reject)=>{
      const finish=(error?:Error)=>{clearTimeout(timer);media.onloadedmetadata=null;media.onerror=null;error?reject(error):resolve(media.duration);};
      const timer=setTimeout(()=>finish(new Error('无法读取音频时长，请转换为 WAV 后重试。')),15000);
      media.onloadedmetadata=()=>finish();media.onerror=()=>finish(new Error('无法读取音频文件，请检查格式。'));
      media.preload='metadata';media.src=url;
    });
    if(!Number.isFinite(seconds)||seconds<=0)throw new Error('无法确认音频时长，请转换为 WAV 后重试。');
    // shortcut: compressed audio still decodes whole-file; add native/streaming decoding before lifting this bound.
    if(seconds>15*60)throw new Error('音频超过 15 分钟，请先拆分后导入，以免浏览器解码占满内存。');
    return seconds;
  }finally{media.removeAttribute('src');media.load();URL.revokeObjectURL(url);}
}

export async function pcmWaveInfo(file:File):Promise<{offset:number;channels:number;samples:number}|null>{
  const bytes=await file.slice(0,65536).arrayBuffer(),view=new DataView(bytes);
  const tag=(offset:number)=>String.fromCharCode(...new Uint8Array(bytes,offset,4));
  if(bytes.byteLength<12||tag(0)!=='RIFF'||tag(8)!=='WAVE')return null;
  let channels=0;
  for(let offset=12;offset+8<=bytes.byteLength;){
    const length=view.getUint32(offset+4,true),kind=tag(offset),start=offset+8;
    if(kind==='fmt '){
      if(length<16||start+16>bytes.byteLength)return null;
      channels=view.getUint16(start+2,true);
      if(view.getUint16(start,true)!==1||![1,2].includes(channels)||view.getUint32(start+4,true)!==16000||view.getUint16(start+14,true)!==16||view.getUint16(start+12,true)!==channels*2)return null;
    }
    if(kind==='data'&&channels){
      if(!length||length%(channels*2)||start+length>file.size)throw new Error('WAV 音频数据不完整，请检查原文件。');
      return {offset:start,channels,samples:length/(channels*2)};
    }
    offset=start+length+(length%2);
  }
  return null;
}
