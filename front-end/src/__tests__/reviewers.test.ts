import { describe, expect, it } from 'vitest';

import { ApplicationStatus, type Application, type Market } from '@/assets/types/datatypes';
import {
  inShareOf,
  assignedAddress,
  assignedTo,
  assignedToGroups,
  assignedToOptions,
  findsAssignedTo,
  dealtElsewhere,
  dealtWarning,
  myShare,
  reviewerLine,
  selectionDealtLine,
} from '@/utils/reviewers';
import { partsText, type AddressPart } from '@/utils/addressParts';
import { servedReview } from './support/servedReview';

/**
 * Whose share an application is, for the reader, and the warning on deciding someone else's
 * (E38/F07/S03): one utility, so the row, the card, the drawer and a selection say it alike.
 */
const SAM = 'sam@example.com';
const ANA = 'ana@example.com';
/** A reviewer removed from the team: what was dealt to them still carries their address. */
const CARL = 'carl@example.com';

const chosen: Pick<Market, 'reviewTeam'> = {
  reviewTeam: {
    reviewers: [
      { email: ANA, able: true },
      { email: SAM, able: true },
    ],
  },
};
const noneChosen: Pick<Market, 'reviewTeam'> = { reviewTeam: { reviewers: [] } };

/** An application as stored, with the review the server serves it (`served`). */
function application(
  status: ApplicationStatus,
  reviewer: string | null,
  served: ReturnType<typeof servedReview>,
  owner?: string,
): Pick<Application, 'status' | 'reviewer' | 'followUpOwner' | 'review'> {
  return {
    status,
    reviewer: reviewer ? { userId: 'u', email: reviewer } : null,
    followUpOwner: owner ? { userId: 'o', email: owner } : null,
    review: served.review,
  };
}

/** Open, dealt to a chosen reviewer: theirs. */
const openOf = (reviewer: string) =>
  application(ApplicationStatus.Open, reviewer, servedReview('open', { share: [reviewer] }));
/** Open, still carrying a removed reviewer's address: in nobody's share, waiting for the deal. */
const stranded = application(
  ApplicationStatus.Open,
  CARL,
  servedReview('open', { share: [], waiting: true }),
);

/** The reviewer line's words, as one string, as their accessible name reads; null when none. */
const line = (...args: Parameters<typeof reviewerLine>) => {
  const parts = reviewerLine(...args);
  return parts && partsText(parts);
};

/** The addresses among the parts, each cut at its "@" for `EmailAddress.vue` to draw. */
const addressesIn = (parts: AddressPart[] | null) =>
  (parts ?? []).filter((part) => part.kind === 'address');

