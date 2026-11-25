/**
 * The All view of the review (E34/F04/S01): every application, filtered by status - follow-ups
 * included - and by "Mine", the follow-ups the viewer owns.
 */
import { describe, expect, it } from 'vitest';
import { ApplicationStatus, type Application } from '@/assets/types/datatypes';
import {
  ALL_VIEW_FILTERS,
  allViewApplications,
  allViewFilter,
  allViewLists,
  heldElsewhere,
  notSelectedLine,
  reviewView,
  selectAll,
} from '@/utils/reviewQueue';
import { statusLabel } from '@/utils/verdicts';
import { servedReview } from './support/servedReview';

/** An application as stored, with the review the server serves it (`served`). */
const app = (
  id: string,
  status: ApplicationStatus,
  served: ReturnType<typeof servedReview>,
  owner?: string,
): Application =>
  ({
    id,
    applicantEmail: `${id}@x.test`,
    status,
    submittedAt: '2026-05-01',
    formData: {},
    followUpOwner: owner ? { email: owner } : null,
    ...served,
  }) as Application;

const OPEN = servedReview('open');
const FOLLOW_UP = servedReview('follow_up');
const APPROVED = servedReview('approved');
const REJECTED = servedReview('rejected');

const APPS = [
  app('a', ApplicationStatus.Open, OPEN),
  app('b', ApplicationStatus.UnderReview, OPEN),
  app('c', ApplicationStatus.NeedsFollowUp, FOLLOW_UP, 'alex@market.test'),
  app('d', ApplicationStatus.NeedsFollowUp, FOLLOW_UP, 'sam@market.test'),
  app('e', ApplicationStatus.ReviewerApproved, APPROVED),
  app('f', ApplicationStatus.ReviewerRejected, REJECTED),
  // The old offers flow's statuses, which the server serves as the verdicts they carried.
  app('g', ApplicationStatus.Assigned, APPROVED),
  app('h', ApplicationStatus.Cancelled, REJECTED),
];

const ids = (filter: string, mine = false) =>
  allViewApplications(APPS, allViewFilter(filter), mine, 'alex@market.test').map((a) => a.id);

describe('the All view', () => {
  it('lists every application by default', () => {
    expect(ids('all')).toHaveLength(8);
  });

  it('filters by the served state, whatever the stored spelling', () => {
    expect(ids('undecided')).toEqual(['a', 'b']);
    expect(ids('needs_follow_up')).toEqual(['c', 'd']);
    expect(ids('reviewer_approved')).toEqual(['e', 'g']);
    expect(ids('reviewer_rejected')).toEqual(['f', 'h']);
  });

  it('narrows to the follow-ups the viewer owns with Mine', () => {
    expect(ids('all', true)).toEqual(['c']);
    expect(ids('needs_follow_up', true)).toEqual(['c']);
  });

  it('reads an unknown filter in the address as every application', () => {
    expect(allViewFilter('nonsense')).toBe('all');
    expect(ALL_VIEW_FILTERS.map((f) => f.id)).toContain('needs_follow_up');
  });
});

describe('which view the review opens on (E38/F05/S01)', () => {
  it('opens on All with no view in the address', () => {
    expect(reviewView({})).toBe('all');
    expect(reviewView({ status: 'undecided' })).toBe('all');
  });

  it('keeps saved links to All working', () => {
    expect(reviewView({ view: 'all' })).toBe('all');
  });

  it('opens One by one by its own value', () => {
    expect(reviewView({ view: 'one' })).toBe('one');
  });

  it('opens One by one at a named application, as the Assignment tab links to it', () => {
    expect(reviewView({ application: 'app-7' })).toBe('one');
    expect(reviewView({ application: 'app-7', view: 'all' })).toBe('all');
  });

  it('calls the undecided status Open, as the status itself does, under its old address', () => {
    expect(ALL_VIEW_FILTERS.map((f) => f.label)).toEqual([
      'Any status',
      'Open',
      'Needs follow-up',
      'Approved',
      'Rejected',
    ]);
    expect(ALL_VIEW_FILTERS[1].id).toBe('undecided');
    expect(ALL_VIEW_FILTERS[1].label).toBe(statusLabel(ApplicationStatus.Open));
  });
});

