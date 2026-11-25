/**
 * The history's words, one file per area (T174): every key read once, exactly the keys listed here,
 * asked in the order the history always asked them. What each key's words say is pinned by
 * `marketHistory.test.ts` through `entryParts` and `entryChanges`.
 */
import { describe, expect, it } from 'vitest';

// `shared.ts` first, so this file loads the areas by the way an area's helper would.
import { fieldValue } from '@/utils/historyReaders/shared';
import { entryChanges, entryParts, type MarketHistoryEntry } from '@/utils/marketHistory';
import type { FormField } from '@/assets/types/datatypes';
import {
  HISTORY_READERS,
  NAMED_VALUES,
  WORDED_VALUES,
  merged,
  readerKeys,
} from '@/utils/historyReaders';
import * as applications from '@/utils/historyReaders/applications';
import * as applying from '@/utils/historyReaders/applying';
import * as assignment from '@/utils/historyReaders/assignment';
import * as discord from '@/utils/historyReaders/discord';
import * as door from '@/utils/historyReaders/door';
import * as lifecycle from '@/utils/historyReaders/lifecycle';
import * as organization from '@/utils/historyReaders/organization';
import * as payments from '@/utils/historyReaders/payments';
import * as people from '@/utils/historyReaders/people';
import * as publicMap from '@/utils/historyReaders/publicMap';
import * as setup from '@/utils/historyReaders/setup';
import * as vendors from '@/utils/historyReaders/vendors';

const AREAS = [
  applications,
  applying,
  assignment,
  discord,
  door,
  lifecycle,
  organization,
  payments,
  people,
  publicMap,
  setup,
  vendors,
];

/**
 * The keys a sentence is worded for, sorted; a new reader's key is one line in its place. They began
 * as every key `marketHistory.ts` worded before the split: its `switch` cases, its placement kinds of
 * `assign` and its `dealt` of any action. Its one other kind of any action, `permission_table_reset`,
 * is written by `change-the-table` and `change-the-default` alone, so it is read under those two.
 */
const SENTENCES = [
  '*/dealt',
  'add-vendor/',
  'adjust-paid/payment_edited',
  'adjust-paid/payment_removed',
  'adjust-paid/refund_recorded',
  'amend-form/',
  'amend-form/resumed',
  'apply/edited',
  'apply/submitted',
  'assign/assigned',
  'assign/freed',
  'assign/owed_dropped',
  'assign/owed_taken_back',
  'assign/placed',
  'assign/rules',
  'assign/swapped',
  'change-form/form',
  'change-form/rejection_rules',
  'change-form/review_highlights',
  'change-organization/renamed',
  'change-owed/owed_calculated',
  'change-owed/owed_set',
  'change-setup/floorplan',
  'change-setup/floorplan_image_deleted',
  'change-setup/floorplan_removed',
  'change-setup/plan',
  'change-setup/pricing',
  'change-setup/renamed',
  'change-setup/table_types',
  'change-the-default/permission_reset',
  'change-the-default/permission_set',
  'change-the-default/permission_table_reset',
  'change-the-table/permission_reset',
  'change-the-table/permission_set',
  'change-the-table/permission_table_copied',
  'change-the-table/permission_table_reset',
  'change-verdicts/verdict',
  'change-verdicts/verdicts',
  'check-in/check_in_undone',
  'check-in/check_out_undone',
  'check-in/checked_in',
  'check-in/checked_out',
  'check-in/door_code_made',
  'check-in/self_check_in_set',
  'choose-reviewers/reviewers',
  'connect-discord/discord',
  'connect-discord/discord_checked',
  'connect-discord/discord_connected',
  'connect-discord/discord_disconnected',
  'connect-discord/discord_roles_given',
  'create-market/',
  'delete-market/',
  'give-verdicts/follow_up_owner',
  'give-verdicts/verdict',
  'give-verdicts/verdict_undone',
  'give-verdicts/verdicts',
  'give-verdicts/verdicts_undone',
  'hand-on-market/handed_on',
  'import-applications/imported',
  'import-applications/started',
  'manage-admins/invitation_declined',
  'manage-admins/invitation_withdrawn',
  'manage-admins/invited',
  'manage-admins/role_changed',
  'manage-admins/role_given',
  'manage-admins/role_taken',
  'manage-editors-and-viewers/invitation_declined',
  'manage-editors-and-viewers/invitation_withdrawn',
  'manage-editors-and-viewers/invited',
  'manage-editors-and-viewers/role_changed',
  'manage-editors-and-viewers/role_given',
  'manage-editors-and-viewers/role_taken',
  'manage-floorplan-templates/template_added',
  'manage-floorplan-templates/template_changed',
  'manage-floorplan-templates/template_moved_in',
  'manage-floorplan-templates/template_moved_out',
  'manage-floorplan-templates/template_removed',
  'manage-organization-admins/invitation_declined',
  'manage-organization-admins/invitation_withdrawn',
  'manage-organization-admins/invited',
  'manage-organization-admins/role_changed',
  'manage-organization-admins/role_given',
  'manage-organization-admins/role_taken',
  'manage-organization-members/invitation_declined',
  'manage-organization-members/invitation_withdrawn',
  'manage-organization-members/invited',
  'manage-organization-members/role_given',
  'manage-organization-members/role_taken',
  'move-phase/',
  'publish-map/public_map',
  'publish-results/',
  'record-payment/',
  'stop-applications/',
  'transfer-organization/',
  'update-vendor-info/',
  'update-vendor-info/discord_match_declined',
  'update-vendor-info/kept',
  'write-vendor-notes/note',
  'write-vendor-notes/request_handled',
];

