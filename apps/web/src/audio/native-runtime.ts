import { invoke, isTauri } from '@tauri-apps/api/core';
import { openNativeStream, type NativeProgress, type NativePacket } from './native-stream';
export const startNativeStream = (kind: 'display' | 'microphone', deviceId: string,
  onPacket: (packet: NativePacket) => Promise<void>, onError: (error: Error, retaining?: boolean) => void, onProgress?: (progress: NativeProgress) => void) =>
  openNativeStream((command, args) => invoke(command, args), kind, deviceId, onPacket, onError, onProgress);

import { openNativeDirect, attachNativeDirect, type DirectSession, type DirectProgress } from './native-direct';
let directAudio = false;
export const setNativeAudioTransport = (transport?: string | null) => { directAudio = transport === 'native-file-v1'; };
export const nativeAudioDirect = () => directAudio;
export const startNativeDirect = (recordId: string, kind: 'display' | 'microphone', deviceId: string, onError: (error: Error | null, retaining?: boolean) => void, onProgress: (progress: DirectProgress) => void) => openNativeDirect((command, args) => invoke(command, args), recordId, kind, deviceId, onError, onProgress);

export const nativeCaptureSessions = async (): Promise<DirectSession[]> => isTauri() && directAudio ? (await invoke<DirectSession[]>('capture_direct_sessions')).filter(session=>!session.purged) : [];
export const restoreNativeDirect = (session: DirectSession, onError: (error: Error | null, retaining?: boolean) => void, onProgress: (progress: DirectProgress) => void) => attachNativeDirect((command,args)=>invoke(command,args),session,onError,onProgress);

export const controlNativeRecord = (recordId: string, action: 'pause' | 'seal') => invoke('capture_direct_control',{recordId,action});

export const stoppedNativeManifest = (id:string) => invoke<import('./native-direct').NativeManifest>('capture_direct_stop',{id,action:'source'});

export const setNativeKind = (recordId:string,kind:'display'|'microphone',enabled:boolean) => invoke('capture_direct_kind',{recordId,kind,enabled});
