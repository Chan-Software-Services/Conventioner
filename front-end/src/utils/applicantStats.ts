/**
 * Who applied, as the Stats tab counts it (E45/F01/S01): every application by its review state, as
 * the parts of the review's split bar (T201).
 *
 * Read from the server's counts (`GET /markets/:id/stats`, `back-end/market_stats.py`), so the
 * page never downloads the applications to count them: every application by the review state the
 * server serves (`states`), how many were added by hand, and the time each of the others applied.
 * The states are counted into the Applications tab's All view filters through the All view's own
 * test (`allViewLists`), so the two pages can never disagree: a part's count is what its filter
 * lists, and its legend line opens it, on every reviewer's share (E38/F07/S04). Every state is one
 * filter's, so the parts add up to every application. A vendor added by hand never applied, so
 * they are counted apart, while their state is the approval the adding gave them, as the All view
 * shows it. When the others applied is drawn over time by `appliedOverTime.ts`.
 */
import type { ReviewState } from '@/assets/types/datatypes';
import { marketPath } from '@/utils/market';
import type { IntakeTimes } from '@/utils/appliedOverTime';
import { ALL_VIEW_FILTERS, allViewLists, type AllViewFilter } from '@/utils/reviewQueue';
import type { SplitPart } from '@/utils/splitBar';

/** Who applied, as the server counts them. */
export interface ApplicantCounts extends IntakeTimes {
  /** Every application, those added by hand among them. */
  total: number;
  addedByHand: number;
  /** Every application by its served review state, each of the four. */
  states: Record<ReviewState, number>;
}

export interface ApplicantStats {
  /** Every application, those added by hand among them. */
  total: number;
  /** Those who applied, on the market's page or in an imported form. */
  applied: number;
  addedByHand: number;
  /** By the All view's filters, in its order, the parts of the review's split bar. */
  byStatus: SplitPart[];
}

/** Each filter's fill; Needs follow-up the chart's yellow, as the button's is under 3:1 on white. */
const FILLS: Record<Exclude<AllViewFilter, 'all'>, string> = {
  undecided: '--mm-blue',
  needs_follow_up: '--mm-chart-yellow',
  reviewer_approved: '--mm-green',
  reviewer_rejected: '--mm-red',
};
export function applicantStats(counts: ApplicantCounts, marketId: string): ApplicantStats {
  const { total, addedByHand } = counts;
  const states = Object.entries(counts.states) as [ReviewState, number][];
  const filters = ALL_VIEW_FILTERS.filter((filter) => filter.id !== 'all');
  const byStatus: SplitPart[] = filters.map((filter) => ({
    label: filter.label,
    value: filter.id,
    fill: FILLS[filter.id],
    count: states
      .filter(([state]) => allViewLists(filter.id, state))
      .reduce((sum, [, count]) => sum + count, 0),
    // On every reviewer's share, which the count is, not the one a chosen reviewer lands on.
    to: {
      path: marketPath(marketId, 'applications'),
      query: { view: 'all', status: filter.id, reviewer: 'anyone' },
    },
  }));

  return { total, applied: total - addedByHand, addedByHand, byStatus };
}
