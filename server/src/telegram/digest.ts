/**
 * The daily digest (docs/telegram.md § Reports): the 24h report `/report`
 * builds, pushed unasked once a day at a configurable local hour.
 *
 * The whole difficulty is deciding, for one calendar day, whether its slot is
 * still owed — and the machine is a MacBook, so it sleeps, restarts, and has
 * its settings changed from a phone mid-day (docs/future/telegram-bot.md § The
 * Mac as a server). That decision rests on TWO facts, kept apart on purpose
 * because they answer different questions and change at different times:
 *
 * - **`sentOn`** — the last local day a digest actually WENT OUT. It advances
 *   only on a successful send, so a restart cannot re-send and a Telegram
 *   outage cannot lose the day.
 * - **`armedAt`** — the instant the CURRENT (`enabled`, `hour`) pairing became
 *   active. A slot only counts if the digest was already armed with that hour
 *   when the slot arrived.
 *
 * One combined "day marker" was tried first and is the wrong shape: its
 * meaning depends on the hour in force when it was written, so re-timing the
 * digest silently skipped or double-fired a day. `armedAt` has no such
 * dependency — it is a timestamp, compared against whichever slot is being
 * judged.
 *
 * What that buys, case by case:
 *
 * - `/digest on 21` at 14:00 → armed 14:00, tonight's slot is 21:00, and
 *   14:00 is before it: **sends tonight**, which is what the reply promises.
 * - `/digest on 9` at 22:00 → armed 22:00, today's slot was 09:00 and is
 *   already gone: **waits for tomorrow**, rather than firing a minute later
 *   for a day the owner watched happen.
 * - `/digest on 9` at 10:00 while it was set to 21:00 → same rule, same
 *   answer: today's 09:00 is behind us, so tomorrow.
 * - Re-timed to 21:00 at 10:00 *after* a 09:00 send → `sentOn` is already
 *   today, so **no second digest in one day**.
 * - Mac asleep through 09:00, wakes at 14:00 → armed days ago, slot reached,
 *   day unsent: **catches up at 14:00** instead of skipping silently.
 * - Restarted at 10:00 having sent at 09:00 → `sentOn` says today: silent.
 *   `armedAt` is persisted too, so a restart does not re-arm and thereby
 *   cancel a catch-up it should have made.
 */
import type { TelegramDigestConfig } from '../config.ts';
import type { Storage } from '../storage/types.ts';
import { buildReport, type ReportDocument } from './report.ts';

/** One minute: the hour boundary is the only thing being watched. */
const TICK_MS = 60_000;

export interface DigestDeps {
  storage: Storage;
  /** Live config object — `/digest on|off` mutates it in place. */
  digest: TelegramDigestConfig;
  send(doc: ReportDocument): Promise<void>;
  /** Audit + log the send; failures here must not stop tomorrow's. */
  onSent(day: string): Promise<void>;
  onError(err: unknown): void;
}

/**
 * What `/digest` needs from the scheduler: re-arm on a change, and answer
 * "when is the next one" truthfully. Narrow on purpose — the command has no
 * business starting or stopping anything.
 */
export interface DigestControl {
  rearm(now?: Date): Promise<void>;
  nextRun(now?: Date): 'today' | 'tomorrow';
}

export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The instant of `now`'s own day at `hour`. An instant, not an hour number,
 * because it is compared against `armedAt` — "was the digest armed before this
 * slot arrived" is a question about points in time, not about clock readings.
 */
export function slotInstant(now: Date, hour: number): Date {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export class DigestScheduler implements DigestControl {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** last day a digest actually went out; '' = never */
  private sentOn = '';
  /** ISO instant the current (enabled, hour) pairing became active */
  private armedAt = '';
  /** what the config said last time it was looked at, to notice a change */
  private seen: { enabled: boolean; hour: number } | null = null;
  private busy = false;

  constructor(private readonly deps: DigestDeps) {}

  async start(now = new Date()): Promise<void> {
    const settings = await this.deps.storage.getSettings().catch(() => null);
    this.sentOn = settings?.['telegram.digestSentOn'] ?? '';
    this.armedAt = settings?.['telegram.digestArmedAt'] ?? '';
    // Seeded from the config as it is, so the first tick does not read this as
    // a change and re-arm — which would move `armedAt` to boot time on every
    // restart and quietly cancel any catch-up that was owed.
    this.seen = { enabled: this.deps.digest.enabled, hour: this.deps.digest.hour };
    if (!this.armedAt) {
      // Never armed: arming happens now. Today's slot therefore counts only if
      // it is still ahead — booting at 07:00 with `hour: 23` still sends
      // tonight, booting at 22:00 with `hour: 9` does not fire for this
      // morning.
      this.armedAt = now.toISOString();
      await this.deps.storage.setSetting('telegram.digestArmedAt', this.armedAt).catch(() => {});
    }
    this.timer = setInterval(() => void this.tick().catch((e) => this.deps.onError(e)), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The last day a digest actually went out; '' when none ever has. */
  get lastSentDay(): string {
    return this.sentOn;
  }

  get armedAtIso(): string {
    return this.armedAt;
  }

  /**
   * The (`enabled`, `hour`) pairing changed: from here on, only slots that
   * arrive AFTER this instant count. `/digest` calls it the moment it mutates
   * the config so the effect is immediate; the tick calls it too, so a change
   * that did not come through the command (a hand-edited file) is still
   * noticed rather than silently ignored.
   */
  async rearm(now = new Date()): Promise<void> {
    this.seen = { enabled: this.deps.digest.enabled, hour: this.deps.digest.hour };
    this.armedAt = now.toISOString();
    await this.deps.storage.setSetting('telegram.digestArmedAt', this.armedAt).catch(() => {});
  }

  /**
   * Whether the next digest is due today or tomorrow — the answer `/digest`
   * prints. It reads the SAME state `tick()` decides on, rather than comparing
   * the clock to the hour: "lands at 21:00, next one today" has to still be
   * true when 21:00 comes.
   */
  nextRun(now = new Date()): 'today' | 'tomorrow' {
    return this.dueToday(now) ? 'today' : 'tomorrow';
  }

  /** Is today's slot still owed — reached or not. */
  private dueToday(now: Date): boolean {
    if (!this.deps.digest.enabled) return false;
    if (localDay(now) === this.sentOn) return false;
    const slot = slotInstant(now, this.deps.digest.hour);
    // Armed after the slot: the digest was off, or set to another hour, when
    // this one went by. It is not owed.
    return !(this.armedAt && new Date(this.armedAt) > slot);
  }

  async tick(now = new Date()): Promise<void> {
    if (this.busy) return;
    const { enabled, hour } = this.deps.digest;
    if (!this.seen || this.seen.enabled !== enabled || this.seen.hour !== hour) await this.rearm(now);
    if (!enabled) return;
    if (!this.dueToday(now)) return;
    // Owed, but the hour may not have come round yet.
    if (now < slotInstant(now, hour)) return;

    this.busy = true;
    try {
      const doc = await buildReport(this.deps.storage, { kind: 'period', hours: 24 });
      await this.deps.send(doc);
      // Recorded only AFTER a successful send, so a Telegram outage at 09:00
      // retries at 09:01 rather than losing the day. `send` throws on failure
      // for exactly this reason.
      const day = localDay(now);
      this.sentOn = day;
      await this.deps.storage.setSetting('telegram.digestSentOn', day);
      await this.deps.onSent(day);
    } finally {
      this.busy = false;
    }
  }
}
