declare module 'qrcode' {
  export function toDataURL(value: string, options?: { width?: number; margin?: number }): Promise<string>;
}
