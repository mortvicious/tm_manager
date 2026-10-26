import { useEffect, useState } from 'react';

/** How long an armed button waits for its second press before it disarms. */
export const ARM_MS = 4000;

/**
 * The two-press arm (docs/mobile.md § Confirming destructive actions): the
 * first press on a button that kills or discards something only ARMS it — its
 * label turns into the question ("Cancel? tap again") — and a second press on
 * the SAME button within `ARM_MS` runs it. Never a browser dialog, which on a
 * phone is a modal over the whole app.
 *
 * One hook arms one key at a time, so arming a second button disarms the
 * first: a surface never has two armed buttons a stray tap could hit.
 */
export function useArm() {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  return {
    armed,
    /** true when this press should run the action (the second one); the first only arms */
    press: (key: string): boolean => {
      if (armed === key) {
        setArmed(null);
        return true;
      }
      setArmed(key);
      return false;
    },
    disarm: () => setArmed(null),
  };
}
