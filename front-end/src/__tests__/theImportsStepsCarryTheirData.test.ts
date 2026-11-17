/**
 * The CSV import's steps carry their data (T419, T277 ticket 13).
 *
 * One function moves the import between its steps, `importStep`, and each step holds exactly what
 * it stands on: Preview cannot exist without the file, the mapping and the values check it was
 * opened from. One `it` per row of the spec's transition table, read through `importStep` alone;
 * then the constructors that read the server's answers into step data.
 */
import { describe, expect, it } from 'vitest';

import {
  START,
  NEEDS_A_FIELD,
  asksBeforeLeaving,
  dryRunFrom,
  importStep,
  inspectionFrom,
  keepDecisions,
  mappingBody,
  mayCheck,
  mayConfirm,
  mayGoBack,
  resolutionsBody,
  resultFrom,
  type DryRun,
  type ImportEvent,
  type ImportFile,
  type ImportStep,
  type ImportWizard,
  type MappingEdit,
} from '@/utils/importWizard';
import { IGNORE_VALUE } from '@/utils/valueFixes';
import { MarketPhase } from '@/assets/types/datatypes';

const FILE: ImportFile = {
  name: 'responses.csv',
  content: 'Email,Tier\nana-vendor@example.com,Gold',
};

const INSPECTED = inspectionFrom({
  headers: ['Email', 'Tier', 'Days [Sat]', 'Days [Sun]'],
  sampleValues: [['ana-vendor@example.com'], ['Gold'], ['Yes'], ['No']],
  rowCount: 1,
  targets: [
    { key: 'applicant_email', label: 'Email', required: true, kind: 'identity' },
    { key: 'tier_preference', label: 'Tier', required: true, kind: 'essential' },
  ],
  groups: [{ stem: 'Days', columns: [2, 3], options: ['Sat', 'Sun'] }],
  suggestedMapping: { applicant_email: 0 },
});

const CHECKED: DryRun = dryRunFrom({ validRows: 1, newRows: 1 });
const UNMATCHED: DryRun = dryRunFrom({
  unmatched: [{ target: 'tier', targetLabel: 'Tier', value: 'Gld', rows: 1, offered: ['Gold'] }],
});
const RESULT = resultFrom({ created: 1, phase: MarketPhase.Applications }, true);

const EDITS: MappingEdit[] = [
  { kind: 'map', column: 1, target: 'tier' },
  { kind: 'mapGroup', stem: 'Days', target: 'available_dates' },
  { kind: 'split', stem: 'Days' },
  { kind: 'resolve', target: 'tier', value: 'Gld', choice: 'Gold' },
];

/** The wizard after the events, each answer carrying the token the wizard holds at that moment. */
function after(...events: Array<ImportEvent | ((token: number) => ImportEvent)>): ImportWizard {
  return events.reduce<ImportWizard>(
    (wizard, event) =>
      importStep(wizard, typeof event === 'function' ? event(wizard.token) : event),
    START,
  );
}

const choose: ImportEvent = { kind: 'choose', file: FILE };
const inspected =
  (values: DryRun | null = null) =>
  (token: number): ImportEvent => ({ kind: 'inspected', token, ...INSPECTED, values });
const check: ImportEvent = { kind: 'check' };
const checked =
  (values: DryRun = CHECKED) =>
  (token: number): ImportEvent => ({ kind: 'checked', token, values });
const refused =
  (sentence: string) =>
  (token: number): ImportEvent => ({ kind: 'refused', token, sentence });
const reread: ImportEvent = { kind: 'reread' };
const reinspected =
  (values: DryRun | null = null) =>
  (token: number): ImportEvent => ({ kind: 'reinspected', token, ...INSPECTED, values });
const confirm: ImportEvent = { kind: 'confirm' };
const imported = (token: number): ImportEvent => ({ kind: 'imported', token, result: RESULT });
const back: ImportEvent = { kind: 'back' };