/** The keys before-and-after rows are given for, sorted, as `entryChanges`' `if` chain gave them
 * before the split, an action's every kind keyed `action/*`, and a selection's verdicts since. */
const ROWS = [
  '*/dealt',
  'add-vendor/*',
  'adjust-paid/*',
  'apply/edited',
  'apply/submitted',
  'assign/owed_dropped',
  'assign/owed_taken_back',
  'assign/placed',
  'change-owed/*',
  'change-setup/floorplan',
  'change-setup/pricing',
  'change-setup/table_types',
  'change-the-default/permission_table_reset',
  'change-the-table/permission_table_copied',
  'change-the-table/permission_table_reset',
  'change-verdicts/verdicts',
  'choose-reviewers/reviewers',
  'connect-discord/*',
  'connect-discord/discord_checked',
  'connect-discord/discord_roles_given',
  'give-verdicts/verdicts',
  'give-verdicts/verdicts_undone',
  'publish-map/public_map',
  'record-payment/*',
  'update-vendor-info/*',
  'update-vendor-info/discord_match_declined',
];

const keysWith = (method: 'parts' | 'changes') =>
  Object.entries(HISTORY_READERS)
    .filter(([, reader]) => reader?.[method])
    .map(([key]) => key)
    .sort();

describe('the history readers', () => {
  it('reads every key in one area only', () => {
    const keys = AREAS.flatMap((area) => Object.keys(area.readers));
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    expect(Object.keys(HISTORY_READERS).sort()).toEqual(keys.sort());
  });

  it('words a sentence for the keys listed, and only those', () => {
    expect(keysWith('parts')).toEqual([...SENTENCES].sort());
  });

  it('gives rows for the keys listed, and only those', () => {
    expect(keysWith('changes')).toEqual([...ROWS].sort());
  });

  it('refuses a key two areas both define, naming both', () => {
    const one = { readers: { 'check-in/checked_in': {} } };
    const other = { readers: { 'check-in/checked_in': {} } };
    expect(() => merged('reader', { door: one.readers, people: other.readers })).toThrow(
      'The history\'s reader "check-in/checked_in" is defined by both door and people',
    );
  });

  it('words every placement kind of assign by the one reader', () => {
    const parts = assignment.PLACEMENT_KINDS.map(
      (kind) => HISTORY_READERS[`assign/${kind}`]?.parts,
    );
    expect(parts.every((one) => typeof one === 'function')).toBe(true);
    expect(new Set(parts).size).toBe(1);
  });

  it('words a market handed on: who to, and that its old Owner stays on it as an Admin', () => {
    const parts = entryParts(
      {
        id: 'e1',
        actor: 'dana@ember.test',
        at: '2026-11-01T10:00:00+00:00',
        action: 'hand-on-market',
        kind: 'handed_on',
        vendors: [],
        subject: { user_id: 'user-sam', email: 'sam@ember.test' },
        detail: { before: { owner: 'dana@ember.test' }, after: { owner: 'sam@ember.test' } },
      },
      { names: {}, labels: {} },
    );
    expect(parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')).toBe(
      'dana@ember.test transferred ownership of the market to sam@ember.test, and stays on it as an Admin',
    );
  });

  it('names and words the stored values the areas name and word', () => {
    expect(Object.keys(NAMED_VALUES).sort()).toEqual(['role', 'source', 'status']);
    expect(Object.keys(WORDED_VALUES).sort()).toEqual(['aisles', 'table_types']);
    expect(fieldValue('source', 'organization')).toBe('The organization’s default');
  });
});

