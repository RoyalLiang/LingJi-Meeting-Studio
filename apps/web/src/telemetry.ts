// Local, opt-in diagnostics. Never stores PCM, transcript text, credentials or request bodies.
type Row = { stage: string; monoMs: number; durationMs?: number; recordId?: string; cursor?: string; sourceId?: string; sequence?: number; bytes?: number; count?: number; queueMs?: number; traceId?: string };
const events: Row[] = [];
export function traceEnabled(){try{return sessionStorage.getItem('meeting-trace')==='1';}catch{return false;}}
export function trace(stage: string, fields: Omit<Row, 'stage' | 'monoMs'> = {}) {
  try {
    if (sessionStorage.getItem('meeting-trace') !== '1') return;
    events.push({ stage, monoMs: performance.now(), ...fields });
    if (events.length > 512) events.shift();
  } catch { /* Diagnostics cannot interrupt capture. */ }
}
export const traceSnapshot = () => events.map(e => ({ ...e }));

export function traceSummary(){
  const stages=[...new Set(events.map(event=>event.stage))];
  return Object.fromEntries(stages.map(stage=>{const samples=events.filter(event=>event.stage===stage&&event.durationMs!==undefined).map(event=>event.durationMs!).sort((a,b)=>a-b);return [stage,{count:events.filter(event=>event.stage===stage).length,...Object.fromEntries([50,95,99].map(p=>[`p${p}Ms`,samples.length?samples[Math.ceil(samples.length*p/100)-1]:null]))}];}));
}

export function traceCommit(recordId:string,cursor:string){
  if(!traceEnabled())return;
  const received=[...events].reverse().find(event=>event.stage==='view.received'&&event.recordId===recordId&&event.cursor===cursor);
  trace('view.committed',{recordId,cursor,...(received?{durationMs:performance.now()-received.monoMs}:{})});
}
