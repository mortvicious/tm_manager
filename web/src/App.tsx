import { useCallback, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Layout } from './components/Layout.tsx';
import { QuestionModal } from './components/QuestionModal.tsx';
import { PushBridge } from './components/PushBridge.tsx';
import { TaskSlideOver } from './components/TaskSlideOver.tsx';
import { TerminalDrawer } from './components/TerminalDrawer.tsx';
import { Toasts } from './components/Toasts.tsx';
import { BoardPage } from './pages/Board.tsx';
import { ChatPage } from './pages/Chat.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { FeaturePage } from './pages/Feature.tsx';
import { FeaturesPage } from './pages/Features.tsx';
import { ConfigPage } from './pages/Config.tsx';
import { HandbookPage } from './pages/Handbook.tsx';
import { InboxPage } from './pages/Inbox.tsx';
import { QueuePage } from './pages/Queue.tsx';
import { SharedPage } from './pages/Shared.tsx';
import { ReportsPage } from './pages/Reports.tsx';
import { ReposPage } from './pages/Repos.tsx';
import { TerminalsPage } from './pages/Terminals.tsx';
import type { InboxReturn, ReturnTo } from './returnTo.ts';
import { useTermDock } from './termLayout.ts';

export function App() {
  const [openTask, setOpenTask] = useOpenTask();
  // nonce so re-opening the already-open terminal still re-expands a compacted drawer;
  // `from` is the panel or Inbox item it replaced, reopened when it closes
  const [openTerminal, setOpenTerminal] = useState<{ runId: string; nonce: number; from?: ReturnTo } | null>(null);
  const openTerm = useCallback(
    (runId: string, from?: ReturnTo) => setOpenTerminal((cur) => ({ runId, nonce: (cur?.nonce ?? 0) + 1, from })),
    [],
  );
  const [inboxReturn, setInboxReturn] = useState<InboxReturn | null>(null);
  // a wide window can dock the drawer right of the panel: both stay open then
  const { docked } = useTermDock();
  // Back to where the terminal was opened from (UX review #13: "read findings →
  // check the terminal → come back and Publish" is the supervision loop). Not
  // after a click-outside close: that click was aimed at something else.
  const closeTerm = (how?: 'outside') => {
    const from = openTerminal?.from;
    setOpenTerminal(null);
    if (!from || how === 'outside') return;
    if (from.kind === 'task') setOpenTask((cur) => cur ?? from.id);
    // a task panel opened over the terminal meanwhile keeps the screen
    else if (!openTask) setInboxReturn((cur) => ({ key: from.key, sheet: from.sheet, nonce: (cur?.nonce ?? 0) + 1 }));
  };

  return (
    <Layout onOpenTerminal={openTerm} onOpenTask={setOpenTask} inboxReturn={inboxReturn}>
      <Routes>
        <Route path="/" element={<OpenOnBoard />} />
        <Route path="/dashboard" element={<DashboardPage onOpenTask={setOpenTask} />} />
        <Route path="/board" element={<BoardPage onOpenTask={setOpenTask} onOpenTerminal={openTerm} />} />
        <Route path="/inbox" element={<InboxPage onOpenTask={setOpenTask} onOpenTerminal={openTerm} inboxReturn={inboxReturn} />} />
        <Route path="/queue" element={<QueuePage onOpenTask={setOpenTask} onOpenTerminal={openTerm} />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/features/:id" element={<FeaturePage onOpenTask={setOpenTask} />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/shared" element={<SharedPage onOpenTask={setOpenTask} />} />
        <Route path="/terminals" element={<TerminalsPage onOpenTerminal={openTerm} onOpenTask={setOpenTask} />} />
        <Route path="/repos" element={<ReposPage onOpenTerminal={openTerm} />} />
        <Route path="/config" element={<ConfigPage />} />
        <Route path="/handbook" element={<HandbookPage />} />
      </Routes>
      {openTask && (
        <TaskSlideOver
          taskId={openTask}
          onOpenTask={setOpenTask}
          onClose={() => setOpenTask(null)}
          onOpenTerminal={(runId) => {
            // Slide-over closes: its overlay sits above the terminal drawer (review R7).
            // Its edits survive in the panel's draft memory, and it comes back on close.
            // Docked right (a window of 1600px+) the drawer sits beside it instead.
            if (!docked) setOpenTask(null);
            openTerm(runId, { kind: 'task', id: openTask });
          }}
        />
      )}
      {openTerminal && (
        <TerminalDrawer
          runId={openTerminal.runId}
          expandSignal={openTerminal.nonce}
          onClose={closeTerm}
        />
      )}
      {/* an agent's question pops up on whatever page is open (docs/questions.md) */}
      <QuestionModal />
      {/* service worker + notification taps + ?task=<id> deep links (docs/push.md) */}
      <PushBridge />
      {/* the one place a refused action is reported (docs/mobile.md § Action errors) */}
      <Toasts />
    </Layout>
  );
}

type OpenTaskSetter = (next: string | null | ((cur: string | null) => string | null)) => void;

/** history-state mark on an entry the panel pushed: closing it is Back */
const PANEL_PUSHED = 'tmTaskPanel';

/**
 * The open task panel IS the URL's `?task=<id>` (UX review #19, docs/design.md
 * § Task URLs), on whatever page the path names, so a task link can be shared
 * or bookmarked and browser Back closes the panel:
 * - opening from no panel PUSHES an entry (marked), so Back closes it;
 * - swapping tasks inside the panel REPLACES, so Back still closes rather
 *   than walking every task looked at;
 * - closing a pushed entry goes Back (Forward reopens it); closing one that
 *   arrived with the URL (a link, a push tap, a reload) replaces it away.
 * Leaving the page drops the param, so the panel closes with it; Back to
 * that entry brings it back.
 */
function useOpenTask(): [string | null, OpenTaskSetter] {
  const { search } = useLocation();
  const navigate = useNavigate();
  const openTask = new URLSearchParams(search).get('task') || null;
  const set = useCallback<OpenTaskSetter>(
    (next) => {
      // the live URL, not this render's: calls in one tick must compose
      const url = new URL(window.location.href);
      const cur = url.searchParams.get('task') || null;
      const id = typeof next === 'function' ? next(cur) : next;
      if (id === cur) return;
      const state = (window.history.state as { usr?: unknown } | null)?.usr;
      const pushed = !!state && typeof state === 'object' && (state as Record<string, unknown>)[PANEL_PUSHED] === true;
      if (id === null) {
        if (pushed) {
          navigate(-1);
          return;
        }
        url.searchParams.delete('task');
      } else url.searchParams.set('task', id);
      const to = { pathname: url.pathname, search: url.search, hash: url.hash };
      if (cur === null && id !== null) navigate(to, { state: { [PANEL_PUSHED]: true } });
      else navigate(to, { replace: true, state });
    },
    [navigate],
  );
  return [openTask, set];
}

/**
 * The app opens on the Board (docs/mobile.md § The shell). `/` is what the
 * installed Home Screen app launches and what every push URL points at
 * (`/?task=<id>`), so the redirect keeps the query and hash for PushBridge.
 */
function OpenOnBoard() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: '/board', search, hash }} replace />;
}