/** A vendor checked out, that undone, and the market's self check-in switch (T496). */
describe('a check-out at the door', () => {
  const NAMES = { 'ana@ember.test': 'Ana Rivera' };

  function anEntry(kind: string, actor: string | null, detail: unknown, vendors = true) {
    return {
      id: 'e1',
      actor,
      at: '2026-11-19T17:00:00+00:00',
      action: 'check-in',
      kind,
      vendors: vendors ? ['ana@ember.test'] : [],
      subject: vendors ? { date: '2026-11-19' } : {},
      detail,
    } as MarketHistoryEntry;
  }

  function said(entry: MarketHistoryEntry, dayLeads = false): string {
    return entryParts(entry, { names: NAMES, dayLeads })
      .map((part) => (part.kind === 'text' ? part.text : `[${part.name || part.email}]`))
      .join('');
  }

  const out = (via?: string) => ({
    before: { checked_out: false },
    after: { checked_out: true },
    ...(via ? { via } : {}),
  });
  const back = (via?: string) => ({
    before: { checked_out: true },
    after: { checked_out: false },
    ...(via ? { via } : {}),
  });

  it('says which organizer checked the vendor out, and on which day', () => {
    expect(said(anEntry('checked_out', 'dana@ember.test', out()))).toBe(
      'dana@ember.test checked [Ana Rivera] out on Nov 19, 2026',
    );
  });

  it('says a vendor checked themselves out with the door code', () => {
    expect(said(anEntry('checked_out', null, out('door_code')))).toBe(
      '[Ana Rivera] checked out with the door code on Nov 19, 2026',
    );
  });

  it('says which organizer undid a check-out', () => {
    expect(said(anEntry('check_out_undone', 'dana@ember.test', back()))).toBe(
      'dana@ember.test undid the check-out of [Ana Rivera] on Nov 19, 2026',
    );
  });

  it('says a vendor undid their own check-out on their vendor page', () => {
    expect(said(anEntry('check_out_undone', null, back('vendor_page')))).toBe(
      '[Ana Rivera] undid their check-out on their vendor page on Nov 19, 2026',
    );
  });

  it('leaves the day to the list where the day leads it', () => {
    expect(said(anEntry('checked_out', 'dana@ember.test', out()), true)).toBe(
      'dana@ember.test checked [Ana Rivera] out',
    );
    expect(said(anEntry('check_out_undone', null, back('vendor_page')), true)).toBe(
      '[Ana Rivera] undid their check-out on their vendor page',
    );
  });

  it('names the vendor as a link to their drawer, as a check-in does', () => {
    const parts = entryParts(anEntry('checked_out', 'dana@ember.test', out()), { names: NAMES });
    expect(parts.filter((part) => part.kind === 'vendor')).toEqual([
      { kind: 'vendor', name: 'Ana Rivera', email: 'ana@ember.test' },
    ]);
  });

  it('says who let vendors check themselves in and out, and who stopped them', () => {
    const set = (enabled: boolean, actor: string | null = 'dana@ember.test') =>
      said(
        anEntry(
          'self_check_in_set',
          actor,
          { before: { enabled: !enabled }, after: { enabled } },
          false,
        ),
      );

    expect(set(true)).toBe('dana@ember.test let vendors check themselves in and out');
    expect(set(false)).toBe('dana@ember.test stopped vendors checking themselves in and out');
    // An entry with no actor, which no write makes, still reads as a sentence.
    expect(set(true, null)).toBe('Someone let vendors check themselves in and out');
    expect(set(false, null)).toBe('Someone stopped vendors checking themselves in and out');
  });
});

