import { createHash } from 'node:crypto';
import { mongoEval } from './mongo';
import { waitForRoomInWindow } from './signInWindow';

/**
 * A sign-in limit's counter, filled or read by a spec as the back end keeps it
 * (`back-end/sign_in_limits.py`), for a limit no spec could fill by its own requests in a test's
 * time: an address's own count, which only many callers together reach.
 *
 * A counter is one document in `sign_in_attempts`, keyed by the SHA-256 of the limit's name, the
 * subject and the window's number, joined by NULs, and counted in fixed windows aligned to the
 * clock, so the key is computed here as the module computes it.
 */
export interface SignInLimit {
  name: string;
  attempts: number;
}

/** Every limit filled here counts in quarter-hour windows, as `waitForRoomInWindow` waits for. */
const WINDOW_MS = 15 * 60 * 1000;

/** The vendor's code sign-in's count per address alone, past which a try asks the human check. */
export const VERIFY_CODE_PER_ADDRESS_CEILING: SignInLimit = {
  name: 'verify-code:address-ceiling',
  attempts: 50,
};

/** The organizer's password sign-in's count per address alone, past which it asks the check. */
export const PASSWORD_PER_ADDRESS_CEILING: SignInLimit = {
  name: 'password:address-ceiling',
  attempts: 50,
};

/** The organizer's code sign-in's count per address alone, past which it asks the check. */
export const ORGANIZER_CODE_PER_ADDRESS_CEILING: SignInLimit = {
  name: 'organizer-code:address-ceiling',
  attempts: 50,
};

function counter(limit: SignInLimit, subject: string): { key: string; windowEnds: Date } {
  const window = Math.floor(Date.now() / WINDOW_MS);
  const key = createHash('sha256').update(`${limit.name}\0${subject}\0${window}`).digest('hex');
  return { key, windowEnds: new Date((window + 1) * WINDOW_MS) };
}

/**
 * Fill `limit` for `subject` (a normalized address) in the current window, as `limit.attempts`
 * tries would, so the next try is past it. Waits first until the window has room for the test, so
 * the try it fills for falls in the same window; a test calling it raises its timeout by
 * `ROOM_IN_WINDOW_WAIT_MS`.
 */
export async function fillSignInLimit(limit: SignInLimit, subject: string): Promise<void> {
  await waitForRoomInWindow();
  const { key, windowEnds } = counter(limit, subject);
  mongoEval(
    `db.sign_in_attempts.updateOne(${JSON.stringify({ _id: key })}, ` +
      `{ $set: { count: ${limit.attempts} }, ` +
      `$setOnInsert: { expires_at: new Date(${windowEnds.getTime()}) } }, { upsert: true })`,
  );
}

/** How many tries `limit` holds for `subject` in the current window. */
export function signInLimitCount(limit: SignInLimit, subject: string): number {
  const { key } = counter(limit, subject);
  return Number(
    mongoEval(
      `(db.sign_in_attempts.findOne(${JSON.stringify({ _id: key })}) || { count: 0 }).count`,
    ),
  );
}
