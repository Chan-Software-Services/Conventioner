import {
  ApplicationStatus,
  type Application,
  type ApplicationForm,
  type ReviewState,
} from '@/assets/types/datatypes';
import {
  applicationAnswerRows,
  businessName,
  FULL_NAME_KEY,
  PREFERRED_NAME_KEY,
  type AnswerRow,
} from '@/utils/essentialFields';
import { inShareOf } from '@/utils/reviewers';
import { isDecided } from '@/utils/verdicts';

/**
 * Everything an application says, as a reviewer reads it.
 *
 * This exists because the review queue showed an email address, a status pill and two buttons -
 * so an organizer was asked to accept or refuse 232 people with nothing to decide on (E08/F04).
 * Triage answers that by showing the whole application, one at a time.
 *
 * The answers the market MARKED come first (E19/F03/S01).
 *
 * This used to put the organizer's own questions first and the essential answers after, reasoning
 * that custom questions "are what distinguish applicants from each other". That was a heuristic
 * standing in for exactly this mark, and it was wrong in both directions: a custom "how did you
 * hear about us?" is noise on a triage card, and an essential availability answer can be the whole
 * decision. Now the market says which, and within each group the previous order is unchanged - so
 * nothing else moves at the same time.
 *
 * The rendering itself belongs to the contract being rendered, so it lives in `essentialFields.ts`
 * and the applicant's own dashboard reads the same answers back.
 */
export function reviewAnswers(
  application: Pick<Application, 'formData'>,
  form?: ApplicationForm | null,
  highlights: string[] = [],
): { leading: AnswerRow[]; rest: AnswerRow[] } {
  const { essential, custom } = applicationAnswerRows(
    (application.formData ?? {}) as Record<string, unknown>,
    form?.fields ?? [],
  );
  const all = [...custom, ...essential];
  if (!highlights.length) return { leading: [], rest: all };

  const marked = new Set(highlights);
  return {
    // In the order the market marked them: that order is what a reviewer reads down.
    leading: highlights.flatMap((key) => all.filter((row) => row.key === key)),
    rest: all.filter((row) => !marked.has(row.key)),
  };
}

/**
 * Whether this market's form asks anything that tells one applicant from another.
 *
 * When it does not, every triage card is identical and the only rational act is pressing Approve
 * over and over. Saying so beats letting the reviewer discover it at card forty. The form freezes
 * when a market leaves draft, so the fix - reopening for editing and adding a question - is a thing
 * the organizer can still do while nobody has applied (E03/F04).
 *
 * This is NOT the "does this market have a form?" question: a market whose form asks only the
 * essential questions has a form, and a valid one. See `asked_essential_keys()` in
 * `back-end/essential_fields.py` for that one.
 */
export function asksNothingDistinguishing(form?: ApplicationForm | null): boolean {
  return (form?.fields ?? []).length === 0;
}

/**
 * Applications in the order they arrived, earliest first (E30/F01/S05).
 *
 * The server lists them newest first, so the deck's "1 of 16" was the last to arrive. First come is
 * the order an organizer decides in, and the one a first-come rule assigns in. One with no time
 * goes last, and those it cannot tell apart keep the order they came in.
 */
export function inArrivalOrder<T extends Pick<Application, 'submittedAt'>>(apps: T[]): T[] {
  const time = (app: T) => (app.submittedAt ? Date.parse(app.submittedAt) : NaN);
  return apps
    .map((app, index) => ({ app, index, at: time(app) }))
    .sort((x, y) => {
      const xKnown = !Number.isNaN(x.at);
      const yKnown = !Number.isNaN(y.at);
      if (xKnown !== yKnown) return xKnown ? -1 : 1;
      return (xKnown && x.at !== y.at ? x.at - y.at : 0) || x.index - y.index;
    })
    .map(({ app }) => app);
}

/** Waiting on its applicant, with someone reaching out (E34/F02/S01), as the server reads it. */
export function followUps(applications: Application[]): Application[] {
  return inArrivalOrder(applications.filter((a) => a.review.state === 'follow_up'));
}

