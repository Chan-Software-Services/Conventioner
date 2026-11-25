/**
 * Who applied, as the Stats tab counts it (E45/F01/S01): the server's counts by served review state,
 * read as the Applications tab's All view filters, each a part of the review's split bar. When they
 * applied is drawn over time by `appliedOverTime.ts`, tested beside it.
 */
import { describe, expect, it } from 'vitest';
import { ApplicationStatus, type Application } from '@/assets/types/datatypes';
import { applicantStats, type ApplicantCounts } from '@/utils/applicantStats';
import { ALL_VIEW_FILTERS, allViewApplications } from '@/utils/reviewQueue';
import { servedReview } from './support/servedReview';

let next = 0;
function app(
  status: ApplicationStatus,
  served: ReturnType<typeof servedReview>,
  submittedAt?: string,
  added = false,
): Application {
  next += 1;
  return {
    ...served,
    id: `app-${next}`,
    marketId: 'm1',
    applicantEmail: `vendor${next}@example.com`,
    formData: {},
    status,
    applicationType: 'main',
    submittedAt,
    updatedAt: '2026-09-10T12:00:00',
    ...(added ? { addedBy: { email: 'alex@market.test' }, addedAt: '2026-11-18T09:00:00' } : {}),
  } as Application;
}

/** What the server sends for these applications (`back-end/market_stats.py#count_applicants`). */
function counted(applications: Application[]): ApplicantCounts {
  const states = { open: 0, follow_up: 0, approved: 0, rejected: 0 };
  for (const a of applications) states[a.review.state] += 1;
  const applied = applications.filter((a) => !a.addedBy);
  return {
    total: applications.length,
    addedByHand: applications.length - applied.length,
    states,
    submittedAt: applied.flatMap((a) => (a.submittedAt ? [a.submittedAt] : [])),
    openedAt: null,
    closedAt: null,
  };
}

// Local times, so the day each falls on is the same wherever the suite runs.
const APPS = [
  app(ApplicationStatus.Open, servedReview('open'), '2026-09-01T09:00:00'),
  app(ApplicationStatus.UnderReview, servedReview('open'), '2026-09-01T23:30:00'),
  app(ApplicationStatus.NeedsFollowUp, servedReview('follow_up'), '2026-09-03T10:00:00'),
  app(ApplicationStatus.ReviewerApproved, servedReview('approved'), '2026-09-03T11:00:00'),
  app(ApplicationStatus.ReviewerApproved, servedReview('approved'), '2026-09-03T12:00:00'),
  app(ApplicationStatus.ReviewerRejected, servedReview('rejected'), '2026-09-02T08:00:00'),
  app(
    ApplicationStatus.ReviewerApproved,
    servedReview('approved', { origin: 'added' }),
    '2026-11-18T09:00:00',
    true,
  ),
];

describe('who applied', () => {
  const stats = applicantStats(counted(APPS), 'm1');
  const row = (label: string) => stats.byStatus.find((r) => r.label === label)!;

  it('counts every application, and those added by hand apart', () => {
    expect(stats.total).toBe(7);
    expect(stats.addedByHand).toBe(1);
    expect(stats.applied).toBe(6);
  });

  it("counts each state as the Applications tab's All view filters it", () => {
    expect(stats.byStatus.map((r) => [r.label, r.count])).toEqual([
      ['Open', 2],
      ['Needs follow-up', 1],
      ['Approved', 3],
      ['Rejected', 1],
    ]);
    // The same filter, so the two pages can never disagree.
    for (const filter of ALL_VIEW_FILTERS.filter((f) => f.id !== 'all')) {
      const counted = stats.byStatus.find((r) => r.value === filter.id)!;
      expect(counted.count).toBe(allViewApplications(APPS, filter.id, false, '').length);
    }
  });

  it('opens the All view on that filter from each status, on every reviewer’s share', () => {
    // The count is everyone's, so a chosen reviewer is not landed on their own share (E38/F07/S04).
    expect(row('Needs follow-up').to).toEqual({
      path: '/markets/m1/applications',
      query: { view: 'all', status: 'needs_follow_up', reviewer: 'anyone' },
    });
    expect(row('Open').to).toEqual({
      path: '/markets/m1/applications',
      query: { view: 'all', status: 'undecided', reviewer: 'anyone' },
    });
  });

  it("fills each status in its own colour, in the All view's order", () => {
    expect(stats.byStatus.map((r) => [r.label, r.fill])).toEqual([
      ['Open', '--mm-blue'],
      ['Needs follow-up', '--mm-chart-yellow'],
      ['Approved', '--mm-green'],
      ['Rejected', '--mm-red'],
    ]);
  });

  it('counts a status the review no longer gives under the filter the server reads it as', () => {
    // `cancelled` is served as rejected, `assignment_sent` as approved: no grey "other" part.
    const old = [
      app(ApplicationStatus.Cancelled, servedReview('rejected'), '2026-09-04T10:00:00'),
      app(ApplicationStatus.AssignmentSent, servedReview('approved'), '2026-09-04T11:00:00'),
    ];
    const stats = applicantStats(counted([...APPS, ...old]), 'm1');
    expect(stats.byStatus.map((r) => [r.label, r.count])).toEqual([
      ['Open', 2],
      ['Needs follow-up', 1],
      ['Approved', 4],
      ['Rejected', 2],
    ]);
    expect(stats.byStatus.every((r) => r.to)).toBe(true);
    expect(stats.byStatus.reduce((sum, r) => sum + r.count, 0)).toBe(stats.total);
  });

  it('is nothing for a market nobody has applied to', () => {
    const none = applicantStats(counted([]), 'm1');
    expect(none.total).toBe(0);
    expect(none.byStatus.every((r) => r.count === 0)).toBe(true);
  });
});