/** What owed a day a run dropped, and a free's $0 taken back by seating it again (T335). */
describe('an amount owed the assignment changed', () => {
  const NAMES = { 'ana@ember.test': 'Ana Rivera' };
  const CAD = { currency: 'CAD' };

  function anEntry(kind: string, subject: Record<string, unknown>, detail: unknown) {
    return {
      id: 'e1',
      actor: 'dana@ember.test',
      at: '2099-05-01T10:00:00+00:00',
      action: 'assign',
      kind,
      vendors: ['ana@ember.test'],
      subject,
      detail,
    } as MarketHistoryEntry;
  }

  function said(entry: MarketHistoryEntry, dayLeads = false): string {
    return entryParts(entry, { names: NAMES, dayLeads })
      .map((part) => (part.kind === 'text' ? part.text : `[${part.name || part.email}]`))
      .join('');
  }

  const DROPPED = { before: { owed_cents: 0 }, after: { owed_cents: null } };
  const byTheRun = anEntry(
    'owed_dropped',
    { date: '2099-05-08', ...CAD, set_by: 'admin@ember.test' },
    DROPPED,
  );
  const byTheMigration = anEntry(
    'owed_dropped',
    { date: '2099-05-08', ...CAD, set_by: 'admin@ember.test', by_migration: true },
    DROPPED,
  );

  it('says who allocated tables, the day, the amount dropped and who set it', () => {
    expect(said(byTheRun)).toBe(
      'dana@ember.test allocated tables, leaving [Ana Rivera] without a table on May 8, 2099, ' +
        'so the $0.00 admin@ember.test set for that day was dropped',
    );
  });

  it('says the day the migration found held no table, with no one making the change', () => {
    expect(said({ ...byTheMigration, actor: null } as MarketHistoryEntry)).toBe(
      '[Ana Rivera] held no table on May 8, 2099, so the $0.00 admin@ember.test set for that ' +
        'day was dropped',
    );
  });

  it('says the day a seating found held no table, naming no one as dropping it', () => {
    const bySeating = anEntry(
      'owed_dropped',
      { date: '2099-05-08', ...CAD, set_by: 'admin@ember.test', held_no_table: true },
      DROPPED,
    );
    expect(said(bySeating)).toBe(
      '[Ana Rivera] held no table on May 8, 2099, so the $0.00 admin@ember.test set for that ' +
        'day was dropped',
    );
    expect(entryChanges(bySeating)).toEqual(entryChanges(byTheMigration));
  });

  it('leaves the day to the list where the day leads it', () => {
    expect(said(byTheRun, true)).toBe(
      'dana@ember.test allocated tables, leaving [Ana Rivera] without a table, so the $0.00 ' +
        'admin@ember.test set for that day was dropped',
    );
    expect(said({ ...byTheMigration, actor: null } as MarketHistoryEntry, true)).toBe(
      '[Ana Rivera] held no table, so the $0.00 admin@ember.test set for that day was dropped',
    );
  });

  it('leaves out who set an amount stored without them', () => {
    const unnamed = { ...byTheRun.subject };
    delete unnamed.set_by;
    expect(said({ ...byTheRun, subject: unnamed })).toBe(
      'dana@ember.test allocated tables, leaving [Ana Rivera] without a table on May 8, 2099, ' +
        'so the $0.00 set for that day was dropped',
    );
  });

  it('opens to the amount owed before and none after, and the day', () => {
    for (const entry of [byTheRun, byTheMigration]) {
      expect(entryChanges(entry)).toEqual({
        changed: [{ field: 'Amount owed', before: '$0.00', after: 'none' }],
        recorded: [{ field: 'Date', value: 'May 8, 2099' }],
      });
    }
  });

  it('reads a free’s $0 taken back exactly as before', () => {
    const takenBack = anEntry(
      'owed_taken_back',
      { date: '2099-05-08', ...CAD },
      { before: { owed_cents: 0 }, after: { owed_cents: 1500 } },
    );
    expect(said(takenBack)).toBe(
      'dana@ember.test seated [Ana Rivera] again on May 8, 2099, taking back the $0.00 set when ' +
        'the table was freed',
    );
    expect(entryChanges(takenBack)).toEqual({
      changed: [{ field: 'Amount owed', before: '$0.00', after: '$15.00' }],
      recorded: [{ field: 'Date', value: 'May 8, 2099' }],
    });
  });
});