describe('reviewerLine', () => {
  it('names the reviewer an application was dealt to', () => {
    expect(line(openOf(SAM), ANA, chosen)).toBe(`Reviewer: ${SAM}`);
  });

  it('says "not dealt yet" for one in nobody’s share, though it carries a removed reviewer', () => {
    expect(line(stranded, ANA, chosen)).toBe('Reviewer: not dealt yet');
    expect(addressesIn(reviewerLine(stranded, ANA, chosen))).toEqual([]);
  });

  it('names the chosen reviewer of a waiting follow-up still in their share', () => {
    // Its owner holds no role on the market any more, so it waits for the deal, but it is still
    // Ana's share, and every reader is warned it is dealt to her, so the line says so too.
    const ownerGone = application(
      ApplicationStatus.NeedsFollowUp,
      ANA,
      servedReview('follow_up', { share: [ANA], waiting: true }),
      CARL,
    );
    expect(line(ownerGone, SAM, chosen)).toBe(`Reviewer: ${ANA}`);
    expect(dealtElsewhere(ownerGone, SAM, chosen)).toBe(ANA);
    expect(line(ownerGone, ANA, chosen)).toBe('Reviewer: you');
  });

  it('names a chosen reviewer who can no longer review here: the share stays theirs', () => {
    const unable = {
      reviewTeam: {
        reviewers: [
          { email: ANA, able: false },
          { email: SAM, able: true },
        ],
      },
    };
    expect(line(openOf(ANA), SAM, unable)).toBe(`Reviewer: ${ANA}`);
  });

  it('hands the reviewer’s address over as a part of its own, cut at its "@"', () => {
    const hyphened = 'rv-sam-lee@example.com';
    expect(
      addressesIn(
        reviewerLine(openOf(hyphened), ANA, {
          reviewTeam: { reviewers: [{ email: hyphened, able: true }] },
        }),
      ),
    ).toEqual([{ kind: 'address', local: 'rv-sam-lee', domain: '@example.com' }]);
    expect(addressesIn(reviewerLine(openOf(SAM), SAM, chosen))).toEqual([]);
  });

  it('says "you" for the reader’s own, whatever the case of either address', () => {
    expect(line(openOf('Sam@Example.com'), SAM, chosen)).toBe('Reviewer: you');
  });

  it('names the reviewer of a decided application too: it stays the record of whose it was', () => {
    const approved = servedReview('approved', { share: [SAM] });
    expect(line(application(ApplicationStatus.ReviewerApproved, SAM, approved), ANA, chosen)).toBe(
      `Reviewer: ${SAM}`,
    );
  });

  it('says nothing for an application never dealt', () => {
    // With reviewers chosen an undealt one waits for the deal; with none, it is first come.
    expect(
      line(application(ApplicationStatus.Open, null, servedReview('open')), ANA, noneChosen),
    ).toBeNull();
  });

  it('says nothing with no reviewers chosen, even on one dealt before', () => {
    const dealtBefore = application(ApplicationStatus.Open, SAM, servedReview('open'));
    expect(line(dealtBefore, ANA, noneChosen)).toBeNull();
    expect(line(dealtBefore, ANA, null)).toBeNull();
  });
});

describe('dealtElsewhere', () => {
  it('answers whom an open application is dealt to, when that is someone else', () => {
    expect(dealtElsewhere(openOf(SAM), ANA, chosen)).toBe(SAM);
    // An old spelling of open, which the server serves as open.
    const stored = application(
      ApplicationStatus.UnderReview,
      SAM,
      servedReview('open', { share: [SAM] }),
    );
    expect(dealtElsewhere(stored, ANA, chosen)).toBe(SAM);
  });

  it('answers null for one in nobody’s share, though it carries a removed reviewer’s address', () => {
    expect(dealtElsewhere(stranded, ANA, chosen)).toBeNull();
  });

  it('answers a chosen reviewer who can no longer review here: it is still their share', () => {
    expect(dealtElsewhere(openOf(ANA), SAM, chosen)).toBe(ANA);
  });

  it('counts a follow-up as someone else’s too: it is not decided yet', () => {
    const followUp = application(
      ApplicationStatus.NeedsFollowUp,
      SAM,
      servedReview('follow_up', { share: [SAM] }),
      SAM,
    );
    expect(dealtElsewhere(followUp, ANA, chosen)).toBe(SAM);
  });

  it('answers null to the owner of a follow-up dealt to someone else: it is in their share too', () => {
    const owned = servedReview('follow_up', { share: [SAM, ANA] });
    expect(
      dealtElsewhere(
        application(ApplicationStatus.NeedsFollowUp, SAM, owned, 'ANA@example.com'),
        ANA,
        chosen,
      ),
    ).toBeNull();
    // Owning it is a follow-up's alone: an open application keeps no owner's share.
    const open = application(
      ApplicationStatus.Open,
      SAM,
      servedReview('open', { share: [SAM] }),
      ANA,
    );
    expect(dealtElsewhere(open, ANA, chosen)).toBe(SAM);
  });

  it('answers null for the reader’s own, compared in lower case', () => {
    expect(dealtElsewhere(openOf('SAM@example.com'), 'sam@EXAMPLE.com', chosen)).toBeNull();
  });

  it('answers null for a decided application: deciding it again is a change, not a share', () => {
    const approved = servedReview('approved', { share: [SAM] });
    const rejected = servedReview('rejected', { share: [SAM] });
    expect(
      dealtElsewhere(application(ApplicationStatus.ReviewerApproved, SAM, approved), ANA, chosen),
    ).toBeNull();
    expect(
      dealtElsewhere(application(ApplicationStatus.ReviewerRejected, SAM, rejected), ANA, chosen),
    ).toBeNull();
  });

  it('answers null for an application with no reviewer', () => {
    const undealt = application(
      ApplicationStatus.Open,
      null,
      servedReview('open', { waiting: true }),
    );
    expect(dealtElsewhere(undealt, ANA, chosen)).toBeNull();
  });

  it('answers null with no reviewers chosen: a follow-up keeps its reviewer, but nothing is dealt', () => {
    const kept = application(ApplicationStatus.NeedsFollowUp, SAM, servedReview('follow_up'), SAM);
    expect(dealtElsewhere(kept, ANA, noneChosen)).toBeNull();
  });
});

