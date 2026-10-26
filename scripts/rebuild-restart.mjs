/**
 * Rebuild & restart from a terminal (docs/host.md § Rebuild & restart):
 *
 *   npm run rebuild:restart [-- --force] [-- --no-typecheck] [-- --drain [--drain-minutes=30]]
 *
 * `--drain` (docs/host.md § Drain, front door only): pause new work WITHOUT
 * suspending anything, wait for live turns to finish (up to --drain-minutes,
 * default 30), restart, then Continue — only if the pause was the job's own.
 * On the deadline it releases its pause and fails `drain_timeout`; with
 * `--force` it suspends the rest (Pause all) and forces the restart instead.
 * Ctrl-C while draining cancels the drain.
 *
 * With a front door running it is a client of `POST /host/rebuild-restart` and
 * follows the job to its end — the same job, guard and result as the header
 * button. Without one (or with one that predates the route) it runs the SAME
 * steps itself from server/src/rebuild.ts and restarts the API through the
 * API's own restart route. Run under tsx (the npm script does), because the
 * steps are TypeScript shared with the front door. Exit 0 = done, 1 = refused
 * or failed.
 */
import { loadBootConfig } from '../server/src/config.ts';
import { buildSpa, swapDist, typecheck } from '../server/src/rebuild.ts';

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const check = !args.has('--no-typecheck');
const drain = args.has('--drain');
const minutesArg = process.argv.slice(2).find((a) => a.startsWith('--drain-minutes='));
const drainMinutes = minutesArg ? Number(minutesArg.split('=')[1]) : undefined;
const cfg = loadBootConfig();
const HOST = `http://127.0.0.1:${cfg.host.port}`;
const API = `http://127.0.0.1:${cfg.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { status: 0, body: { error: e.message } };
  }
}

function fail(msg, tail) {
  console.error(`✗ ${msg}`);
  if (tail) console.error(`\n--- last lines ---\n${tail}`);
  process.exit(1);
}

function report(job) {
  if (job.hostStale) {
    console.log('⚠ server/src/host.ts changed since the front door booted — restart `npm start` to load it.');
  }
  if (job.state === 'failed') fail(`${job.reason ? `[${job.reason}] ` : ''}${job.error}`, job.logTail);
  console.log(`✓ done${job.buildId ? ` — build ${job.buildId}` : ''}${job.bootedAfter ? `, API booted ${job.bootedAfter}` : ''}`);
  if (job.drain) {
    console.log(
      job.continued
        ? '✓ Continue pressed (the pause was the job’s)'
        : job.error
          ? `⚠ ${job.error}`
          : '⏸ left paused — the pause was yours before the job started; press Continue',
    );
  }
  process.exit(0);
}

// ------------------------------------------------- through the front door

const probe = await get(`${HOST}/host/rebuild-restart`);
if (probe?.status === 200 && probe.body?.state) {
  const r = await post(`${HOST}/host/rebuild-restart`, { force, typecheck: check, drain, drainMinutes });
  if (r.status !== 202) fail(`${r.body?.reason ? `[${r.body.reason}] ` : ''}${r.body?.error ?? `HTTP ${r.status}`}`);
  console.log(`front door on :${cfg.host.port} is running the job${drain ? ' (drain mode)' : ''}`);
  // Ctrl-C while draining: cancel the drain (the job releases its own pause);
  // past the drain the job is minutes from its end and is left to finish.
  let state = r.body?.rebuild?.state;
  process.on('SIGINT', async () => {
    if (state !== 'draining') process.exit(130);
    console.log('\n… cancelling the drain');
    await post(`${HOST}/host/rebuild-restart/cancel`, {});
  });
  let last = '';
  let lastStuck = '';
  for (;;) {
    await sleep(1000);
    const j = await get(`${HOST}/host/rebuild-restart`);
    if (!j?.body) continue; // a blip; the front door outlives the API restart
    const job = j.body;
    state = job.state;
    if (job.step && job.step !== last) console.log(`… ${(last = job.step)}`);
    // The sessions a pause does not end (chats, reports, plans): named once
    // per change, so a drain never hangs silently on them.
    const stuck = (job.waitingFor?.notPauseAware ?? []).join('\n  ');
    if (job.state === 'draining' && stuck && stuck !== lastStuck) {
      console.log(`⚠ the pause does not stop these — finish or stop them, or the drain times out:\n  ${(lastStuck = stuck)}`);
    }
    if (job.state === 'done' || job.state === 'failed') report(job);
    if (job.state === 'idle') fail('the front door restarted mid-job and lost it — check its terminal');
  }
}
if (drain) {
  fail('--drain needs the front door (npm start / npm run dev) — it runs the job and outlives the restart');
}
if (probe) {
  console.log(`front door on :${cfg.host.port} predates /host/rebuild-restart — running the steps here`);
}

// ------------------------------------------------------------ standalone

const dev = process.env.TM_DEV === '1';
const health = async () => (await get(`${API}/api/health`))?.body ?? null;

const guard = (await get(`${API}/api/server/restart-check`))?.body;
if (guard?.blocked && !force) fail(`[not_quiet] ${guard.error}`);

if (!dev) {
  console.log('… Building the web app…');
  const b = await buildSpa();
  if (!b.ok) fail(`${b.error} — nothing was restarted; the current page is still served`, b.tail);
  swapDist();
  console.log(`  web/dist is now build ${b.buildId ?? '(no id)'}`);
}
if (check) {
  console.log('… Typechecking…');
  const t = await typecheck();
  if (!t.ok) fail(`${t.error} — the API was NOT restarted`, t.tail);
}

const before = await health();
if (!before?.ok) {
  console.log('✓ built — no API is running, so there was nothing to restart (`npm start` starts both).');
  process.exit(0);
}
const again = (await get(`${API}/api/server/restart-check`))?.body;
if (again?.blocked && !force) fail(`[not_quiet] ${again.error} The API was NOT restarted.`);

console.log('… Restarting the API…');
// Supervised (an older front door): the API exits and its supervisor respawns
// it. Unsupervised (`npm run start:api`): it detaches its own replacement.
const r = await post(`${API}/api/server/restart`, { force });
if (r.status !== 200) fail(`[restart] ${r.body?.error ?? `HTTP ${r.status}`}`);
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  await sleep(500);
  const h = await health();
  if (h?.ok && h.bootedAt && h.bootedAt !== before.bootedAt) report({ state: 'done', bootedAfter: h.bootedAt });
}
fail('[timeout] the API did not come back within 60 s — check its terminal output (a broken server file is the usual cause)');
