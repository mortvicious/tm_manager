// The office planner's live turns (docs/office.md § Office planner), so Pause
// all can stop them without the orchestrator importing the chat service.
// A planner turn registers its stop for as long as it runs; `stopPlannerTurns`
// (called by `Orchestrator.pauseAll`) stops every one, and the service refuses
// new planner turns while the server is paused.

const live = new Map<string, () => void>();

/** Register a planner turn's stop; returns the unregister. */
export function registerPlannerTurn(chatId: string, stop: () => void): () => void {
  live.set(chatId, stop);
  return () => {
    if (live.get(chatId) === stop) live.delete(chatId);
  };
}

/** Stop every live planner turn (Pause all). Returns the planner chat ids stopped. */
export function stopPlannerTurns(): string[] {
  const ids = [...live.keys()];
  for (const id of ids) live.get(id)?.();
  return ids;
}

/** Planner turns running now. */
export function livePlannerTurns(): number {
  return live.size;
}