describe('the warning’s words', () => {
  it('names whose the application is, and what its history will say', () => {
    expect(partsText(dealtWarning(SAM))).toBe(
      `This application is dealt to ${SAM}. If you decide it, its history will say you decided it for them.`,
    );
    expect(addressesIn(dealtWarning('rv-sam-lee@example.com'))).toEqual([
      { kind: 'address', local: 'rv-sam-lee', domain: '@example.com' },
    ]);
  });

  it('counts the ticked rows dealt to others in a selection’s confirmation', () => {
    expect(selectionDealtLine(3)).toBe(
      '3 of them are dealt to other reviewers; their history will say you decided them.',
    );
    expect(selectionDealtLine(1)).toBe(
      '1 of them is dealt to another reviewer; its history will say you decided it.',
    );
  });

  it('says nothing when no ticked row is dealt to someone else', () => {
    expect(selectionDealtLine(0)).toBeNull();
  });
});

describe('the "Assigned to" filter (E38/F07/S04)', () => {
  const BEN = 'ben@example.com';

  it('offers Me to a chosen reviewer, then Anyone and each other reviewer by address', () => {
    expect(assignedToOptions(ANA, chosen)).toEqual([
      { value: 'me', label: 'Me' },
      { value: 'anyone', label: 'Anyone' },
      { value: SAM, label: SAM, address: true },
    ]);
  });

  it('offers Anyone and every reviewer to someone not chosen', () => {
    expect(assignedToOptions(BEN, chosen)).toEqual([
      { value: 'anyone', label: 'Anyone' },
      { value: ANA, label: ANA, address: true },
      { value: SAM, label: SAM, address: true },
    ]);
  });

  it('groups them for its picker: Me and Anyone with no name, the others as Reviewers', () => {
    expect(assignedToGroups(ANA, chosen)).toEqual([
      {
        options: [
          { value: 'me', label: 'Me' },
          { value: 'anyone', label: 'Anyone' },
        ],
      },
      { label: 'Reviewers', options: [{ value: SAM, label: SAM, address: true }] },
    ]);
    expect(assignedToGroups(ANA, noneChosen).flatMap((group) => group.options)).toEqual([]);
  });

  it('finds a reviewer by any part of the address, and Me by the reader’s own too', () => {
    const finds = findsAssignedTo(ANA);
    const me = { value: 'me', label: 'Me' };
    const anyone = { value: 'anyone', label: 'Anyone' };
    const sam = { value: SAM, label: SAM };

    expect(finds(sam, 'SAM@')).toBe(true);
    expect(finds(sam, 'ana')).toBe(false);
    expect(finds(anyone, 'any')).toBe(true);
    expect(finds(anyone, 'ana')).toBe(false);
    expect(finds(me, 'me')).toBe(true);
    expect(finds(me, 'ana@')).toBe(true);
  });

  it('is absent with no reviewers chosen', () => {
    expect(assignedToOptions(ANA, noneChosen)).toEqual([]);
    expect(assignedTo(undefined, ANA, noneChosen)).toBeNull();
    expect(assignedTo('anyone', ANA, noneChosen)).toBeNull();
    expect(assignedTo(SAM, ANA, null)).toBeNull();
  });

  it('opens on Me for a chosen reviewer and on Anyone for anyone else', () => {
    expect(assignedTo(undefined, ANA, chosen)).toBe('me');
    expect(assignedTo(undefined, 'Ana@Example.com', chosen)).toBe('me');
    expect(assignedTo(undefined, BEN, chosen)).toBe('anyone');
  });

  it('reads what the address names', () => {
    expect(assignedTo('anyone', ANA, chosen)).toBe('anyone');
    expect(assignedTo('me', ANA, chosen)).toBe('me');
    expect(assignedTo(SAM, ANA, chosen)).toBe(SAM);
    expect(assignedTo('Sam@Example.COM', BEN, chosen)).toBe(SAM);
  });

  it('reads the reader’s own address as Me', () => {
    expect(assignedTo(ANA, ANA, chosen)).toBe('me');
  });

  it('reads an address naming nobody chosen, or Me for someone not chosen, as the default', () => {
    expect(assignedTo(BEN, ANA, chosen)).toBe('me');
    expect(assignedTo('nonsense', BEN, chosen)).toBe('anyone');
    expect(assignedTo('me', BEN, chosen)).toBe('anyone');
    expect(assignedTo(['me'], ANA, chosen)).toBe('me');
  });

  it('narrows to the reader for Me, to nobody for Anyone, and to the reviewer named', () => {
    expect(assignedAddress('me', ANA)).toBe(ANA);
    expect(assignedAddress('anyone', ANA)).toBeNull();
    expect(assignedAddress(null, ANA)).toBeNull();
    expect(assignedAddress(SAM, ANA)).toBe(SAM);
  });
});