/** A placement written while results were published says so after its day (T316). */
describe('a placement after results were published', () => {
  const ON_THE_DAY = ' on Nov 19, 2026';

  function says(kind: string, vendors: string[], detail: Record<string, unknown>): string {
    const parts = entryParts(
      {
        id: 'e1',
        actor: 'dana@ember.test',
        at: '2026-11-20T10:00:00+00:00',
        action: 'assign',
        kind,
        vendors,
        subject: {},
        detail,
      },
      { names: {}, labels: {} },
    );
    return parts.map((part) => (part.kind === 'text' ? part.text : `[${part.kind}]`)).join('');
  }

  const SWAP = {
    date: '2026-11-19',
    seats: [
      { email: 'ana@ember.test', table_code: 'A3' },
      { email: 'ben@ember.test', table_code: 'B7' },
    ],
  };

  it.each([
    [
      'a free, by the table their vendor page had shown',
      'freed',
      ['ana@ember.test'],
      { date: '2026-11-19', table_code: 'B7' },
      `freed B7, leaving [vendor] with no table${ON_THE_DAY}, after results were published: their vendor page had shown B7`,
    ],
    [
      'a move, by the table left',
      'placed',
      ['ana@ember.test'],
      { date: '2026-11-19', table_code: 'B7', before: { table_code: 'A3' } },
      `moved [vendor] from A3 to B7${ON_THE_DAY}, after results were published: their vendor page had shown A3`,
    ],
    [
      'a new assignment',
      'placed',
      ['ana@ember.test'],
      { date: '2026-11-19', table_code: 'B7', before: null },
      `assigned [vendor] at B7${ON_THE_DAY}, after results were published`,
    ],
    [
      'a swap',
      'swapped',
      ['ana@ember.test', 'ben@ember.test'],
      SWAP,
      `swapped [vendor] and [vendor] - now at A3 and B7${ON_THE_DAY}, after results were published`,
    ],
  ])('says %s', (_name, kind, vendors, detail, sentence) => {
    expect(says(kind, vendors, { ...detail, after_results: true })).toBe(
      `dana@ember.test ${sentence}`,
    );
  });

  it.each([
    ['freed', ['ana@ember.test'], { date: '2026-11-19', table_code: 'B7' }],
    [
      'placed',
      ['ana@ember.test'],
      { date: '2026-11-19', table_code: 'B7', before: { table_code: 'A3' } },
    ],
    ['placed', ['ana@ember.test'], { date: '2026-11-19', table_code: 'B7', before: null }],
    ['swapped', ['ana@ember.test', 'ben@ember.test'], SWAP],
  ])('reads an entry of %s without the key exactly as before', (kind, vendors, detail) => {
    expect(says(kind, vendors, detail)).not.toContain('after results');
    expect(says(kind, vendors, detail)).toBe(
      says(kind, vendors, { ...detail, after_results: false }),
    );
    expect(says(kind, vendors, detail)).toMatch(new RegExp(`${ON_THE_DAY}$`));
  });
});

