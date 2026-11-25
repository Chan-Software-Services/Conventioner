/**
 * Every verdict says who gave it (E34/F01/S01): "Approved by alex@market.test", with when. An
 * application decided before verdicts recorded their giver says nothing about one.
 */
import { describe, expect, it } from 'vitest';
import { ApplicationStatus } from '@/assets/types/datatypes';
import { statusChip, statusLabel, verdictGiverLine } from '@/utils/verdicts';
import { servedReview } from './support/servedReview';

const ALEX = { kind: 'person' as const, userId: 'user-alex', email: 'alex@market.test' };

describe('who gave a verdict', () => {
  it('names the person and the moment', () => {
    const line = verdictGiverLine({
      status: ApplicationStatus.ReviewerApproved,
      ...servedReview('approved'),
      verdictBy: ALEX,
      verdictAt: '2026-10-19T17:04:00Z',
    });

    // In the viewer's own time zone, so the day itself is theirs.
    expect(line).toMatch(/^Approved by alex@market\.test, Oct \d+, 2026 at \d/);
  });

  it('says a rejection is the reviewer’s too', () => {
    expect(
      verdictGiverLine({
        status: ApplicationStatus.ReviewerRejected,
        ...servedReview('rejected'),
        verdictBy: ALEX,
      }),
    ).toBe('Rejected by alex@market.test');
  });

  it('says nothing of a giver nobody recorded', () => {
    expect(
      verdictGiverLine({ status: ApplicationStatus.ReviewerApproved, ...servedReview('approved') }),
    ).toBeNull();
    expect(
      verdictGiverLine({
        status: ApplicationStatus.ReviewerApproved,
        ...servedReview('approved'),
        verdictBy: null,
      }),
    ).toBeNull();
  });

  it('says nothing of a giver while the server reads it as undecided, though one is kept', () => {
    // Who marked a follow-up is kept as its giver, and an old spelling of open reads as open.
    expect(
      verdictGiverLine({
        status: ApplicationStatus.NeedsFollowUp,
        ...servedReview('follow_up'),
        verdictBy: ALEX,
      }),
    ).toBeNull();
  });

  it('names the giver of a verdict the old offers flow carried on, as the verdict it was', () => {
    expect(
      verdictGiverLine({
        status: ApplicationStatus.Cancelled,
        ...servedReview('rejected'),
        verdictBy: ALEX,
      }),
    ).toBe('Cancelled by alex@market.test');
  });

  it('says a rule rejected it, and why (E33/F03/S02)', () => {
    expect(
      verdictGiverLine({
        status: ApplicationStatus.ReviewerRejected,
        ...servedReview('rejected'),
        verdictBy: { kind: 'rule', rule: 'no_shows' },
        verdictReason: 'Did not tick “I understand that no-shows”',
      }),
    ).toBe('Rejected automatically: Did not tick “I understand that no-shows”');
  });
});

describe('what a status reads', () => {
  it('reads an old under_review row as Open, in the open tone, as the Open filter lists it', () => {
    expect(statusLabel(ApplicationStatus.UnderReview)).toBe('Open');
    expect(statusChip(ApplicationStatus.UnderReview)).toBe(statusChip(ApplicationStatus.Open));
    expect(statusChip(ApplicationStatus.UnderReview)).toBe('chip chip--informational');
  });

  it('writes every label in sentence case', () => {
    expect(statusLabel(ApplicationStatus.AssignmentSent)).toBe('Assignment sent');
    for (const status of Object.values(ApplicationStatus)) {
      const [first, ...rest] = statusLabel(status).split(' ');
      expect(
        rest.every((word) => word === word.toLowerCase()),
        statusLabel(status),
      ).toBe(true);
      expect(first[0]).toBe(first[0].toUpperCase());
    }
  });
});
