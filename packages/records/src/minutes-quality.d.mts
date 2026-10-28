type Ref={segmentId:string;revision:number};
type SourceItem={text:string;evidence:Ref[];kind?:string;label?:string;status?:string};
type SourceMinutes={title:string;sections:{heading:string;items:SourceItem[]}[];actions?:(SourceItem&{owner?:string|null;due?:string|null})[]};
type ManualContent={
  title:string;
  sections:{heading:string;items:{text:string;evidence:Ref[]}[]}[];
  actions:{text:string;owner:string|null;due:string|null;evidence:Ref[];status?:'pending';label?:string;kind?:string}[];
  decisions:never[];
  highlights:undefined;
  visuals:undefined;
  topics:undefined;
  tables:undefined;
  speakerSummaries:undefined;
  currentDiscussion:undefined;
  corrections:undefined;
};
export function manualMinutesContent<T extends SourceMinutes>(minutes:T):ManualContent;
export const minutesKindLabels:Readonly<Record<'fact'|'decision'|'action'|'risk'|'question',string>>;
export function minutesStateLabel<T extends object>(item:T):string|undefined;

export function minutesActionText(item:SourceItem&{topicId?:string},topics?:{id?:string;title:string}[]):string;
