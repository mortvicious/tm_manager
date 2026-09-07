# Questions — an agent asks the human

A worker sometimes reaches a decision that is not its to make: which of two
architectures, what an ambiguous requirement means, whether a destructive step
is wanted. In a terminal, Claude Code asks with its `AskUserQuestion` tool — a
dialog with a header, a question and two to four options — and waits. A Task
Manager worker runs in a **hidden** PTY, so until now that tool was withheld
(`WORKER_TOOLS` in `server/src/claude/worker.ts`): nobody would have seen the
dialog, and the run would have sat on it forever.

This feature carries the same tool to where the human actually is: a modal on
whatever dashboard page is open, and a Telegram message with the options as
buttons. The agent's session waits, the first answer from either surface wins,
and the tool receives it as if it had been picked in the terminal.

## How it works

```
worker (hidden PTY)                      API                         human
─────────────────────                    ───                         ─────
AskUserQuestion(questions)
  └─ PreToolUse hook (shell loop)
       POST /api/internal/runs/:id/question?waitMs=60000
       body = the hook's stdin (tool_use_id, tool_input)
                                        ─ tm_questions row (pending)
                                        ─ event question.asked
                                        ─ WS question.updated ──────▶ SPA modal pops
                                        ─ Telegram: 1 msg / question ▶ phone buttons
       ← { pending: true, id }  (60s)
       POST again (same body, idempotent on tool_use_id) …
                                        ◀── POST /api/questions/:id/answer   (SPA)
                                        ◀── q: button press / free text     (phone)
                                        ─ conditional pending→answered
                                        ─ WS + event question.answered
       ← { hookSpecificOutput: { permissionDecision: "allow",
             updatedInput: { questions, answers } } }
  └─ tool runs with `answers` filled in — no dialog is drawn
agent continues
```

- **The hook is the carrier.** `buildWorkerInvocation` injects a `PreToolUse`
  hook with `matcher: "AskUserQuestion"` into the same `--settings` JSON as the
  Stop/Notification hooks. Unlike those (fire-and-forget, `>/dev/null || true`),
  this one's **stdout is the tool decision**, so nothing is discarded. The
  command is a `sh` loop: read stdin once, POST it, and re-POST the same body
  every time the server answers `{ pending: true }`; print and exit the moment
  the reply carries `hookSpecificOutput`. The hook's own `timeout` is raised to
  seven days (the CLI default is 600s) — the human is the slow part on purpose.
- **Why `allow` + `updatedInput`, not a deny with the answer in the reason.**
  In the CLI, `AskUserQuestion`'s permission check returns *ask* with the
  questions as `updatedInput`, and the dialog's job is to fill `answers` into
  that input; the tool's `call` then reads `{ questions, answers }`. A hook
  that returns `allow` with the original `questions` plus `answers` (keyed by
  question text; a multi-select joins labels with `", "`) satisfies that
  interaction, so the tool completes normally and the model sees a normal tool
  result. Verified end to end against CLI 2.1.257 (§ Verification).
- **Idempotent on `tool_use_id`, which is therefore required.** The loop
  re-sends its body every minute; the service finds the existing row for the
  run + tool_use_id instead of filing a second question, a unique index on
  `(run_id, tool_use_id)` makes that hold even when two re-sends overlap
  (curl's 75s timeout racing a slow server — the insert that loses re-reads
  the winner), and a body without the id is refused with 400 rather than
  paging the human once a minute. A re-send after the answer landed gets the
  decision at once. The questions array is stored and handed back
  **verbatim** — validated for shape and size, never trimmed or rebuilt — so
  the tool receives exactly the input the CLI validated, unknown fields
  included.
- **Unreachable server → deny, never silence.** Five consecutive failed
  attempts — a curl error, or a reply that is neither a decision nor
  `pending` (403, 400, 500, an error page) — print `ASK_UNREACHABLE`: a deny
  whose reason tells the agent to decide for itself and state the assumption.
  Exiting 0 with no output would let the tool run and draw its dialog in a
  terminal nobody watches — the deadlock this feature exists to remove. A
  `pending` reply resets the count, so the human has no deadline. The ONE
  silent exit is the route's `run is not working` 409: the session is idle, so
  the caller is a human typing into an attached terminal after the turn ended
  — the one place the CLI's own dialog works, and the hook lets it draw it.
  `case` patterns in the loop carry no quotes on purpose: inside a pattern a
  `"` quotes rather than matches (review round 1 caught `*"pending":true*`
  never matching, which force-denied every question after five minutes).
