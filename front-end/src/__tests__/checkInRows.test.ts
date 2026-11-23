/**
 * The Check-in section's rows (T201): a row per market day, its vendors checked in of those
 * expected, and beside it how many are not checked in, in the door's words at every time of day,
 * linking to Attendance on that day; a day with nobody missing says so and links nowhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkInRows, type CheckInCounts } from '@/utils/checkInRows';

const CHECK_IN: CheckInCounts = {
  dates: [
    { date: '2099-08-01', expected: 24, checkedIn: 18 },
    { date: '2099-08-02', expected: 20, checkedIn: 20 },
    { date: '2099-08-03', expected: 0, checkedIn: 0 },
  ],
  came: 26,
};

describe('checkInRows', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads each day as its vendors checked in of those expected, named by its date', () => {
    const card = checkInRows(CHECK_IN, 'm-1')!;

    expect(card.rows.map(({ key, label, words }) => ({ key, label, words }))).toEqual([
      { key: '2099-08-01', label: 'Saturday, August 1, 2099', words: '18 of 24 checked in' },
      { key: '2099-08-02', label: 'Sunday, August 2, 2099', words: '20 of 20 checked in' },
      { key: '2099-08-03', label: 'Monday, August 3, 2099', words: 'Nobody is assigned' },
    ]);
  });

  it('draws every day on the card largest expected, marking a day expected short of it', () => {
    const card = checkInRows(CHECK_IN, 'm-1')!;

    expect(card.scale).toBe(24);
    expect(card.rows.map((row) => [row.checkedIn, row.expected, row.mark])).toEqual([
      // The largest day's whole is the track's end: no mark there.
      [18, 24, undefined],
      // A smaller day's whole falls inside the track, so it is marked.
      [20, 20, 20],
      // Nobody to check in: no bar.
      [null, 0, undefined],
    ]);
  });

  it('links the vendors not checked in to Attendance on that day', () => {
    const [saturday] = checkInRows(CHECK_IN, 'm-1')!.rows;

    expect(saturday!.missing).toEqual({
      words: '6 not checked in',
      to: { path: '/markets/m-1/attendance', query: { date: '2099-08-01' } },
    });
  });

  it('says a day with nobody missing is all in, and links nowhere', () => {
    const [, sunday, monday] = checkInRows(CHECK_IN, 'm-1')!.rows;

    expect(sunday!.missing).toEqual({ words: 'Everyone is in', to: null });
    expect(monday!.missing).toBeNull();
  });

  it('says those missing are not checked in at every time of day, as the door does', () => {
    const onSaturday = {
      words: '6 not checked in',
      to: { path: '/markets/m-1/attendance', query: { date: '2099-08-01' } },
    };

    // Saturday to come, Saturday today and Saturday over: the card reads no clock, and no phase,
    // so an archived market's reads the same.
    for (const now of ['2099-07-31T12:00:00', '2099-08-01T12:00:00', '2099-08-02T12:00:00']) {
      vi.setSystemTime(new Date(now));
      expect(checkInRows(CHECK_IN, 'm-1')!.rows[0]!.missing).toEqual(onSaturday);
    }
  });

  it('says a day over with nobody missing is all in, and links nowhere', () => {
    vi.setSystemTime(new Date('2099-08-04T12:00:00'));
    const [, sunday] = checkInRows(CHECK_IN, 'm-1')!.rows;

    expect(sunday!.missing).toEqual({ words: 'Everyone is in', to: null });
  });

  it('reads a day of one vendor with nobody in yet', () => {
    const rows = checkInRows(
      { dates: [{ date: '2099-08-01', expected: 1, checkedIn: 0 }], came: 0 },
      'm-1',
    )!.rows;

    expect(rows[0]!.words).toBe('0 of 1 checked in');
    expect(rows[0]!.missing!.words).toBe('1 not checked in');
  });

  it('gives no card before the market reaches Market Days, or for a plan of no date', () => {
    expect(checkInRows(null, 'm-1')).toBeNull();
    expect(checkInRows({ dates: [], came: 0 }, 'm-1')).toBeNull();
  });
});
