import { useSyncExternalStore } from 'react';

/**
 * The legacy Board's sections in the order it draws them, for the phone task
 * panel's previous/next (docs/mobile.md § Panel prev/next). The Board
 * publishes them on every render that changes them and clears them when it
 * unmounts, so a panel opened anywhere else (Inbox, a push tap on another
 * page) has no neighbours and shows no strip.
 *
 * A task can sit in two lists (pinned Active and Recent, say), so a row
 * notes the KIND of list it was opened from and the panel steps through
 * that one; a list of that kind without the task (a deep link over the
 * board) falls back to the first section holding it.
 */
export type BoardListKind = 'active' | 'drafts' | 'grouped' | 'hidden' | 'recent';

export interface BoardSection {
  key: string;
  label: string;
  kind: BoardListKind;
  ids: readonly string[];
}

export interface TaskNeighbours {
  label: string;
  index: number;
  count: number;
  prev: string | null;
  next: string | null;
}

let sections: readonly BoardSection[] = [];
let origin: BoardListKind | null = null;
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  for (const l of listeners) l();
};

const sameSections = (a: readonly BoardSection[], b: readonly BoardSection[]) =>
  a.length === b.length &&
  a.every((s, i) => s.key === b[i].key && s.label === b[i].label && s.ids.length === b[i].ids.length && s.ids.every((id, j) => id === b[i].ids[j]));

export function publishBoardSections(next: readonly BoardSection[]): void {
  if (sameSections(sections, next)) return;
  sections = next;
  emit();
}

/** the row a task was opened from (Board.tsx) */
export function noteOpenedFrom(kind: BoardListKind): void {
  origin = kind;
}

/** pure: where `taskId` sits among `list`, preferring the list kind it was opened from */
export function neighboursIn(list: readonly BoardSection[], taskId: string, from: BoardListKind | null): TaskNeighbours | null {
  const holding = list.filter((s) => s.ids.includes(taskId));
  const sec = (from && holding.find((s) => s.kind === from)) || holding[0];
  if (!sec || sec.ids.length < 2) return null;
  const index = sec.ids.indexOf(taskId);
  return {
    label: sec.label,
    index,
    count: sec.ids.length,
    prev: index > 0 ? sec.ids[index - 1] : null,
    next: index < sec.ids.length - 1 ? sec.ids[index + 1] : null,
  };
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTaskNeighbours(taskId: string): TaskNeighbours | null {
  useSyncExternalStore(subscribe, () => version);
  // a step keeps the kind of list it started in, so prev/next stay in one list
  return neighboursIn(sections, taskId, origin);
}