- **Two surfaces, one service.** `QuestionService` (`server/src/questions.ts`)
  is called in-process by the internal route, the human route
  (`routes/questions.ts`, actor `human`) and the Telegram press handler
  (`telegram/questions.ts`, actor `telegram`). The write is the storage
  composite `answerQuestion` — `UPDATE … WHERE status = 'pending' RETURNING *` —
  so a question can be answered exactly once; the loser gets 409 / "Already
  answered (telegram)" and, on the phone, a notice when the browser won. The
  human route refuses a POST without an `Origin` header (403): browsers always
  send one, curl never does, and a worker that knows `$TM_CALLBACK_URL` must
  not be able to answer its own question and have the audit call it `human`.

## Storage

`tm_questions` (migration 23), FK-less like `tm_dispatches`: `id`, `task_id`,
`run_id`, `tool_use_id`, `status` (`pending|answered|expired`), `questions`
(JSON — the CLI's own array, kept verbatim so it can be handed back),
`answers` (JSON, keyed by question text), `answered_by`, `note` (why it
expired), `created_at`, `answered_at`. Both drivers run the same `?` SQL.

Every step is a `tm_events` row: `question.asked` (actor `hook`),
`question.answered` (actor `human` / `telegram`, with the answers),
`question.expired` (with the note).

## Expiry — nobody is left answering into the void

A pending question is only worth anything while the hook that asked it is
alive. Every path that ends that wait expires the row (`expired`, with a note),
broadcasts it (the modal closes, the chip disappears, the phone is told) and
tells the hook — a waiting hook gets a deny with the note:

| path | where | note |
|---|---|---|
| PTY exit — normal, killed, cancelled, crashed | `Orchestrator.handleExit`, next to `forgetAttention` | the agent session ended |
| Stop hook while a question is still pending (Esc in an attached terminal cancels the waiting hook and the turn goes on) | `POST /api/internal/runs/:id/stop` | the agent finished its turn without the answer |
| server restart — no hook survives it | `recoverOnBoot`, before the pid sweep | the server restarted |

Answering an expired question is refused (409) — the agent already moved on.

## Surfaces

**SPA.** `QuestionModal` is mounted once in `App.tsx`, so it pops on any page.
It shows the oldest pending question: the task title, an `asks you` badge, each
question with its header, options as cards (radio or checkbox for
`multiSelect`), an **Other** card that opens a free-text line (the CLI offers
the same), and one **Answer** button that is enabled only when every question
has an answer. Closing dismisses that question for the session; the header
chip (`❓ n questions`, pulsing) reopens it, and the task panel shows the same
form inline under "The agent is asking you". The Board renders `asks you` in
place of the status badge while a question is pending — a synthetic badge on
top of `running`, like `needs attention`; deliberately no new `TaskStatus`.
The state slice `questions` is the PENDING set: a `question.updated` frame that
is not pending removes the row.

**Telegram.** One message per question (a keyboard belongs to one message),
the first headed with the task title: options numbered with descriptions, a
button per option, `✔ Done` for multi-select, `✍️ Other…` always. A tap on a
single-select question answers that part; on a multi-select it toggles (the
message is re-rendered with ✓ marks) and `Done` commits. `Other…` starts a
`question` flow (`flows.ts`) whose next free-text message is the answer — refused
with a note while a different wizard (`/new`, `/edit`) is half-finished, since a
notification button can land mid-wizard. When
every part has an answer the service is called; otherwise the reply says what
was noted and re-sends the next unanswered part with its keyboard. Buttons are
a `q:` namespace (`q:<question id>:<part>:<option | o | d>`, 45 bytes) parsed
in `bot.ts` BEFORE the stateless action codec, like `w:`/`k:`/`c:`, because a
question expires within hours and a stale button must be refused with the
outcome (44 bytes with a uuid). `/questions` lists everything pending with the keyboards again. The
ping is neither coalesced nor gated by the notify flags: an agent is blocked
on it, and it is not the chatter `/mute` exists for.

## Prompts

The standing rules and the resume reminder (`worker.ts`, `docs/worker-prompt.md`)
gained one rule, worded as a threshold rather than an invitation: ask when a
choice would **materially change the outcome** — architecture or library,
ambiguous or conflicting requirement, destructive or irreversible step, scope
that could go two ways — and decide small things yourself, never asking about
those. The served instruction sheet (`docs/agent-instructions.md`) says the
same in one line, because a decision is not something to file a task or a
dispatch for.

## Deliberately not

- **No new `TaskStatus`.** The task stays `running`; the question is its own
  row with its own status, rendered as a synthetic badge. Every claim, resume
  and queue rule keeps working unchanged.
- **No `needs_attention` flag.** That flag means "a dialog is drawn in the
  hidden terminal" and clears when the transcript moves on; a question has no
  transcript activity until it is answered, so it would never clear. It has
  its own lifecycle instead.
- **No timeout on the human.** The agent waits until someone answers or the run
  ends. A question the human never sees is the run they will find waiting,
  with a pulsing chip, not a silently self-answered one.
- **Not a PTY write.** Typing the answer into the terminal would depend on the
  dialog's exact key handling and would be invisible to the phone. The hook
  contract is what the CLI documents for tool input.
- **Chats (`docs/chat.md`) are untouched.** A chat turn is `claude -p`, which
  has no AskUserQuestion.

## Verification

- Service + routes + Telegram handlers against a scratch SQLite file with
  Fastify `inject` (a throwaway script, not checked in): 403 on a wrong token;
  400 on malformed questions; ask → `{pending, id}`; the same `tool_use_id`
  re-sent → same id, one row; answering with a missing part → 400; a full
  answer while a hook waits → the hook returns within 2s with `allow` and the
  exact `answers` (and the original option descriptions); no `Origin` → 403;
  a second answer → 409; a re-send after the answer → the decision, no new
  row; a body without `tool_use_id` → 400 and nothing filed; two overlapping
  first sends → one row; the original question objects come back verbatim
  (unknown fields, a long header) and an oversized one is refused; expiry while a
  hook waits → `deny` carrying the note, later answer → 409; an idle run → 409;
  the WS sequence `pending, answered, pending, expired` and the matching audit
  kinds; button codec round-trips under 64 bytes; single-select press notes
  the part and re-renders the next; `Done` with nothing picked refused;
  toggle+toggle+Done submits `"Cache, Search"` as `telegram`; a stale press
  answers "Already answered"; `Other…` sets the flow and the free text
  submits trimmed; boot sweep expires everything pending.
- The hook shell loop, run with `/bin/sh -c` on the exact string
  `buildWorkerInvocation` emits, against stub servers: pending, pending,
  decision → stdout is byte-exact the decision and the body (with `%`, `$`,
  quotes) was forwarded unchanged on every re-send; **six** pendings then a
  decision → the decision (the counter never trips on pending); 403 ×5 →
  `ASK_UNREACHABLE` after exactly five calls; an HTML 500 page → the same;
  nothing listening → the same; a `run is not working` 409 → exit 0 with no
  output after one call.
- A real `claude` 2.1.257 session under node-pty (haiku, `--tools=AskUserQuestion`
  only) with the injected settings and a stub that answers "Beta": the hook
  fired with the tool's `questions`, no dialog was drawn, and the model printed
  `ANSWER=Beta`.
- `npm run typecheck`, `npm run build`.

## Adversarial review round 1 (2026-09-07)

Blocker: the hook's `case` pattern `*"pending":true*` never matched (quotes
inside a pattern quote, they do not match), so every pending reply counted as
a failure and every question was force-denied after five minutes while its row,
modal, chip and phone keyboard lived on. Fixed with unquoted patterns and a
six-pending stub test that would have caught it. Majors, fixed: `tool_use_id`
was optional, so a body without it filed a new row every minute — now 400, plus
a unique `(run_id, tool_use_id)` index and a re-read on the losing insert; the
failure counter double-counted transport errors (deny after 3, not 5) — one
increment per attempt; the idle-run 409 read as "unreachable" — now a silent
exit so the CLI draws its own dialog for a human at an attached terminal.
Minors, fixed: a worker could curl its own question shut as `human` (Origin
required); `parseQuestions` rebuilt and truncated the objects it handed back
(now verbatim, oversized refused); a dead clamp in the route; a Telegram toast
over 200 chars; `Other…` silently dropping a live `/new`; the re-rendered next
part losing the task title; Escape closing the modal from inside the textarea
and the slide-over beneath it; options picked by label (duplicates collided);
px literals in the new CSS; a dead filter. Knowingly left: `answered_at` also
stamps expiry (a rename is a migration for a nit).
