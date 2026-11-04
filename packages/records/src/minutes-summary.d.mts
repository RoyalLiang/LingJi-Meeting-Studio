type SummaryText={elements:{text_run:{content:string;text_element_style?:{bold?:boolean;text_color?:number}}}[]};
export type SummaryBlock={block_id:string;block_type:number;children?:string[];text?:SummaryText;heading2?:SummaryText;bullet?:SummaryText;
  callout?:{background_color:number;border_color:number};grid?:{column_size:number};grid_column?:{width_ratio:number};
  table?:{property:{row_size:number;column_size:number;column_width:number[]}};table_cell?:Record<string,never>};
export type SummaryBlocks={children_id:string[];descendants:SummaryBlock[];index:number};
export function minutesSummaryBlocks(minutes:any,options?:{overview?:'full'|'compact'|'board';citations?:(refs:any[])=>string}):SummaryBlocks;
export function summaryBlocksHtml(graph:SummaryBlocks):string;
