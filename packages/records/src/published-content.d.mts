export class ShareContentError extends Error { code:string; status:number; }
export const MAX_PUBLISHED_BYTES: number;
export interface PublishedContent { schemaVersion:1; sourceRecordId:string; title:string; scope:'minutes'|'full'; draft:boolean; minutes:unknown; segments?:unknown[] }
export function normalizePublishedContent(input:unknown):PublishedContent;
export function createPublishedContent(record:{id:string;title:string;capture:string;minutes?:unknown;liveMinutes?:unknown;segments:unknown[]},scope:'minutes'|'full'):PublishedContent;
