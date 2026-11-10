export type MeetingActivity = {sampledAt:number;receivedAt?:number;active:boolean;startActive?:boolean;input?:boolean;output?:boolean;error?:string};
export type MeetingReport = {id:string;recording:boolean;paused:boolean;busy:boolean};
type Pending = {kind:'start'|'stop';since:number;due:number;recordId:string};

const START_MS=4000,STOP_MS=10000;

export function createMeetingAutomation() {
  let owned='',suppressed=false,quietAt:number|null=null,lastAt:number|null=null,pending:Pending|null=null,acting=false,inputAt:number|null=null,outputAt:number|null=null;
  return {
    get pending(){return pending;},
    reconfigure(){pending=null;quietAt=null;lastAt=null;inputAt=null;outputAt=null;},
    sample(signal:MeetingActivity,report:MeetingReport):Pending|null {
      const gap=lastAt!==null && (signal.sampledAt-lastAt>10000 || signal.sampledAt<lastAt);
      lastAt=signal.sampledAt;
      const stale=signal.receivedAt!==undefined && Math.abs(signal.receivedAt-signal.sampledAt)>6000;
      if(signal.error || gap || stale){pending=null;quietAt=null;inputAt=null;outputAt=null;return null;}
      if(acting)return null;
      if(!signal.active){inputAt=null;outputAt=null;}
      if(signal.input)inputAt=signal.sampledAt;
      if(signal.output)outputAt=signal.sampledAt;
      // Browser capture/playback processes need not report in the same polling instant.
      const duplex=inputAt!==null&&outputAt!==null&&signal.sampledAt-inputAt<=6000&&signal.sampledAt-outputAt<=6000;
      const startActive=signal.input!==undefined&&signal.output!==undefined?duplex:(signal.startActive??signal.active);
      if(signal.active)quietAt=null;
      else {quietAt??=signal.sampledAt;if(signal.sampledAt-quietAt>=STOP_MS)suppressed=false;}
      if(owned && (!report.recording || report.id!==owned)){owned='';suppressed=true;pending=null;}
      if(!owned && (report.recording || report.paused)){
        pending=null;if(signal.active)suppressed=true;return null;
      }
      const kind=owned ? (!signal.active ? 'stop' : null) : (startActive && !suppressed && !report.busy ? 'start' : null);
      if(!kind){pending=null;return null;}
      if(pending?.kind!==kind)pending={kind,since:signal.sampledAt,due:signal.sampledAt+(kind==='start'?START_MS:STOP_MS),recordId:owned};
      if(signal.sampledAt<pending.due || report.busy)return null;
      acting=true;return pending;
    },
    started(id?:string){owned=id || '';suppressed=!id;pending=null;acting=false;},
    stopped(){owned='';suppressed=true;pending=null;acting=false;},
    cancel(){if(pending?.kind==='stop')owned='';pending=null;suppressed=true;quietAt=null;},
  };
}
