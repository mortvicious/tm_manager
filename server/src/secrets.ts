// Credential-shaped strings in text a human typed (docs/questions.md § Secrets).
//
// A heuristic, and deliberately a greedy one: it runs only over answers the
// agent has ALREADY received, so a false positive (a commit sha, a long hash)
// costs nothing but a redacted audit line, while a miss leaves a live
// credential in tm_questions / tm_events forever.

/** Vendor prefixes that mark a token as a credential on sight. */
const PREFIXED = [
  /\bsntry[su]_[A-Za-z0-9+/=_-]{16,}/g, // Sentry org (sntrys_) and user (sntryu_) auth tokens
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic (sk-ant-…, sk-proj-…)
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret / restricted
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys (Maps etc.)
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // JWT (Supabase keys are JWTs)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/**
 * A long opaque token: ≥ 32 chars with an UNBROKEN run of ≥ 24 alphanumerics
 * (a slug or a UUID breaks on its hyphens) that is either letters AND digits
 * or letters in random mixed case, with a Shannon entropy a word never reaches.
 */
const TOKEN = /[A-Za-z0-9_+=.\-]{32,}/g;
const RUN = /[A-Za-z0-9+=]{24,}/g;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function opaque(token: string): boolean {
  for (const run of token.match(RUN) ?? []) {
    const letters = run.replace(/[^A-Za-z]/g, '');
    if (letters.length === 0) continue;
    if (/[0-9]/.test(run)) {
      if (entropy(run) >= 3.5) return true;
      continue;
    }
    // Letters only: random mixed case flips case about every other char,
    // CamelCase words carry one capital per word (~15%), SCREAMING_CASE 100%.
    const upper = letters.replace(/[^A-Z]/g, '').length / letters.length;
    if (upper >= 0.25 && upper <= 0.75 && entropy(run) >= 4) return true;
  }
  return false;
}

const marker = (n: number) => `[redacted secret, ${n} chars]`;
const MARKER_RE = /^\[redacted secret, \d+ chars\]$/;

/** Every credential-shaped substring replaced by a marker. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PREFIXED) out = out.replace(re, (m) => marker(m.length));
  return out.replace(TOKEN, (m) => (opaque(m) ? marker(m.length) : m));
}

export function looksSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}

/** An answers map with every value through `redactSecrets`; `changed` says whether anything was hit. */
export function redactAnswers(answers: Record<string, string>): { answers: Record<string, string>; changed: boolean } {
  const out: Record<string, string> = {};
  let changed = false;
  for (const [k, v] of Object.entries(answers)) {
    const r = typeof v === 'string' ? redactSecrets(v) : v;
    if (r !== v) changed = true;
    out[k] = r;
  }
  return { answers: out, changed };
}

export const isRedactionMarker = (s: string) => MARKER_RE.test(s);
