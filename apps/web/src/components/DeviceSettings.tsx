import { useCallback, useEffect, useState } from 'react';
import { Microphone } from '@phosphor-icons/react';
import { inputDevices, preferredDevice, setPreferredDevice, type InputDevice } from '../audio/devices';
import { messageOf } from '../api';
import { Select } from './Select';
import { MicrophoneTest } from './MicrophoneTest';
export function DeviceSettings({ disabled = false, compact = false }: { disabled?: boolean; compact?: boolean }) {
  const [devices, setDevices] = useState<InputDevice[]>([]), [selected, setSelected] = useState(preferredDevice), [error, setError] = useState('');
  const refresh = useCallback(async () => { try { setDevices(await inputDevices()); } catch (e) { setError(messageOf(e)); } }, []);
  useEffect(() => { void refresh(); navigator.mediaDevices?.addEventListener('devicechange', refresh); return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh); }, [refresh]);
  const missing = selected !== 'default' && !devices.some(d => d.id === selected);
  return <div className={compact ? 'device-compact' : 'settings-section device-settings'}>{!compact && <div className="section-title"><Microphone size={19}/><h3>音频设置</h3></div>}
    <Select label="录音麦克风" disabled={disabled} value={missing ? 'default' : selected} onChange={id => { setPreferredDevice(id); setSelected(id); }} options={[{value:'default',label:'自动 · 优先真实麦克风'},...devices.map(d => ({value:d.id,label:d.label}))]}/>
    {!compact && <MicrophoneTest disabled={disabled} refresh={refresh}/>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