const reading = () => after(choose);
const onMapping = () => after(choose, inspected());
const onMappingReading = () => after(choose, inspected(), reread);
const onValues = () => after(choose, inspected(), check);
const onPreview = () => after(choose, inspected(), check, checked());
const onImporting = () => after(choose, inspected(), check, checked(), confirm);
const onDone = () => after(choose, inspected(), check, checked(), confirm, imported);

function stepOf<K extends ImportStep['kind']>(wizard: ImportWizard, kind: K) {
  expect(wizard.step.kind).toBe(kind);
  return wizard.step as Extract<ImportStep, { kind: K }>;
}

describe('the transition table', () => {
  it('row 1: a file chosen on Upload is read, the refusal cleared and the token moved', () => {
    const refusedFirst = importStep(START, { kind: 'unreadable', sentence: 'Not a CSV.' });
    const next = importStep(refusedFirst, choose);
    expect(next).toEqual({ step: { kind: 'upload', reading: FILE, refusal: '' }, token: 1 });
  });

  it('row 2: a second file while one is read changes nothing', () => {
    const wizard = reading();
    expect(importStep(wizard, { kind: 'choose', file: { name: 'b.csv', content: 'x' } })).toBe(
      wizard,
    );
  });

  it("row 3: a file the browser refuses stays on Upload with the refusal's sentence", () => {
    const next = importStep(START, { kind: 'unreadable', sentence: 'Not a CSV.' });
    expect(next).toEqual({
      step: { kind: 'upload', reading: null, refusal: 'Not a CSV.' },
      token: 0,
    });
  });

  it("row 4: the inspect's answer opens Map columns with the file, its mapping and its values", () => {
    const wizard = reading();
    const next = importStep(wizard, inspected(CHECKED)(wizard.token));
    expect(next).toEqual({
      step: {
        kind: 'mapping',
        file: FILE,
        ...INSPECTED,
        values: CHECKED,
        reading: false,
        refusal: '',
      },
      token: wizard.token + 1,
    });
  });

  it('row 5: a refused inspect stays on Upload holding no file, with the sentence', () => {
    const wizard = reading();
    const next = importStep(wizard, refused('That file could not be read.')(wizard.token));
    expect(next).toEqual({
      step: { kind: 'upload', reading: null, refusal: 'That file could not be read.' },
      token: wizard.token,
    });
  });

  it('row 6: an edit on Map columns is applied, read out or not, and the rest kept', () => {
    for (const wizard of [onMapping(), onMappingReading()]) {
      const before = stepOf(wizard, 'mapping');
      const next = importStep(wizard, { kind: 'map', column: 1, target: 'tier' });
      const step = stepOf(next, 'mapping');
      expect(next.token).toBe(wizard.token);
      expect(step.mapping.columnTarget).toEqual({ ...before.mapping.columnTarget, 1: 'tier' });
      expect(before.mapping.columnTarget[1]).toBe('');
      expect({ ...step, mapping: before.mapping }).toEqual(before);
    }
    const mapped = importStep(onMapping(), EDITS[1]);
    expect(stepOf(mapped, 'mapping').mapping.groupTarget.Days).toBe('available_dates');
    const split = importStep(mapped, EDITS[2]);
    expect(stepOf(split, 'mapping').mapping.splitStems).toEqual(new Set(['Days']));
    expect(stepOf(split, 'mapping').mapping.groupTarget).not.toHaveProperty('Days');
    const resolved = importStep(onMapping(), EDITS[3]);
    expect(stepOf(resolved, 'mapping').mapping.resolutions).toEqual({ tier: { Gld: 'Gold' } });
  });

  it('row 7: an edit during the values check withdraws it, keeping the values', () => {
    for (const edit of EDITS) {
      const wizard = after(choose, inspected(UNMATCHED), check);
      const next = importStep(wizard, edit);
      const step = stepOf(next, 'mapping');
      expect(next.token).toBe(wizard.token + 1);
      expect(step.values).toBe(UNMATCHED);
      expect(step.reading).toBe(false);
      expect(step.refusal).toBe('');
      expect(step.mapping).not.toEqual(INSPECTED.mapping);
    }
  });

  it('row 8: the values check sends Map columns to the check, its values kept', () => {
    const wizard = after(choose, inspected(UNMATCHED), refused('Could not read the form.'));
    const next = importStep(wizard, check);
    expect(next).toEqual({
      step: { kind: 'values', file: FILE, ...INSPECTED, values: UNMATCHED },
      token: wizard.token + 1,
    });
  });

  it('row 9: no values check while the questions are read again', () => {
    const wizard = onMappingReading();
    expect(importStep(wizard, check)).toBe(wizard);
  });

  it('row 10: a check that finds every value opens Preview on what it was computed for', () => {
    const wizard = onValues();
    const next = importStep(wizard, checked()(wizard.token));
    expect(next).toEqual({
      step: {
        kind: 'preview',
        file: FILE,
        ...INSPECTED,
        values: CHECKED,
        refusal: '',
        reviewersRefusal: '',
      },
      token: wizard.token + 1,
    });
  });

  it('row 11: a check that finds a value unmatched stays on Map columns with its values', () => {
    const wizard = onValues();
    const next = importStep(wizard, checked(UNMATCHED)(wizard.token));
    expect(next).toEqual({
      step: {
        kind: 'mapping',
        file: FILE,
        ...INSPECTED,
        values: UNMATCHED,
        reading: false,
        refusal: '',
      },
      token: wizard.token + 1,
    });
  });

  it('row 12: a failed check returns to Map columns with its sentence, the values kept', () => {
    const wizard = after(choose, inspected(UNMATCHED), check);
    const next = importStep(wizard, refused('That file could not be checked.')(wizard.token));
    expect(next).toEqual({
      step: {
        kind: 'mapping',
        file: FILE,
        ...INSPECTED,
        values: UNMATCHED,
        reading: false,
        refusal: 'That file could not be checked.',
      },
      token: wizard.token + 1,
    });
  });

  it("row 13: the amend dialog's failed form read says so on Map columns", () => {
    const wizard = onMapping();
    const sentence = "Could not read this market's application form.";
    const next = importStep(wizard, refused(sentence)(wizard.token));
    expect(next).toEqual({ step: { ...wizard.step, refusal: sentence }, token: wizard.token });
  });

  it('row 14: a form change reads the questions again, the refusal cleared and the token moved', () => {
    const wizard = after(choose, inspected(), refused('Could not read the form.'));
    const next = importStep(wizard, reread);
    expect(next).toEqual({
      step: { ...wizard.step, reading: true, refusal: '' },
      token: wizard.token + 1,
    });
  });

  it("row 15: the re-read's answer replaces the inspection and keeps the organizer's decisions", () => {
    const edited = [
      { kind: 'map', column: 1, target: 'tier' },
      { kind: 'resolve', target: 'tier', value: 'Gld', choice: 'Gold' },
    ] as const;
    const wizard = after(choose, inspected(), ...edited, reread);
    const next = importStep(wizard, reinspected(UNMATCHED)(wizard.token));
    const step = stepOf(next, 'mapping');
    expect(next.token).toBe(wizard.token);
    expect(step.reading).toBe(false);
    expect(step.values).toBe(UNMATCHED);
    expect(step.mapping.columnTarget).toEqual({ 0: 'applicant_email', 1: 'tier', 2: '', 3: '' });
    expect(step.mapping.resolutions).toEqual({ tier: { Gld: 'Gold' } });
  });

  it('row 15: a grid split apart stays split across the re-read', () => {
    const wizard = after(
      choose,
      inspected(),
      { kind: 'split', stem: 'Days' },
      { kind: 'map', column: 2, target: 'sat' },
      reread,
    );
    const next = importStep(wizard, reinspected()(wizard.token));
    const step = stepOf(next, 'mapping');
    expect(step.mapping.splitStems).toEqual(new Set(['Days']));
    expect(step.mapping.groupTarget).not.toHaveProperty('Days');
    expect(step.mapping.columnTarget[2]).toBe('sat');
    expect(mappingBody(step.inspection, step.mapping)).toEqual({ applicant_email: 0, sat: 2 });
  });

  it('row 16: a failed re-read ends it on Map columns with the sentence', () => {
    const wizard = onMappingReading();
    const next = importStep(wizard, refused('That file could not be read.')(wizard.token));
    expect(next).toEqual({
      step: { ...wizard.step, reading: false, refusal: 'That file could not be read.' },
      token: wizard.token,
    });
  });

  it('row 17: Back on Map columns starts over, holding no file', () => {
    const wizard = onMapping();
    expect(mayGoBack(wizard.step)).toBe(true);
    expect(importStep(wizard, back)).toEqual({ step: START.step, token: wizard.token + 1 });
  });

  it('row 18: no Back while the questions are read again', () => {
    const wizard = onMappingReading();
    expect(mayGoBack(wizard.step)).toBe(false);
    expect(importStep(wizard, back)).toBe(wizard);
  });

  it('row 19: no Back during the values check', () => {
    const wizard = onValues();
    expect(mayGoBack(wizard.step)).toBe(false);
    expect(importStep(wizard, back)).toBe(wizard);
  });

  it('row 20: Back on Preview returns to Map columns with the mapping and the values', () => {
    const wizard = onPreview();
    expect(mayGoBack(wizard.step)).toBe(true);
    expect(importStep(wizard, back)).toEqual({
      step: {
        kind: 'mapping',
        file: FILE,
        ...INSPECTED,
        values: CHECKED,
        reading: false,
        refusal: '',
      },
      token: wizard.token + 1,
    });
  });

  it('row 21: Import on a Preview with rows to write starts the import, both refusals cleared', () => {
    const wizard = after(choose, inspected(), check, checked(), confirm, (token) => ({
      kind: 'reviewersRefused',
      token,
      sentence: 'Could not save the reviewers.',
    }));
    expect(mayConfirm(wizard.step)).toBe(true);
    const next = importStep(wizard, confirm);
    expect(next).toEqual({
      step: { kind: 'importing', from: { ...wizard.step, reviewersRefusal: '' } },
      token: wizard.token + 1,
    });
  });

  it('row 22: Import on a Preview with no row to write changes nothing', () => {
    const wizard = after(choose, inspected(), check, checked(dryRunFrom({ validRows: 0 })));
    expect(mayConfirm(wizard.step)).toBe(false);
    expect(importStep(wizard, confirm)).toBe(wizard);
  });

  it("row 23: the import's answer opens the done step with the file's name and the result", () => {
    const wizard = onImporting();
    expect(importStep(wizard, imported(wizard.token))).toEqual({
      step: { kind: 'done', fileName: 'responses.csv', result: RESULT },
      token: wizard.token + 1,
    });
  });

  it('row 24: a failed import returns to its Preview whole, with the sentence', () => {
    const wizard = onImporting();
    const next = importStep(wizard, refused('The import could not be completed.')(wizard.token));
    expect(next).toEqual({
      step: { ...onPreview().step, refusal: 'The import could not be completed.' },
      token: wizard.token + 1,
    });
  });

  it('row 25: a refused reviewers write returns to its Preview with its own sentence', () => {
    const wizard = onImporting();
    const next = importStep(wizard, {
      kind: 'reviewersRefused',
      token: wizard.token,
      sentence: 'Could not save the reviewers.',
    });
    expect(next).toEqual({
      step: { ...onPreview().step, reviewersRefusal: 'Could not save the reviewers.' },
      token: wizard.token + 1,
    });
  });

  it('row 26: nothing goes back, imports again or edits while the import is written', () => {
    const wizard = onImporting();
    for (const event of [back, confirm, ...EDITS]) expect(importStep(wizard, event)).toBe(wizard);
    expect(mayGoBack(wizard.step)).toBe(false);
  });

  it('row 27: an edit on Upload, Preview or the done step changes nothing', () => {
    for (const wizard of [START, reading(), onPreview(), onDone()]) {
      for (const edit of EDITS) expect(importStep(wizard, edit)).toBe(wizard);
    }
  });

  it('row 28: the done step takes no Back, Import or values check', () => {
    const wizard = onDone();
    for (const event of [back, confirm, check]) expect(importStep(wizard, event)).toBe(wizard);
  });

  it('row 29: a reset from any step returns to Upload and moves the token', () => {
    for (const wizard of [
      START,
      reading(),
      onMapping(),
      onMappingReading(),
      onValues(),
      onPreview(),
      onImporting(),
      onDone(),
    ]) {
      expect(importStep(wizard, { kind: 'reset' })).toEqual({
        step: START.step,
        token: wizard.token + 1,
      });
    }
  });

  describe('row 30: an answer whose token is not the wizard’s changes nothing', () => {
    const stale = (wizard: ImportWizard) => wizard.token - 1;

    it('inspected', () => {
      const wizard = after(choose, { kind: 'reset' }, choose);
      expect(importStep(wizard, inspected()(stale(wizard)))).toBe(wizard);
    });

    it('checked', () => {
      // The check sent, Back pressed on it, Map columns again: its answer lands there.
      const wizard = after(choose, inspected(), check, EDITS[0], check);
      expect(importStep(wizard, checked()(stale(wizard)))).toBe(wizard);
      const startedOver = after(choose, inspected(), check, { kind: 'reset' });
      expect(importStep(startedOver, checked()(startedOver.token - 1))).toBe(startedOver);
    });

    it('reinspected', () => {
      const wizard = after(choose, inspected(), reread, { kind: 'reset' });
      expect(importStep(wizard, reinspected()(stale(wizard)))).toBe(wizard);
    });

    it('imported', () => {
      const wizard = after(choose, inspected(), check, checked(), confirm, { kind: 'reset' });
      expect(importStep(wizard, imported(stale(wizard)))).toBe(wizard);
    });

    it('reviewersRefused', () => {
      const wizard = after(choose, inspected(), check, checked(), confirm, { kind: 'reset' });
      expect(
        importStep(wizard, { kind: 'reviewersRefused', token: stale(wizard), sentence: 'No.' }),
      ).toBe(wizard);
    });

    it('refused', () => {
      // The amend dialog's form read, sent on Map columns, answering after a values check began.
      const wizard = after(choose, inspected(), check);
      expect(importStep(wizard, refused('No.')(stale(wizard)))).toBe(wizard);
    });
  });

  it('row 31: an event not listed for its step changes nothing', () => {
    const cases: Array<[ImportWizard, ImportEvent]> = [
      [START, back],
      [START, check],
      [START, confirm],
      [START, reread],
      [reading(), { kind: 'unreadable', sentence: 'No.' }],
      [reading(), reread],
      [onMapping(), choose],
      [onMapping(), confirm],
      [onMappingReading(), reread],
      [onValues(), check],
      [onValues(), reread],
      [onPreview(), check],
      [onPreview(), reread],
      [onDone(), reread],
      [onDone(), choose],
    ];
    for (const [wizard, event] of cases) expect(importStep(wizard, event)).toBe(wizard);
    const answers = (wizard: ImportWizard): ImportEvent[] => [
      inspected()(wizard.token),
      checked()(wizard.token),
      reinspected()(wizard.token),
      imported(wizard.token),
      { kind: 'reviewersRefused', token: wizard.token, sentence: 'No.' },
    ];
    for (const wizard of [START, onMapping(), onPreview(), onDone()]) {
      for (const event of answers(wizard)) expect(importStep(wizard, event)).toBe(wizard);
    }
  });
});

