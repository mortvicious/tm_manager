// When a plan review sends the plan back to the planner (server/src/claude/feature-analysis.ts).
// Run: npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PlanReviewRound } from '@tm/shared';
import { mustFix, needsReplan } from './claude/feature-analysis.ts';

const round = (verdict: PlanReviewRound['verdict'], ...severities: ('blocker' | 'major' | 'minor')[]): PlanReviewRound => ({
  round: 1,
  verdict,
  findings: severities.map((severity, i) => ({ severity, summary: `${severity} ${i}`, detail: null })),
  model: 'm',
  at: '2026-11-04T00:00:00Z',
});

describe('plan review → re-plan', () => {
  test('a "minor" verdict over major findings still re-plans (feature 0e323bef round 2)', () => {
    const r = round('minor', 'major', 'major', 'minor');
    assert.equal(needsReplan(r), true);
    assert.deepEqual(mustFix(r).map((f) => f.severity), ['major', 'major']);
  });
  test('minors alone do not', () => {
    assert.equal(needsReplan(round('minor', 'minor', 'minor')), false);
    assert.equal(needsReplan(round('clean')), false);
  });
  test('a blocker verdict re-plans even with only minor findings, and hands them all over', () => {
    const r = round('blocker', 'minor');
    assert.equal(needsReplan(r), true);
    assert.equal(mustFix(r).length, 1);
  });
});
