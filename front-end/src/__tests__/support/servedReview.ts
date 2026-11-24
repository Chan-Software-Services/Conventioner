import type { ApplicationOrigin, ApplicationReview, ReviewState } from '@/assets/types/datatypes';

/**
 * What the server serves of an application's review (`review`) and where it came from (`origin`),
 * for a unit test's fixture to spread into an application, so each fixture says the state it stands
 * for and none works it out from a stored status, as no screen does (ADR 0037).
 *
 * `undecided` is read off the state; the share is empty and nothing waits unless the fixture says.
 */
export function servedReview(
  state: ReviewState,
  {
    share = [],
    waiting = false,
    origin = 'applied',
  }: { share?: string[]; waiting?: boolean; origin?: ApplicationOrigin } = {},
): { origin: ApplicationOrigin; review: ApplicationReview } {
  const undecided = state === 'open' || state === 'follow_up';
  return { origin, review: { state, undecided, share, waiting } };
}

/** The state a verdict's write, or an undo's, leaves an application in, as the server answers it. */
const WRITTEN: Record<string, ReviewState> = {
  open: 'open',
  reviewer_approved: 'approved',
  reviewer_rejected: 'rejected',
  needs_follow_up: 'follow_up',
};

/**
 * A fake server's answer to a verdict, a follow-up or an undo on `held`: the application at the
 * status written, served the state that write leaves it in, its share kept. Only the statuses a
 * reviewer's write or an undo gives are answered; any other is a test's mistake.
 */
export function answeredWith<T extends { status: string; review: ApplicationReview }>(
  held: T,
  status: string,
): T {
  const state = WRITTEN[status];
  if (!state) throw new Error(`No verdict writes the status ${status}`);
  const { review } = servedReview(state, { share: held.review.share });
  return { ...held, status, review };
}
