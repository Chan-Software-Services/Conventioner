/**
 * A vendor's balance state is the server's to read (T335): the screens word and tone the state they
 * are served, over the one table of cases the back end's `compares` and `balance_state` are run
 * over (`back-end/tests/fixtures/balance_states.json`), so a case added there is checked on both
 * sides.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { balanceChip, balanceText, type BalanceState } from '@/utils/payments';

type BalanceCase = {
  name: string;
  currency: string | null;
  owedCents: number;
  paidCents: number;
  compares: boolean;
  balanceState: BalanceState | null;
  text: string;
  chip: string;
};

// Resolved from the project root rather than `import.meta.url`, as `moneyTexts.test.ts` reads its.
const BALANCE_STATES: BalanceCase[] = JSON.parse(
  readFileSync(
    resolvePath(process.cwd(), '../back-end/tests/fixtures/balance_states.json'),
    'utf8',
  ),
);

describe('a vendor’s balance, as it is served', () => {
  it.each(BALANCE_STATES.map((c) => [c.name, c] as const))('%s', (_name, served) => {
    expect(balanceText(served)).toBe(served.text);
    expect(balanceChip(served.balanceState)).toBe(served.chip);
  });

  it('the table reads every state, on a market with prices and on one without', () => {
    const read = new Set(BALANCE_STATES.map((c) => `${c.currency != null} ${c.balanceState}`));
    const states = ['owes', 'paid', 'over', 'null'];
    const missing = [true, false].flatMap((priced) =>
      states.map((state) => `${priced} ${state}`).filter((pair) => !read.has(pair)),
    );
    expect(missing).toEqual([]);
  });
});
