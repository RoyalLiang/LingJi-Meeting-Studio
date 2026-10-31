import { useEffect, useRef, useState } from 'react';
import { RecordingClock } from './audio/signal';

export function useRecordingDuration(id: string, savedMs: number, active: boolean) {
  const [clock] = useState(() => new RecordingClock());
  const saved = useRef(savedMs); saved.current = savedMs;
  const [duration, setDuration] = useState(savedMs);
  useEffect(() => {
    const update = () => setDuration(Math.floor(clock.read(id, saved.current, active, performance.now()) / 1000) * 1000);
    update();
    if (!active) return;
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [id, active, clock]);
  return active ? duration : savedMs;
}