describe('the predicates', () => {
  it('ask before leaving on Map columns, during the check and on Preview alone', () => {
    const asks = [
      START,
      reading(),
      onMapping(),
      onMappingReading(),
      onValues(),
      onPreview(),
      onImporting(),
      onDone(),
    ].map((wizard) => asksBeforeLeaving(wizard.step));
    expect(asks).toEqual([false, false, true, true, true, true, false, false]);
  });

  it('offer the values check on Map columns with nothing out', () => {
    expect(
      [onMapping(), onMappingReading(), onValues(), onPreview()].map((w) => mayCheck(w.step)),
    ).toEqual([true, false, false, false]);
  });
});

describe('inspectionFrom', () => {
  it('seeds every column and grid as ignored, then the suggested mapping', () => {
    const { mapping } = INSPECTED;
    expect(mapping.columnTarget).toEqual({ 0: 'applicant_email', 1: '', 2: '', 3: '' });
    expect(mapping.groupTarget).toEqual({ Days: '' });
    expect(mapping.splitStems).toEqual(new Set());
    expect(mapping.resolutions).toEqual({});
  });

  it('restores a saved mapping by grid or first column, over the suggested one', () => {
    const { inspection, mapping } = inspectionFrom({
      headers: ['Email', 'Tier', 'Days [Sat]', 'Days [Sun]'],
      groups: [{ stem: 'Days', columns: [2, 3], options: ['Sat', 'Sun'] }],
      suggestedMapping: { applicant_email: 0, tier: 0 },
      restoredMapping: { tier: [1], available_dates: [2, 3], applicant_email: [0] },
      hasSavedMapping: true,
      savedMappingFrom: 'start',
    });
    expect(mapping.columnTarget).toEqual({ 0: 'applicant_email', 1: 'tier', 2: '', 3: '' });
    expect(mapping.groupTarget).toEqual({ Days: 'available_dates' });
    expect(inspection.restoredTargets).toEqual(
      new Set(['tier', 'available_dates', 'applicant_email']),
    );
    expect(inspection.hasSavedMapping).toBe(true);
    expect(inspection.savedMappingFrom).toBe('start');
  });

  it('reads a grid restored to fewer of its columns as its first column alone', () => {
    const { mapping } = inspectionFrom({
      headers: ['Days [Sat]', 'Days [Sun]'],
      groups: [{ stem: 'Days', columns: [0, 1], options: ['Sat', 'Sun'] }],
      restoredMapping: { available_dates: [0] },
    });
    expect(mapping.groupTarget).toEqual({ Days: '' });
    expect(mapping.columnTarget[0]).toBe('available_dates');
  });

  it('reads a restored null resolution as ignored, and keeps them as where it started', () => {
    const { inspection, mapping } = inspectionFrom({
      headers: ['Tier'],
      restoredResolutions: { tier: { Gld: 'Gold', Other: null } },
    });
    expect(mapping.resolutions).toEqual({ tier: { Gld: 'Gold', Other: IGNORE_VALUE } });
    expect(inspection.startedResolutions).toEqual(mapping.resolutions);
  });

  it('defaults an answer that says nothing', () => {
    const { inspection } = inspectionFrom({});
    expect(inspection).toEqual({
      headers: [],
      sampleValues: [],
      rowCount: 0,
      targets: [],
      groups: [],
      hasSavedMapping: false,
      savedMappingFrom: 'import',
      ordersBySubmittedAt: false,
      commaBearingTargets: new Set(),
      restoredMissing: [],
      newHeaders: [],
      restoredTargets: new Set(),
      startedResolutions: {},
    });
  });
});

