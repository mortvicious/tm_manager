import type { ServerEvent } from '@tm/shared';

type Listener = (e: ServerEvent) => void;

// Tiny in-process event bus: routes/orchestrator publish, the /ws/events
// endpoint subscribes and fans out to browsers.
const listeners = new Set<Listener>();

export function onEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function broadcast(e: ServerEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      // a broken listener must not break the publisher
    }
  }
}