describe('myShare (E38/F07/S04)', () => {
  const followUp = (reviewer: string, owner: string) =>
    application(
      ApplicationStatus.NeedsFollowUp,
      reviewer,
      servedReview('follow_up', { share: [reviewer, owner] }),
      owner,
    );
  const queue = [
    { id: 'a', ...openOf(ANA) },
    { id: 'b', ...openOf(SAM) },
    { id: 'c', ...followUp(SAM, ANA) },
    { id: 'd', ...followUp(ANA, SAM) },
    { id: 'e', ...stranded },
    // A follow-up whose owner holds no role on the market any more: its reviewer's alone.
    {
      id: 'f',
      ...application(
        ApplicationStatus.NeedsFollowUp,
        SAM,
        servedReview('follow_up', { share: [SAM], waiting: true }),
        CARL,
      ),
    },
  ];
  const ids = (reader: string, market = chosen) => myShare(queue, reader, market).map((a) => a.id);

  it('holds what was dealt to the reader and the follow-ups they own, wherever dealt', () => {
    expect(ids(ANA)).toEqual(['a', 'c', 'd']);
    expect(ids(SAM)).toEqual(['b', 'c', 'd', 'f']);
  });

  it('is the server’s share: what waits for the deal is not the removed reviewer’s or owner’s', () => {
    expect(inShareOf(stranded, CARL)).toBe(false);
    expect(inShareOf(queue[5]!, CARL)).toBe(false);
    expect(inShareOf(queue[5]!, SAM)).toBe(true);
  });

  it('is empty for someone not chosen, and with nobody chosen', () => {
    expect(ids('cal@example.com')).toEqual([]);
    expect(ids(ANA, noneChosen)).toEqual([]);
  });
});