describe('mappingBody and resolutionsBody', () => {
  it('leave out an ignored column and the "nowhere to go" sentinel', () => {
    const mapping = {
      ...INSPECTED.mapping,
      columnTarget: { 0: 'applicant_email', 1: NEEDS_A_FIELD, 2: '', 3: '' },
    };
    expect(mappingBody(INSPECTED.inspection, mapping)).toEqual({ applicant_email: 0 });
  });

  it('send a grid by its columns, and a split grid by its columns one by one', () => {
    const grid = { ...INSPECTED.mapping, groupTarget: { Days: 'available_dates' } };
    expect(mappingBody(INSPECTED.inspection, grid)).toEqual({
      applicant_email: 0,
      available_dates: [2, 3],
    });
    const split = {
      ...INSPECTED.mapping,
      columnTarget: { 0: 'applicant_email', 1: '', 2: 'sat', 3: '' },
      splitStems: new Set(['Days']),
      groupTarget: {},
    };
    expect(mappingBody(INSPECTED.inspection, split)).toEqual({ applicant_email: 0, sat: 2 });
    // A grid still whole sends no column of its own.
    expect(mappingBody(INSPECTED.inspection, { ...split, splitStems: new Set() })).toEqual({
      applicant_email: 0,
    });
  });

  it('send an ignored value as null and leave out an unsettled one', () => {
    const mapping = {
      ...INSPECTED.mapping,
      resolutions: { tier: { Gld: 'Gold', Other: IGNORE_VALUE, Unsure: '' } },
    };
    expect(resolutionsBody(mapping)).toEqual({ tier: { Gld: 'Gold', Other: null } });
  });
});

