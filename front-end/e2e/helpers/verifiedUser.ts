import { runBackendScript } from './backendScript';

/**
 * Markers printed by `back-end/create_test_user.py`. The script exits 0 whether it created the
 * user, found one already there, or failed to insert, so its exit code says nothing; its output
 * is the only signal that a login-ready user actually exists.
 */
const CREATED_MARKER = 'Successfully created test user';
const ALREADY_EXISTS_MARKER = 'already exists';

/**
 * The unique email index's refusal of a second insert (`user_email`), which the script raises,
 * exiting non-zero, when another worker made the account between its read and its insert.
 */
const EMAIL_TAKEN_MEANWHILE =
  /E11000 duplicate key error collection: \S+\.users index: user_email /;

/** Whether `error`, a failed run of the script, is the unique email index's refusal. */
function emailTakenMeanwhile(error: unknown): boolean {
  const { stderr, message } = error as { stderr?: unknown; message?: unknown };
  return [stderr, message].some(
    (text) => typeof text === 'string' && EMAIL_TAKEN_MEANWHILE.test(text),
  );
}

/**
 * Create a verified test user, idempotently.
 *
 * The sign-up, `/register`, leaves an account unverified until its emailed link is opened, so an
 * account made through it cannot log in. `back-end/create_test_user.py` is the one place that
 * creates a login-ready user, and it is what `scripts/seed_fixture.sh` already runs for the
 * fixture users; a spec that needs its own users runs the same script rather than re-deriving
 * the document shape. The script is a no-op when the email already exists, so this is safe to
 * call from every `beforeAll`.
 *
 * A seeding failure has to surface here, at the `beforeAll` that caused it, rather than much
 * later as an opaque login timeout, so the script's output is checked for one of the two
 * outcomes that leave a usable user behind.
 *
 * Two workers that make one fixed account at once both read none, and the unique email index
 * refuses the second insert: the account is there, so the script runs once more and its "already
 * exists" passes. Any other failure of the script fails here.
 */
export function ensureVerifiedUser(email: string, password: string): void {
  let output: string;
  try {
    output = runBackendScript('create_test_user.py', email, password);
  } catch (error) {
    if (!emailTakenMeanwhile(error)) throw error;
    output = runBackendScript('create_test_user.py', email, password);
  }

  if (!output.includes(CREATED_MARKER) && !output.includes(ALREADY_EXISTS_MARKER)) {
    throw new Error(
      `create_test_user.py did not confirm a verified user for ${email}.\n` + `Output:\n${output}`,
    );
  }
}