/**
 * What the one-by-one review walks: the open ones in the order they arrived, and the follow-ups
 * after them only when the reviewer asks (E34/F02/S01) - a follow-up waits on its applicant, so it
 * is not the next thing to decide. Each by the state the server serves (ADR 0037), so an old
 * spelling of open is walked as open.
 */
export function reviewQueue(applications: Application[], includeFollowUps: boolean): Application[] {
  const open = inArrivalOrder(applications.filter((a) => a.review.state === 'open'));
  return includeFollowUps ? [...open, ...followUps(applications)] : open;
}

/**
 * The word One by one counts a stretch of the queue in, from what it holds: "open", as the Open
 * filter lists them, "needing a follow-up" for follow-ups alone, and both for a stretch of both, so
 * a follow-up taken into the walk is never called open.
 */
export function queueCountWord(queue: Pick<Application, 'review'>[]): string {
  const following = queue.some((a) => a.review.state === 'follow_up');
  const open = queue.some((a) => a.review.state !== 'follow_up');
  if (!following) return 'open';
  return open ? 'open or needing a follow-up' : 'needing a follow-up';
}

/**
 * Reviewed: everything the queue is done with, newest verdict first - every application the server
 * reads as decided (`review.undecided` false), so one the old offers flow carried on to another
 * status still reads as the verdict it carried.
 */
export function reviewed<T extends Pick<Application, 'review' | 'verdictAt' | 'submittedAt'>>(
  applications: T[],
): T[] {
  return newestVerdictFirst(applications.filter((a) => !a.review.undecided));
}

/**
 * Newest verdict first (E38/F10/S01): the reviewed list in arrival order put the verdict just given
 * at the bottom of a closed list, so the way back from a slip was the hardest one to find. Those with
 * no verdict time (an application carried on by the market, or decided before the time was kept)
 * go last, in the order they arrived.
 */
export function newestVerdictFirst<T extends Pick<Application, 'verdictAt' | 'submittedAt'>>(
  apps: T[],
): T[] {
  const time = (app: T) => (app.verdictAt ? Date.parse(app.verdictAt) : NaN);
  const timed = apps.filter((app) => !Number.isNaN(time(app)));
  const untimed = apps.filter((app) => Number.isNaN(time(app)));
  return [...timed.sort((x, y) => time(y) - time(x)), ...inArrivalOrder(untimed)];
}

/**
 * The review's two views (E34/F04/S01), All first and the default (E38/F05/S01): an address with no
 * `view` opens All, and One by one is `view=one` - or a named application with no `view`, which is a
 * link to one card (bug 42).
 */
export type ReviewView = 'all' | 'one';

export function reviewView(query: Record<string, unknown>): ReviewView {
  if (query.view === 'one') return 'one';
  return !query.view && query.application ? 'one' : 'all';
}

/**
 * The All view's status filters (E34/F04/S01), as the address names them. The undecided read
 * "Open", the status an undecided application shows (E38/F05/S01); its address is still `undecided`.
 */
export const ALL_VIEW_FILTERS = [
  { id: 'all', label: 'Any status' },
  { id: 'undecided', label: 'Open' },
  { id: ApplicationStatus.NeedsFollowUp, label: 'Needs follow-up' },
  { id: ApplicationStatus.ReviewerApproved, label: 'Approved' },
  { id: ApplicationStatus.ReviewerRejected, label: 'Rejected' },
] as const;

export type AllViewFilter = (typeof ALL_VIEW_FILTERS)[number]['id'];

/** The filter an address names, or every application for one it does not know. */
export function allViewFilter(asked: unknown): AllViewFilter {
  return ALL_VIEW_FILTERS.some((f) => f.id === asked) ? (asked as AllViewFilter) : 'all';
}

/** The served state each filter but "Any status" lists; the filters' ids stay the addresses. */
const LISTS: Record<Exclude<AllViewFilter, 'all'>, ReviewState> = {
  undecided: 'open',
  [ApplicationStatus.NeedsFollowUp]: 'follow_up',
  [ApplicationStatus.ReviewerApproved]: 'approved',
  [ApplicationStatus.ReviewerRejected]: 'rejected',
};

