// The /office "Rate the work" panel (docs/office.md § Ratings): the office's
// newest proposals (every status) and role-tagged tasks, each with 👍/👎. A
// rating becomes one line in the role's feedback file, which its next shift reads.
import { useEffect, useState } from 'react';
import type { Office, OfficeProposal, OfficeRating, OfficeRole } from '@tm/shared';
import { api } from '../api.ts';
import { onServerEvent, useApp } from '../state.tsx';
import { RatingButtons, ratingKey } from './OfficeRating.tsx';

const LIMIT = 20;

function useOfficeProposalsOf(officeId: string): OfficeProposal[] | null {
  const [list, setList] = useState<OfficeProposal[] | null>(null);
  useEffect(() => {
    let live = true;
    setList(null);
    api.listOfficeProposalsOf(officeId, LIMIT).then(
      (l) => live && setList(l),
      () => live && setList([]),
    );
    const off = onServerEvent((e) => {
      if (e.type !== 'office-proposal.updated' || e.proposal.officeId !== officeId) return;
      setList((cur) => {
        const l = cur ?? [];
        return l.some((p) => p.id === e.proposal.id) ? l.map((p) => (p.id === e.proposal.id ? e.proposal : p)) : [e.proposal, ...l].slice(0, LIMIT);
      });
    });
    return () => {
      live = false;
      off();
    };
  }, [officeId]);
  return list;
}

export function OfficeWork({
  office,
  roles,
  ratings,
  inSheet,
  onOpenTask,
}: {
  office: Office;
  roles: OfficeRole[];
  ratings: Map<string, OfficeRating>;
  inSheet: boolean;
  onOpenTask: (id: string) => void;
}) {
  const { tasks } = useApp();
  const proposals = useOfficeProposalsOf(office.id);
  const roleTasks = tasks
    .filter((t) => t.officeId === office.id && t.roleId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, LIMIT);
  const who = (roleId: string | null) => {
    const r = roles.find((x) => x.id === roleId);
    return r ? `${r.avatar} ${r.name}` : 'deleted role';
  };
  return (
    <div className="office-work">
      {!inSheet && <div className="office-section-title">Rate the work</div>}
      <div className="muted office-pad office-hint">
        👍/👎 goes into the role’s feedback file — its next shift reads it. Briefs are rated in the brief viewer.
      </div>
      <div className="office-work-head">Proposals</div>
      {proposals === null && <div className="muted office-pad">Loading…</div>}
      {proposals?.length === 0 && <div className="muted office-pad">No proposals yet.</div>}
      {proposals?.map((p) => (
        <div key={p.id} className="office-work-row">
          <span className="office-shift-role">{who(p.roleId)}</span>
          <span className="chip">{p.status}</span>
          {p.taintedAt && <span className="chip office-taint">untrusted</span>}
          <span className="office-work-title">{p.title}</span>
          <RatingButtons kind="proposal" id={p.id} rating={ratings.get(ratingKey('proposal', p.id))} />
        </div>
      ))}
      <div className="office-work-head">Tasks</div>
      {roleTasks.length === 0 && <div className="muted office-pad">No role tasks yet.</div>}
      {roleTasks.map((t) => (
        <div key={t.id} className="office-work-row">
          <span className="office-shift-role">{who(t.roleId)}</span>
          <span className="chip">{t.status}</span>
          {t.taintedAt && <span className="chip office-taint">untrusted</span>}
          <button type="button" className="btn ghost office-work-title" onClick={() => onOpenTask(t.id)}>
            {t.title}
          </button>
          <RatingButtons kind="task" id={t.id} rating={ratings.get(ratingKey('task', t.id))} />
        </div>
      ))}
    </div>
  );
}
