type Ref={segmentId:string;revision:number};
type Item={text:string;evidence:Ref[];topicId?:string;label?:string;kind?:'fact'|'decision'|'action'|'risk'|'question';status?:string};
type Topic={id?:string;title:string;summary:string;evidence:Ref[]};
type Minutes={edited?:boolean;topics?:Topic[];sections:{heading:string;items:Item[]}[]};
export function uniqueMinutesItems<T extends Item>(items?:T[]):T[];
export function minutesReadingSections<T extends Minutes>(minutes:T):T['sections'];
export function minutesReadingBranches(minutes:Minutes):(Topic&{items:Item[]})[];
export function minutesReadingLayout<T extends Minutes&{tables?:unknown[];visuals?:unknown[]}>(minutes:T):{
 branches:(Topic&{items:Item[];tables:NonNullable<T['tables']>;visuals:NonNullable<T['visuals']>})[];
 unassigned:{tables:NonNullable<T['tables']>;visuals:NonNullable<T['visuals']>};
};