describe('keepDecisions', () => {
  it('keeps a column target set, a grid target, and the resolutions, over the fresh mapping', () => {
    const fresh = inspectionFrom({
      headers: ['Email', 'Tier', 'Days [Sat]', 'Days [Sun]'],
      groups: [{ stem: 'Days', columns: [2, 3], options: ['Sat', 'Sun'] }],
      suggestedMapping: { applicant_email: 0 },
      restoredResolutions: { tier: { Old: 'Gold' } },
    });
    const kept = {
      columnTarget: { 0: '', 1: 'tier', 2: '', 3: '' },
      groupTarget: { Days: 'available_dates' },
      splitStems: new Set<string>(),
      resolutions: { tier: { Gld: 'Gold' } },
    };
    expect(keepDecisions(fresh.mapping, kept, fresh.inspection)).toEqual({
      columnTarget: { 0: 'applicant_email', 1: 'tier', 2: '', 3: '' },
      groupTarget: { Days: 'available_dates' },
      splitStems: new Set(),
      resolutions: { tier: { Gld: 'Gold' } },
    });
  });

  it('drops a split stem the new inspection no longer has as a grid', () => {
    const fresh = inspectionFrom({ headers: ['Days [Sat]', 'Days [Sun]'] });
    const kept = { ...fresh.mapping, splitStems: new Set(['Days']) };
    expect(keepDecisions(fresh.mapping, kept, fresh.inspection).splitStems).toEqual(new Set());
  });
});

describe('dryRunFrom and resultFrom', () => {
  it('default every field the answer leaves out', () => {
    expect(dryRunFrom({})).toEqual({
      unmatched: [],
      decided: [],
      validRows: 0,
      failures: [],
      newRows: 0,
      updatedRows: 0,
      unchangedRows: 0,
      keptVerdicts: 0,
      samples: [],
      rejected: [],
      absentApplications: 0,
      absentEmails: [],
      returningToReview: 0,
      returningEmails: [],
      repeats: [],
    });
  });

  it('say the market entered Review only when the first import moved it there', () => {
    expect(resultFrom({ phase: MarketPhase.Applications }, true).enteredReview).toBe(true);
    expect(resultFrom({ phase: MarketPhase.Applications }, false).enteredReview).toBe(false);
    expect(resultFrom({ phase: MarketPhase.Draft }, true).enteredReview).toBe(false);
    expect(resultFrom({}, true)).toMatchObject({ created: 0, importedFirst: true });
  });
});
