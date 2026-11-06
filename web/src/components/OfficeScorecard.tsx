// The office scorecard panel on /office (docs/office.md § Scorecard): office
// and per-role figures over 7 or 30 days from GET /api/offices/:id/scorecard
// (server-cached 10 min, so this reads once per open/period switch).

import { useEffect, useState } from 'react';
import { OFFICE_SCORECARD_DAYS, scorecardSkipsLine, type Office, type OfficeScoreFigures, type OfficeScorecardResponse } from '@tm/shared';
import { api } from '../api.ts';

const usd = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);

function interventionsTitle(f: OfficeScoreFigures): string {
  const i = f.interventions;
  return `${i.transitions} moves · ${i.answers} answers · ${i.approvals} approvals · ${i.rejections} rejections · ${i.taintClears} taint clears`;
}

export function OfficeScorecard({ office }: { office: Office }) {
  const [days, setDays] = useState<number>(OFFICE_SCORECARD_DAYS[0]);
  const [card, setCard] = useState<OfficeScorecardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .officeScorecard(office.id, days)
      .then((c) => live && setCard(c))
      .catch((e: unknown) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [office.id, days]);

  const shown = card && card.days === days ? card : null;
  const f = shown?.office;
  return (
    <div className="office-scorecard">
      <div className="office-section-title office-scorecard-head">
        <span>Scorecard</span>
        <div className="rm-seg" role="radiogroup" aria-label="Scorecard period">
          {OFFICE_SCORECARD_DAYS.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {error && <div className="warn-text office-pad">{error}</div>}
      {!f && !error && <div className="muted office-pad">Loading…</div>}
      {f && shown && (
        <>
          <dl className="office-scorecard-figures office-pad">
            <div>
              <dt>Landed</dt>
              <dd>{f.landed}</dd>
            </div>
            <div>
              <dt>Bugs found / fixed</dt>
              <dd>
                {f.bugsFound} / {f.bugsFixed}
              </dd>
            </div>
            <div>
              <dt>Proposals ✓ / ✗</dt>
              <dd>
                {f.proposalsAccepted} / {f.proposalsRejected}
              </dd>
            </div>
            <div>
              <dt>Spent</dt>
              <dd>{usd(f.spentUsd)}</dd>
            </div>
            <div>
              <dt>$ per landed</dt>
              <dd>{usd(f.usdPerLanded)}</dd>
            </div>
            <div title={interventionsTitle(f)}>
              <dt>Human interventions</dt>
              <dd>{f.interventions.total}</dd>
            </div>
            <div title={scorecardSkipsLine(f.skips)}>
              <dt>Skipped shifts</dt>
              <dd>{f.skipsTotal}</dd>
            </div>
            <div>
              <dt>Ratings</dt>
              <dd>
                👍{f.ratings.up} 👎{f.ratings.down}
              </dd>
            </div>
          </dl>
          <div className="office-pad office-help muted">
            Interventions: {interventionsTitle(f)}. Skips: {scorecardSkipsLine(f.skips)}.
          </div>
          {shown.roles.length > 0 && (
            <div className="office-scorecard-table-wrap">
              <table className="office-scorecard-table">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Landed</th>
                    <th>Bugs</th>
                    <th>Proposals</th>
                    <th>Spent</th>
                    <th>$/landed</th>
                    <th>Interventions</th>
                    <th>Skips</th>
                    <th>👍 / 👎</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.roles.map((r) => (
                    <tr key={r.roleId}>
                      <th scope="row">{r.name}</th>
                      <td>{r.landed}</td>
                      <td>
                        {r.bugsFound} / {r.bugsFixed}
                      </td>
                      <td>
                        {r.proposalsAccepted} / {r.proposalsRejected}
                      </td>
                      <td>{usd(r.spentUsd)}</td>
                      <td>{usd(r.usdPerLanded)}</td>
                      <td title={interventionsTitle(r)}>{r.interventions.total}</td>
                      <td title={scorecardSkipsLine(r.skips)}>{r.skipsTotal}</td>
                      <td>
                        {r.ratings.up} / {r.ratings.down}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="office-pad office-hint muted">Computed {new Date(shown.computedAt).toLocaleString()} · refreshed at most every 10 minutes</div>
        </>
      )}
    </div>
  );
}