describe('Select all (E38/F05/S02)', () => {
  const held = (
    id: string,
    status: ApplicationStatus,
    served: ReturnType<typeof servedReview>,
    holder: string,
  ): Application => ({ ...app(id, status, served), heldBy: { email: holder } }) as Application;
  const ROWS = [
    app('a', ApplicationStatus.Open, OPEN),
    held('b', ApplicationStatus.Open, OPEN, 'sam@market.test'),
    held('c', ApplicationStatus.UnderReview, OPEN, 'Alex@Market.test'),
    app('d', ApplicationStatus.ReviewerApproved, APPROVED),
  ];

  it('ticks every row the filter shows, and nothing it hides', () => {
    const shown = allViewApplications(ROWS, 'undecided', false, 'alex@market.test');
    expect(selectAll(shown, 'alex@market.test').ids).toEqual(['a', 'c']);
  });

  it('skips the rows another reviewer has open, and counts them', () => {
    expect(selectAll(ROWS, 'alex@market.test')).toEqual({
      ids: ['a', 'c', 'd'],
      held: 1,
      decided: 0,
    });
  });

  it('skips the rows already approved or rejected for someone who may not change a verdict (E38/F06/S01)', () => {
    expect(selectAll(ROWS, 'alex@market.test', false)).toEqual({
      ids: ['a', 'c'],
      held: 1,
      decided: 1,
    });
    // A row held elsewhere is said once, as held, whatever its verdict; an old offers status is
    // the verdict it carried.
    expect(selectAll([app('g', ApplicationStatus.Assigned, APPROVED)], 'alex', false)).toEqual({
      ids: [],
      held: 0,
      decided: 1,
    });
    const heldAndDecided = held(
      'e',
      ApplicationStatus.ReviewerRejected,
      REJECTED,
      'sam@market.test',
    );
    expect(selectAll([heldAndDecided], 'alex@market.test', false)).toEqual({
      ids: [],
      held: 1,
      decided: 0,
    });
  });

  it("reads a row the viewer has open as theirs, whatever the address's case", () => {
    expect(heldElsewhere(ROWS[2], 'alex@market.test')).toBeNull();
    expect(heldElsewhere(ROWS[1], 'alex@market.test')).toBe('sam@market.test');
    expect(heldElsewhere(ROWS[0], 'alex@market.test')).toBeNull();
  });
});

describe('what Select all left out, in words (E38/F05/S02, E38/F06/S01)', () => {
  const WHO = 'an Admin or the owner';

  it('says nothing when it left nothing out', () => {
    expect(notSelectedLine(0, 0, WHO)).toBeNull();
  });

  it('says the rows another reviewer has open', () => {
    expect(notSelectedLine(1, 0, WHO)).toBe(
      '1 application not selected: another reviewer has it open.',
    );
    expect(notSelectedLine(2, 0, WHO)).toBe(
      '2 applications not selected: another reviewer has them open.',
    );
  });

  it('says the rows already decided, and who may change them', () => {
    expect(notSelectedLine(0, 1, WHO)).toBe(
      '1 application not selected: it already has a verdict, which only an Admin or the owner may change.',
    );
    expect(notSelectedLine(0, 3, null)).toBe(
      '3 applications not selected: they already have a verdict, which you may not change.',
    );
  });

  it('says both, each in its own clause', () => {
    expect(notSelectedLine(1, 2, WHO)).toBe(
      '3 applications not selected: another reviewer has 1 open, and 2 already have a verdict, which only an Admin or the owner may change.',
    );
  });
});

