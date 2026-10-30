export type MeetingActivity = {sampledAt:number;receivedAt?:number;active:boolean;error?:string};
export type MeetingReport = {id:string;recording:boolean;paused:boolean;busy:boolean};
type Pending = {kind:'start'|'stop';since:number;due:number;recordId:string};

export function createMeetingAutomation() {
  let owned='',suppressed=false,quietAt:number|null=null,lastAt:number|null=null,pending:Pending|null=null,acting=false;
  return {
    get pending(){return pending;},
    reconfigure(){pending=null;quietAt=null;lastAt=null;},
    sample(signal:MeetingActivity,report:MeetingReport):Pending|null {
      const gap=lastAt!==null && (signal.sampledAt-lastAt>10000 || signal.sampledAt<lastAt);
      lastAt=signal.sampledAt;
      const stale=signal.receivedAt!==undefined && Math.abs(signal.receivedAt-signal.sampledAt)>6000;
      if(signal.error || gap || stale){pending=null;quietAt=null;return null;}
      if(acting)return null;
      if(signal.active)quietAt=null;
      else {quietAt??=signal.sampledAt;if(signal.sampledAt-quietAt>=30000)suppressed=false;}
      if(owned && (!report.recording || report.id!==owned)){owned='';suppressed=true;pending=null;}
      if(!owned && (report.recording || report.paused)){
        pending=null;if(signal.active)suppressed=true;return null;
      }
      const kind=owned ? (!signal.active ? 'stop' : null) : (signal.active && !suppressed && !report.busy ? 'start' : null);
      if(!kind){pending=null;return null;}
      if(pending?.kind!==kind)pending={kind,since:signal.sampledAt,due:signal.sampledAt+(kind==='start'?10000:30000),recordId:owned};
      if(signal.sampledAt<pending.due || report.busy)return null;
      acting=true;return pending;
    },
    started(id?:string){owned=id || '';suppressed=!id;pending=null;acting=false;},
    stopped(){owned='';suppressed=true;pending=null;acting=false;},
    cancel(){if(pending?.kind==='stop')owned='';pending=null;suppressed=true;quietAt=null;},
  };
}
