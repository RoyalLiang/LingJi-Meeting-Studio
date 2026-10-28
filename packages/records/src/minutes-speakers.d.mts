type SpeakerSegment = {id:string;revision:number;speakerId?:string|null;speakerHash?:string|null;speaker?:string|null;speakerName?:string|null;startMs?:number;endMs?:number};
type SpeakerIdentity = {id:string;hash?:string|null;label:string};
export function speakerLabels(snapshot:SpeakerSegment[],registry?:SpeakerIdentity[],current?:SpeakerSegment[]):Map<string,string>;
