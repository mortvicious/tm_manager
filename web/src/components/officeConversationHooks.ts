// The live half of the office conversation list (docs/office.md §
// Conversation list): this office's chats following the EXISTING frames —
// `chat.updated` merged by `mergeChatUpdate`, `chat.message` applied by
// `applyChatMessage` (the store drops frames of chats it has not loaded; this
// hook does not) — and the device's read markers, which follow `markRead`
// in this tab and the `storage` event from another. No polling.
import { useEffect, useState } from 'react';
import type { Chat } from '@tm/shared';
import { api } from '../api.ts';
import { OFFICE_READ_BASELINE_KEY, OFFICE_READ_KEY, applyChatMessage, loadBaselinedReadMap, onReadChange, upsertChat, type ReadMap } from '../officeConversations.ts';
import { onServerEvent } from '../state.tsx';

/** This office's chats, newest first, kept live from the chat frames. */
export function useOfficeChats(officeId: string): { list: Chat[] | null; error: string | null } {
  const [list, setList] = useState<Chat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setList(null);
    api.listOfficeChats(officeId).then(
      (l) => live && (setList(l), setError(null)),
      (e) => live && setError((e as Error)?.message || String(e)),
    );
    const off = onServerEvent((e) => {
      if (e.type === 'chat.updated' && e.chat.officeId === officeId) {
        setList((cur) => upsertChat(cur ?? [], e.chat));
      } else if (e.type === 'chat.message') {
        const m = e.message;
        setList((cur) => {
          if (!cur) return cur;
          const i = cur.findIndex((c) => c.id === m.chatId);
          if (i === -1) return cur;
          const next = applyChatMessage(cur[i], m);
          if (next === cur[i]) return cur;
          const out = cur.slice();
          out[i] = next;
          return out;
        });
      } else if (e.type === 'chat.deleted') {
        setList((cur) => (cur ? cur.filter((c) => c.id !== e.chatId) : cur));
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [officeId]);
  return { list, error };
}

/** The device's read markers; null until this device's baseline is written (see `writeBaseline`). */
export function useReadMap(): ReadMap | null {
  const [map, setMap] = useState<ReadMap | null>(() => loadBaselinedReadMap());
  useEffect(() => {
    const reload = () => setMap(loadBaselinedReadMap());
    const offLocal = onReadChange(reload);
    const onStorage = (e: StorageEvent) => {
      if (e.key === OFFICE_READ_KEY || e.key === OFFICE_READ_BASELINE_KEY || e.key === null) reload();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      offLocal();
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return map;
}