/**
 * Whether the All view lists an application in this served state (`review.state`) under this
 * filter: a filter is decided by the state alone, so the Stats tab can count the filters from the
 * server's counts by state.
 */
export function allViewLists(filter: AllViewFilter, state: ReviewState): boolean {
  return filter === 'all' || LISTS[filter] === state;
}

/**
 * The applications the All view lists: those in the state asked for - "Open" is every one
 * awaiting a verdict - with Mine, only the follow-ups the viewer owns, and with a reviewer named
 * (E38/F07/S04), only that reviewer's share (`inShareOf`: the server's share, dealt to them,
 * decided ones included, and the follow-ups they own, whoever they were dealt to).
 */
export function allViewApplications(
  applications: Application[],
  filter: AllViewFilter,
  mine: boolean,
  me: string,
  reviewer: string | null = null,
): Application[] {
  const viewer = me.trim().toLowerCase();
  return inArrivalOrder(
    applications.filter(
      (a) =>
        allViewLists(filter, a.review.state) &&
        (!mine ||
          (a.review.state === 'follow_up' &&
            (a.followUpOwner?.email ?? '').toLowerCase() === viewer)) &&
        (!reviewer || inShareOf(a, reviewer)),
    ),
  );
}

/**
 * Whether the All view's find field finds this application (T223): by its address, by either of
 * its names, the legal one as well as the one its row calls them, or by its business name (T502),
 * capitals aside.
 */
export function findsApplication(
  application: Pick<Application, 'applicantEmail' | 'formData'>,
  words: string,
): boolean {
  const needle = words.toLowerCase();
  const answers = (application.formData ?? {}) as Record<string, unknown>;
  return [
    application.applicantEmail,
    answers[FULL_NAME_KEY],
    answers[PREFERRED_NAME_KEY],
    businessName(answers),
  ].some((text) =>
    String(text ?? '')
      .toLowerCase()
      .includes(needle),
  );
}

/** Who else has this application open, if anyone but the viewer does: its tick is not theirs. */
export function heldElsewhere(application: Application, me: string): string | null {
  const holder = application.heldBy?.email;
  return holder && holder.toLowerCase() !== me.trim().toLowerCase() ? holder : null;
}

/**
 * What Select all ticks (E38/F05/S02): every row on screen - the filter, Mine, the find field's words
 * and the cap already applied - but those another reviewer has open, and, for someone who may not
 * change a verdict (`changes`), those already approved or rejected (E38/F06/S01); neither can be
 * ticked one by one either. With how many it left for each reason, a row held elsewhere counted as
 * held whatever its verdict.
 */
export function selectAll(
  shown: Application[],
  me: string,
  changes = true,
): { ids: string[]; held: number; decided: number } {
  const free = shown.filter((a) => !heldElsewhere(a, me));
  const ticked = changes ? free : free.filter((a) => !isDecided(a));
  return {
    ids: ticked.map((a) => a.id),
    held: shown.length - free.length,
    decided: free.length - ticked.length,
  };
}

const applicationsWord = (n: number) => `${n} application${n === 1 ? '' : 's'}`;

/**
 * What Select all left out, in one line, or null when it left nothing (E38/F05/S02): the rows
 * another reviewer has open, and the rows already decided for someone who may not change a verdict,
 * each in its own clause, naming who may change one (`whoMay`, from the market's table) where it is
 * known (E38/F06/S01).
 */
export function notSelectedLine(
  held: number,
  decided: number,
  whoMay: string | null,
): string | null {
  if (!held && !decided) return null;
  const mayChange = whoMay ? `which only ${whoMay} may change` : 'which you may not change';
  const lead = `${applicationsWord(held + decided)} not selected`;
  if (!decided) return `${lead}: another reviewer has ${held === 1 ? 'it' : 'them'} open.`;
  if (!held) {
    const have = decided === 1 ? 'it already has' : 'they already have';
    return `${lead}: ${have} a verdict, ${mayChange}.`;
  }
  const have = decided === 1 ? 'already has' : 'already have';
  return `${lead}: another reviewer has ${held} open, and ${decided} ${have} a verdict, ${mayChange}.`;
}
