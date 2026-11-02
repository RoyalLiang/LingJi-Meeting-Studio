import type { PublishedContent } from './published-content.mjs';
export const MAX_ENCRYPTED_PLAINTEXT: number;
export const SHARE_TOKEN: RegExp;
export interface EncryptedEnvelope { version: 1; iv: string; ciphertext: string }
export function encodeShareBytes(bytes: Uint8Array): string;
export function normalizeEncryptedEnvelope(input: unknown): EncryptedEnvelope;
export function shareFingerprint(input: unknown): Promise<string>;
export function encryptShare(input: unknown): Promise<{ token: string; revokeToken: string; key: string; envelope: EncryptedEnvelope }>;
export function decryptShare(input: unknown, key: string, token: string): Promise<PublishedContent>;
