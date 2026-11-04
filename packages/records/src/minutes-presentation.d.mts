export function minutesOverview(minutes:any):{layout:any;summaryLabel:string;summary:any[];decisions:any[];actions:any[];pending:any[]};
export function minutesBoard(minutes:any,options?:{theme?:'light'|'dark';includeSummary?:boolean;citations?:(refs:any[])=>string}):any[];
export function boardSvg(nodes:any[],options?:{responsiveTheme?:boolean}):string;
