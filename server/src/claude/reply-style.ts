// The ONE reply-style rule for every conversational surface (docs/chat.md
// § Reply style, docs/office.md § Group chat / § Huddles / § Channel).
//
// A dialogue reads like a human group chat: short and to the point. Long,
// structured answers stay allowed when they are the point. Documents —
// worker turns, review/plan/report/brief outputs, deliverables, stand-ups —
// never get this rule.
//
// Where it goes:
// - repo chat + office persona turns: the CLI's `--append-system-prompt`
//   (`AuxSpec.appendSystemPrompt`), so it is never echoed in the transcript
//   and, with the CLI's default `--system-prompt-snapshot on`, is recorded
//   with the conversation's first request and holds across `--resume`;
// - huddle turns: quoted in the turn's prompt block (`huddleTurnPlan`), since
//   a huddle turn is a shift whose final message carries a JSON result block;
// - channel messages: quoted in the `messages` section's description.

/** The rule itself. Keep it ONE text: every surface passes this constant. */
export const CONVERSATIONAL_REPLY_RULE = [
  'This is a chat. Answer like a person in a group chat: usually 1–3 sentences, no headings, no preamble, ' +
    'no restating the question, no closing offers or "let me know if…".',
  'Go long only when asked to explain something, describe a feature, plan or review, or when the answer needs code, ' +
    'a table or a list. Then use structure, but stay tight.',
  "Reply in the language of the user's message.",
].join(' ');
