import { useEffect, useState } from 'react';
import { secondsUntil } from './lan-access';

export function useCountdown(deadline?: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (deadline === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= deadline) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === undefined ? 0 : secondsUntil(deadline, now);
}
