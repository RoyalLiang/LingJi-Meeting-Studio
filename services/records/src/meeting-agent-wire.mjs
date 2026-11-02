// Transport deduplication leaves durable snapshots and their revision hashes unchanged.
export function meetingSourceWire(snapshot){
  if(!snapshot.minutes?.evidenceSnapshot)return snapshot;
  const current=new Map(snapshot.segments.map(segment=>[`${segment.id}:${segment.revision}`,segment]));
  const evidenceSnapshot=snapshot.minutes.evidenceSnapshot.map(({id,revision,text,sourceId,speakerId,speaker,speakerName,startMs,endMs})=>({id,revision,sourceId,speakerId,speaker,speakerName,startMs,endMs,...(current.get(`${id}:${revision}`)?.text===text?{}:{text})}));
  return {...snapshot,minutes:{...snapshot.minutes,evidenceSnapshot}};
}

// Read only root/result.summary fields; strings, arrays and nested tool arguments cannot change the path.
export function meetingSummaryPreview(json){
  const read=start=>{
    let value='',i=start+1;
    for(;i<json.length;i++){
      const char=json[i];if(char==='"')return {value,end:i,closed:true};
      if(char==='\\'){
        const next=json[++i];if(next===undefined)break;
        if(next==='u'){
          const hex=json.slice(i+1,i+5);if(!/^[\da-f]{4}$/i.test(hex))break;
          value+=String.fromCharCode(parseInt(hex,16));i+=4;
        }else{
          const escapes={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
          if(!(next in escapes))break;value+=escapes[next];
        }
      }else {if(char<' ')break;value+=char;}
    }
    return {value,end:i,closed:false};
  };
  let depth=0,resultStart=-1,resultDepth=-1;
  const next=at=>{while(/\s/.test(json[at]||'')&&at<json.length)at++;return at;};
  for(let i=0;i<json.length;i++){
    if(json[i]==='{'){depth++;if(i===resultStart)resultDepth=depth;}
    else if(json[i]==='}'){if(depth===resultDepth)resultDepth=-1;depth--;}
    else if(json[i]==='[')depth++;
    else if(json[i]===']')depth--;
    else if(json[i]==='"'){
      const token=read(i);if(!token.closed)return '';i=token.end;
      const colon=next(i+1);if(json[colon]!==':')continue;
      const value=next(colon+1);
      if(depth===1&&token.value==='result'&&json[value]==='{')resultStart=value;
      if((depth===1||depth===resultDepth)&&token.value==='summary'&&json[value]==='"')return read(value).value.slice(0,12000);
    }
  }
  return '';
}
