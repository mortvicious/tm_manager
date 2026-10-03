import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import { registerServiceWorker } from '../push.ts';
import { useApp } from '../state.tsx';
import { findTaskById } from '../taskId.ts';

/**
 * The page's half of Web Push (docs/push.md § Opening a notification). Renders
 * nothing; it
 * - registers /sw.js, so a subscribed device keeps an active worker;
 * - routes a tapped notification: the worker posts `tm-navigate` to an open
 *   app, or opens a new one at the URL, and `?task=<id>` opens that task's
 *   panel over whatever page the path names (a short id works too, by the
 *   Board's find-by-id rules);
 * - closes question banners that are no longer pending — iOS must show a
 *   banner for every push, so "answered elsewhere" is never pushed; the open
 *   app tidies up instead.
 */
export function PushBridge({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { questions, tasks } = useApp();
  const prevPending = useRef<Set<string> | null>(null);

  useEffect(() => {
    void registerServiceWorker();
  }, []);

  // ?task=<id> → open the panel, then drop the param so a reload or Back does
  // not reopen it
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get('task');
    if (!id) return;
    // a short id needs the task list to resolve against; an empty list at boot
    // means "not loaded yet", so keep the param until it lands. An unresolved
    // id goes through as it was: a full id whose task has not arrived yet
    // still opens once it does.
    const match = findTaskById(tasks, id);
    if (match.kind !== 'found' && tasks.length === 0) return;
    onOpenTask(match.kind === 'found' ? match.task.id : id);
    params.delete('task');
    const rest = params.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : '', hash: location.hash }, { replace: true });
  }, [location.search, location.pathname, location.hash, navigate, onOpenTask, tasks]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type === 'tm-navigate' && typeof d.url === 'string' && d.url.startsWith('/')) navigate(d.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  // On open and on every return to the app: the server's pending list is the
  // truth (the in-memory one is empty until the first load lands).
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const sweep = () => {
      if (document.visibilityState !== 'visible') return;
      api
        .listQuestions('pending')
        .then((qs) => closeQuestionBanners((id) => !qs.some((q) => q.id === id)))
        .catch(() => {});
    };
    sweep();
    document.addEventListener('visibilitychange', sweep);
    return () => document.removeEventListener('visibilitychange', sweep);
  }, []);

  // While open: a question that LEFT the pending set was answered or expired.
  useEffect(() => {
    const now = new Set(questions.map((q) => q.id));
    const prev = prevPending.current;
    prevPending.current = now;
    if (!prev) return;
    const gone = [...prev].filter((id) => !now.has(id));
    if (gone.length) void closeQuestionBanners((id) => gone.includes(id));
  }, [questions]);

  return null;
}

async function closeQuestionBanners(stale: (questionId: string) => boolean): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) return;
  for (const n of await reg.getNotifications()) {
    if (n.tag.startsWith('question-') && stale(n.tag.slice('question-'.length))) n.close();
  }
}
