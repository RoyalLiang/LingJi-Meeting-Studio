import { invoke } from '@tauri-apps/api/core';
import { openNativeStream, type NativeProgress, type NativePacket } from './native-stream';
export const startNativeStream = (kind: 'display' | 'microphone', deviceId: string,
  onPacket: (packet: NativePacket) => Promise<void>, onError: (error: Error, retaining?: boolean) => void, onProgress?: (progress: NativeProgress) => void) =>
  openNativeStream((command, args) => invoke(command, args), kind, deviceId, onPacket, onError, onProgress);
