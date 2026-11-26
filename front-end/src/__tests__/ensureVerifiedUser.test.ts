// @vitest-environment node
/**
 * `ensureVerifiedUser` (`e2e/helpers/verifiedUser.ts`), over a stubbed `create_test_user.py`: the
 * script reads for the address, then inserts, so two workers that make one fixed account at once
 * both read none, and the second insert is refused by the unique email index. That refusal means
 * the account is there, so the helper runs the script once more and passes on its "already
 * exists"; any other failure still fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn<(script: string, ...args: string[]) => string>());
vi.mock('../../e2e/helpers/backendScript', () => ({ runBackendScript: run }));

import { ensureVerifiedUser } from '../../e2e/helpers/verifiedUser';

const EMAIL = 'e2e-shared@example.com';
const PASSWORD = 'e2epassword123';
const CREATED = `✅ Successfully created test user:\n   Email: ${EMAIL}\n`;
const EXISTS = `❌ User with email '${EMAIL}' already exists!\n`;

/** The error `execFileSync` throws for a script that exits non-zero, its stderr kept. */
function failed(stderr: string): Error {
  return Object.assign(
    new Error(`Command failed: docker exec backend python /app/create_test_user.py\n${stderr}`),
    { status: 1, stdout: '', stderr },
  );
}

const DUPLICATE = failed(
  'Traceback (most recent call last):\n' +
    'pymongo.errors.DuplicateKeyError: E11000 duplicate key error collection: conventioner.users ' +
    `index: user_email dup key: { email: "${EMAIL}" }, full error: {'index': 0, 'code': 11000}\n`,
);

beforeEach(() => {
  run.mockReset();
});

describe('ensureVerifiedUser', () => {
  it('passes when the script creates the user, running it once', () => {
    run.mockReturnValueOnce(CREATED);
    ensureVerifiedUser(EMAIL, PASSWORD);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('create_test_user.py', EMAIL, PASSWORD);
  });

  it('passes when the user already exists, running it once', () => {
    run.mockReturnValueOnce(EXISTS);
    ensureVerifiedUser(EMAIL, PASSWORD);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs the script once more after the unique email index refuses a second insert, and passes on its "already exists"', () => {
    run
      .mockImplementationOnce(() => {
        throw DUPLICATE;
      })
      .mockReturnValueOnce(EXISTS);
    ensureVerifiedUser(EMAIL, PASSWORD);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('fails when the second run after the refusal does not find the user', () => {
    run
      .mockImplementationOnce(() => {
        throw DUPLICATE;
      })
      .mockReturnValueOnce('❌ Failed to create user\n');
    expect(() => ensureVerifiedUser(EMAIL, PASSWORD)).toThrow(/did not confirm a verified user/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('fails at once on another duplicate key, which is no account made meanwhile', () => {
    const otherIndex = failed(
      'pymongo.errors.DuplicateKeyError: E11000 duplicate key error collection: conventioner.users ' +
        'index: id_1 dup key: { id: "x" }\n',
    );
    run.mockImplementationOnce(() => {
      throw otherIndex;
    });
    expect(() => ensureVerifiedUser(EMAIL, PASSWORD)).toThrow(otherIndex);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fails at once on any other failure of the script', () => {
    const down = failed('pymongo.errors.ServerSelectionTimeoutError: mongodb:27017: timed out\n');
    run.mockImplementationOnce(() => {
      throw down;
    });
    expect(() => ensureVerifiedUser(EMAIL, PASSWORD)).toThrow(down);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fails when the script prints neither outcome', () => {
    run.mockReturnValueOnce('❌ Failed to create user\n');
    expect(() => ensureVerifiedUser(EMAIL, PASSWORD)).toThrow(/did not confirm a verified user/);
  });
});
