export type InputDevice = { id: string; label: string };
const preferenceKey = 'meeting-input-device';
export const preferredDevice = () => localStorage.getItem(preferenceKey) || 'default';
export const setPreferredDevice = (id: string) => localStorage.setItem(preferenceKey, id);
export async function inputDevices(): Promise<InputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, index) => ({ id: d.deviceId, label: d.label || `麦克风 ${index + 1}` }));
}
export function microphoneConstraints(preferred: string, devices: InputDevice[]) {
  // Follow the OS default unless an available explicit preference was selected.
  const selected = preferred !== 'default' && devices.some(d => d.id === preferred) ? preferred : undefined;
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(selected ? { deviceId: { exact: selected } } : {}) };
}
