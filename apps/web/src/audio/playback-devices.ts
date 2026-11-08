import {isTauri,invoke} from '@tauri-apps/api/core';
export type ApplicationAudio={id:string;label:string};
export type ApplicationAudioOptions={supported:boolean;applications:ApplicationAudio[];reason?:string|null};
const key='meeting-playback-source';
let selected='system';
try {selected=localStorage.getItem(key)||'system';}catch {/* Use this window's selection when storage is unavailable. */}
export const preferredPlayback=()=>selected;
export function setPreferredPlayback(value:string){selected=value;try{localStorage.setItem(key,value);}catch {/* The current selection still applies in this window. */}}
export const nativePlaybackSelection=()=>isTauri();
export async function applicationAudioOptions():Promise<ApplicationAudioOptions>{
 if(!isTauri())return {supported:false,applications:[]};
 return invoke<ApplicationAudioOptions>('capture_applications');
}
