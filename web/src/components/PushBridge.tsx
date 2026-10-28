import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import { NAVIGATE_EVENT } from '../nav.ts';
import { registerServiceWorker } from '../push.ts';
import { useApp } from '../state.tsx';
import { findTaskById } from '../taskId.ts';

/**
 * The page's half of Web Push (docs/push.md § Opening a notification). Renders
 * nothing; it
 * - registers /sw.js, so a subscribed device keeps an active worker;
 * - routes a tapped notification: the worker posts `tm-navigate` to an open
 *   app, or opens a new one at the URL, and `?task=<id>` is that task's
 *   panel over whatever page the path names (App.tsx; a short id is resolved
 *   here, by the Board's find-by-id rules);
 * - closes question banners that are no longer pending — iOS must show a
 *   banner for every push, so "answered elsewhere" is never pushed; the open
 *   app tidies up instead.
 */
export function PushBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  const { questions, tasks } = useApp();
  const prevPending = useRef<Set<string> | null>(null);

  useEffect(() => {
    void registerServiceWorker();
  }, []);

  // ?task=<id> IS the open panel (App.tsx useOpenTask). A short id is
  // resolved to the full one in place, keeping the history entry and its
  // state; it needs the task list, so it waits for the first load. An id
  // that does not resolve is left as it is: a full id whose task has not
  // arrived yet still opens once it does.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get('task');
    if (!id) return;
    const match = findTaskById(tasks, id);
    if (match.kind !== 'found' || match.task.id === id) return;
    params.set('task', match.task.id);
    navigate(
      { pathname: location.pathname, search: `?${params.toString()}`, hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [location.search, location.pathname, location.hash, location.state, navigate, tasks]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type === 'tm-navigate' && typeof d.url === 'string' && d.url.startsWith('/')) navigate(d.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  // The in-page twin (nav.ts): code outside the router asks for a URL.
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const url = (e as CustomEvent<unknown>).detail;
      if (typeof url === 'string' && url.startsWith('/')) navigate(url);
    };
    window.addEventListener(NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(NAVIGATE_EVENT, onNavigate);
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
      // the same for approval requests decided elsewhere (docs/approvals.md)
      api
        .listApprovals('pending')
        .then((as) => closeQuestionBanners((id) => !as.some((a) => a.id === id), 'approval-'))
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

async function closeQuestionBanners(stale: (id: string) => boolean, prefix = 'question-'): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) return;
  for (const n of await reg.getNotifications()) {
    if (n.tag.startsWith(prefix) && stale(n.tag.slice(prefix.length))) n.close();
  }
}