/** The Public map card's changes, each in words (T422). */
describe('a change to the public map', () => {
  const FORM = [
    { key: 'shop', label: 'Shop name', type: 'text', required: true, options: [], order: 0 },
  ] as FormField[];

  function aChange(before: Record<string, unknown>, after: Record<string, unknown>) {
    return {
      id: 'e1',
      actor: 'dana@ember.test',
      at: '2026-11-17T10:00:00+00:00',
      action: 'publish-map',
      kind: 'public_map',
      vendors: [],
      subject: {},
      detail: { before, after },
    } as MarketHistoryEntry;
  }

  const said = (entry: MarketHistoryEntry) =>
    entryParts(entry, { fields: FORM })
      .map((part) => (part.kind === 'text' ? part.text : `[${part.kind}]`))
      .join('');

  it.each([
    ['turned on', { enabled: false }, { enabled: true }, 'turned the public map on'],
    ['turned off', { enabled: true }, { enabled: false }, 'turned the public map off'],
    [
      'its name chosen',
      { name_question: null, name_question_label: null },
      { name_question: 'shop', name_question_label: 'Shop name' },
      'set the public map’s name to “Shop name”',
    ],
    [
      'its website chosen',
      { website_question: null, website_question_label: null },
      { website_question: 'site', website_question_label: 'Your website' },
      'set the public map’s website to “Your website”',
    ],
    [
      'its Instagram chosen',
      { instagram_question: 'site', instagram_question_label: 'Your website' },
      { instagram_question: 'insta', instagram_question_label: 'Instagram handle' },
      'set the public map’s Instagram to “Instagram handle”',
    ],
    [
      'its website no longer shown',
      { website_question: 'site', website_question_label: 'Your website' },
      { website_question: null, website_question_label: null },
      'stopped showing the website on the public map',
    ],
    [
      'its Instagram no longer shown',
      { instagram_question: 'insta', instagram_question_label: 'Instagram handle' },
      { instagram_question: null, instagram_question_label: null },
      'stopped showing Instagram on the public map',
    ],
    [
      'its name no longer chosen',
      { name_question: 'shop', name_question_label: 'Shop name' },
      { name_question: null, name_question_label: null },
      'stopped showing names on the public map',
    ],
    [
      'two changes at once',
      { enabled: false, name_question: null, name_question_label: null },
      { enabled: true, name_question: 'shop', name_question_label: 'Shop name' },
      'turned the public map on and set the public map’s name to “Shop name”',
    ],
  ])('says %s', (_name, before, after, words) => {
    expect(said(aChange(before, after))).toBe(`dana@ember.test ${words}`);
  });

  it('names a question recorded with no label by the form, or as gone from it', () => {
    expect(said(aChange({ name_question: null }, { name_question: 'shop' }))).toBe(
      'dana@ember.test set the public map’s name to “Shop name”',
    );
    expect(said(aChange({ name_question: null }, { name_question: 'gone' }))).toBe(
      'dana@ember.test set the public map’s name to “gone” (no longer on the form)',
    );
  });

  it('opens to each setting before and after, by its name on the card, never a key', () => {
    const entry = aChange(
      { enabled: false, name_question: null, name_question_label: null },
      { enabled: true, name_question: 'shop', name_question_label: 'Shop name' },
    );
    expect(entryChanges(entry, { fields: FORM })).toEqual({
      changed: [
        { field: 'Show the public map', before: 'Off', after: 'On' },
        { field: 'Public name', before: 'Not shown', after: 'Shop name' },
      ],
      recorded: [],
    });
  });
});

describe('the order the readers are asked in', () => {
  it('asks a placement kind of assign first, then the kind under any action', () => {
    expect(readerKeys({ action: 'assign', kind: 'freed' })).toEqual([
      'assign/freed',
      '*/freed',
      'assign/*',
    ]);
  });

  it('asks the kind under any action, then the action and kind, then every kind of the action', () => {
    expect(readerKeys({ action: 'update-vendor-info', kind: 'kept' })).toEqual([
      '*/kept',
      'update-vendor-info/kept',
      'update-vendor-info/*',
    ]);
  });

  it('asks an entry with no kind by its action and an empty kind', () => {
    expect(readerKeys({ action: 'move-phase', kind: null })).toEqual([
      '*/',
      'move-phase/',
      'move-phase/*',
    ]);
  });
});
