import { useCallback, useEffect, useState } from 'react';
import { Microphone } from '@phosphor-icons/react';
import { inputDevices, preferredDevice, setPreferredDevice, type InputDevice } from '../audio/devices';
import { messageOf } from '../api';
import { Select } from './Select';
import { Button } from './ui';
export function DeviceSettings({ disabled = false, compact = false }: { disabled?: boolean; compact?: boolean }) {
  const [devices, setDevices] = useState<InputDevice[]>([]), [selected, setSelected] = useState(preferredDevice), [error, setError] = useState('');
  const refresh = useCallback(async () => { try { setDevices(await inputDevices()); } catch (e) { setError(messageOf(e)); } }, []);
  useEffect(() => { void refresh(); navigator.mediaDevices?.addEventListener('devicechange', refresh); return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh); }, [refresh]);
  const missing = selected !== 'default' && !devices.some(d => d.id === selected);
  return <div className={compact ? 'device-compact' : 'settings-section'}>{!compact && <div className="section-title"><Microphone size={19}/><h3>音频输入设备</h3></div>}
    <Select label="录音麦克风" disabled={disabled} value={missing ? 'default' : selected} onChange={id => { setPreferredDevice(id); setSelected(id); }} options={[{value:'default',label:'自动 · 跟随系统默认麦克风'},...devices.map(d => ({value:d.id,label:d.label}))]}/>
    {!compact && <><p className="fine-print">自动模式跟随系统默认输入；指定设备不可用时，录制会回退到系统默认。实际设备名会显示在录音来源中。屏幕共享的音轨由浏览器选择器决定。</p><Button disabled={disabled} onClick={async () => { try { const stream = await navigator.mediaDevices.getUserMedia({audio:true}); stream.getTracks().forEach(t => t.stop()); await refresh(); setError(''); } catch (e) { setError(messageOf(e)); } }}>授权并刷新设备</Button></>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
