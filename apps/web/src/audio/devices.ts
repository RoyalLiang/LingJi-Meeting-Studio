export type InputDevice = { id: string; label: string; isDefault?: boolean };
const preferenceKey = 'meeting-input-device';
export const preferredDevice = () => localStorage.getItem(preferenceKey) || 'default';
export const setPreferredDevice = (id: string) => localStorage.setItem(preferenceKey, id);
export async function inputDevices(): Promise<InputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  const defaultInput = devices.find(d => d.kind === 'audioinput' && d.deviceId === 'default');
  return devices.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, index) => ({ id: d.deviceId, label: d.label || `麦克风 ${index + 1}`, isDefault: Boolean(defaultInput?.groupId && defaultInput.groupId === d.groupId) }));
}
const loopback = /system audio|blackhole|loopback|soundflower|virtual|vb[- ]?cable|zoom.*audio|teams.*audio|background music|虚拟|回环/i;
const microphone = /microphone|麦克风|built.?in|内建|内置|airpods|headset|耳机/i;
const physicalMicrophone = (devices: InputDevice[]) => devices.find(device => microphone.test(device.label) && !loopback.test(device.label));
export function microphoneConstraints(preferred: string, devices: InputDevice[]) {
  const explicit = preferred !== 'default' && devices.some(d => d.id === preferred);
  const current = devices.find(device => device.isDefault);
  const selected = explicit ? preferred : current && loopback.test(current.label) ? physicalMicrophone(devices)?.id : undefined;
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(selected ? { deviceId: { exact: selected } } : {}) };
}
export async function openMicrophone(preferred = preferredDevice()) {
  const devices = await inputDevices();
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(preferred, devices), video: false }); }
  catch (error) {
    if (!(error instanceof DOMException) || !['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  }
  // Device labels may only become available after permission. Never override an explicit available choice.
  if ((preferred === 'default' || !devices.some(device => device.id === preferred)) && loopback.test(stream.getAudioTracks()[0]?.label || '')) {
    try {
      const replacement = physicalMicrophone(await inputDevices());
      if (replacement) {
        const microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(replacement.id, [replacement]), video: false });
        stream.getTracks().forEach(track => track.stop()); stream = microphoneStream;
      }
    } catch { /* Keep the original track visible; signal diagnostics will explain silence. */ }
  }
  return stream;
}