describe('the All view narrowed to a reviewer’s share (E38/F07/S04)', () => {
  const ALEX = 'alex@market.test';
  const SAM = 'sam@market.test';
  /** Dealt to `reviewer`, in the share the server serves (`share`). */
  const dealt = (
    id: string,
    status: ApplicationStatus,
    served: ReturnType<typeof servedReview>,
    reviewer: string | null,
    owner?: string,
  ): Application => ({
    ...app(id, status, served, owner),
    reviewer: reviewer ? { userId: reviewer, email: reviewer } : null,
  });
  const SHARES = [
    dealt('a', ApplicationStatus.Open, servedReview('open', { share: [ALEX] }), ALEX),
    dealt('b', ApplicationStatus.Open, servedReview('open', { share: [SAM] }), 'Sam@Market.test'),
    dealt(
      'c',
      ApplicationStatus.NeedsFollowUp,
      servedReview('follow_up', { share: [ALEX] }),
      ALEX,
      ALEX,
    ),
    dealt(
      'd',
      ApplicationStatus.NeedsFollowUp,
      servedReview('follow_up', { share: [SAM, ALEX] }),
      SAM,
      ALEX,
    ),
    dealt(
      'e',
      ApplicationStatus.ReviewerApproved,
      servedReview('approved', { share: [ALEX] }),
      ALEX,
    ),
    dealt('f', ApplicationStatus.ReviewerRejected, REJECTED, null),
    // Dealt to Ben, since removed from the team: in nobody's share until the next deal.
    dealt('w', ApplicationStatus.Open, servedReview('open', { waiting: true }), 'ben@market.test'),
  ];
  const shareIds = (reviewer: string | null, filter = 'all', mine = false) =>
    allViewApplications(SHARES, allViewFilter(filter), mine, 'alex@market.test', reviewer).map(
      (a) => a.id,
    );

  it('lists only the applications dealt to the reviewer named, decided ones included', () => {
    expect(shareIds('sam@market.test')).toEqual(['b', 'd']);
  });

  it('counts a follow-up the reviewer named owns in their share, whoever reads it', () => {
    const owned = [
      ...SHARES,
      dealt(
        'g',
        ApplicationStatus.NeedsFollowUp,
        servedReview('follow_up', { share: [ALEX, SAM] }),
        ALEX,
        SAM,
      ),
    ];
    const ids = (reviewer: string) =>
      allViewApplications(owned, allViewFilter('all'), false, 'alex@market.test', reviewer).map(
        (a) => a.id,
      );
    // Alex reads Sam's share: Sam's follow-up on Alex's share is in both.
    expect(ids('sam@market.test')).toEqual(['b', 'd', 'g']);
    expect(ids('alex@market.test')).toEqual(['a', 'c', 'd', 'e', 'g']);
  });

  it('counts a follow-up the reader owns in their own share, whoever it was dealt to', () => {
    expect(shareIds('alex@market.test')).toEqual(['a', 'c', 'd', 'e']);
    expect(shareIds('ALEX@market.test ')).toEqual(['a', 'c', 'd', 'e']);
  });

  it('lists every application for nobody named, those never dealt included', () => {
    expect(shareIds(null)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'w']);
  });

  it('narrows together with the status filter and Mine', () => {
    expect(shareIds('alex@market.test', 'undecided')).toEqual(['a']);
    expect(shareIds('sam@market.test', 'needs_follow_up')).toEqual(['d']);
    expect(shareIds('alex@market.test', 'all', true)).toEqual(['c', 'd']);
    expect(shareIds('sam@market.test', 'all', true)).toEqual(['d']);
  });

  it('lists nothing for a reviewer dealt nothing, nor one removed with work still on their name', () => {
    expect(shareIds('ben@market.test')).toEqual([]);
    expect(shareIds('cal@market.test')).toEqual([]);
  });

  it('leaves the Stats tab’s test by the served state alone', () => {
    expect(allViewLists.length).toBe(2);
    expect(allViewLists('undecided', 'open')).toBe(true);
    expect(allViewLists('undecided', 'follow_up')).toBe(false);
  });
});
