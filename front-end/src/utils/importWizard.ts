/**
 * The CSV import's wizard: its steps, and the one function that moves between them (T419).
 *
 * The page's step used to be one string beside about fifty refs, written in five places, with one
 * `busy` flag for four of its six requests. So an answer could land on a step it was not sent from:
 * Back pressed under the values check started over, and the check's late answer then opened Preview
 * with no file, whose Import posted an empty one (T277 probe 6).
 *
 * Each step now carries exactly what it stands on, so Preview cannot exist without the file, the
 * mapping and the values check it was opened from, and Import posts the file and the mapping the
 * preview was computed for. The wizard's token moves on whenever the step changes kind, and at a new
 * file, a re-read and a reset; every request carries the token it was sent with, and an answer whose
 * token is no longer the wizard's is dropped, whatever step it finds.
 *
 * Pure: the view holds the requests and dispatches their answers here (`CsvImportView.vue`).
 */
import { IGNORE_VALUE } from '@/utils/valueFixes';
import { MarketPhase } from '@/assets/types/datatypes';

/**
 * Sentinel for "I want this column and there is no target for it". Not a mapping - it never
 * reaches the server - it is the ledger's way of explaining the dead end rather than leaving the
 * organizer to conclude the import is broken.
 */
export const NEEDS_A_FIELD = '__needs_a_field__';

export interface ImportTarget {
  key: string;
  label: string;
  required: boolean;
  kind: 'identity' | 'essential' | 'custom' | 'meta';
}

/** Several columns that are one question: a Google Forms checkbox or multiple-choice grid. */
export interface ColumnGroup {
  stem: string;
  columns: number[];
  options: string[];
}

/** A cell value that names nothing this market offers, and how many rows carry it. */
export interface UnmatchedValue {
  target: string;
  targetLabel: string;
  value: string;
  rows: number;
  offered: string[];
}

/** A value a saved decision settles, with that decision: listed so it can be changed. */
export interface DecidedValue extends UnmatchedValue {
  choice: string | null;
}

/** A row of the file as the dry run says it will be stored, and why a rule rejects it, if one does. */
export interface PreviewRow {
  row: number;
  email: string;
  formData: Record<string, unknown> | null;
  reason?: string;
}

/** A row the import skips, and why: what `ImportRefusedRows` lists. */
export interface RefusedRow {
  row: number;
  /** Empty on a row that names nobody, as a blank row does. */
  email: string;
  error: string;
}

/** An earlier submission, replaced by the same applicant's later row in the file. */
export interface ImportRepeat {
  row: number;
  email: string;
  latestRow: number;
}

export interface ImportFile {
  name: string;
  content: string;
}

/** What the inspect answer says of the file: never edited, replaced whole by a re-read. */
export interface Inspection {
  headers: string[];
  sampleValues: string[][];
  rowCount: number;
  targets: ImportTarget[];
  groups: ColumnGroup[];
  hasSavedMapping: boolean;
  /**
   * Whose decisions the saved mapping holds: the start of the form, or an earlier import. The first
   * import after a start used to call the start's choices "your last import" (E30/F02/S01).
   */
  savedMappingFrom: 'start' | 'import';
  /** Does this market order vendors by when they applied? Decides the rail's warning. */
  ordersBySubmittedAt: boolean;
  /**
   * Targets whose own option labels contain commas, as the server reports them.
   *
   * A checkbox question exports one column holding the selected labels comma-joined, and throws the
   * separator information away before writing the file. When the labels themselves contain commas,
   * nothing can recover which separator was which - so a single column mapped to one of these
   * produces fragments, and the organizer is owed the reason rather than a list of values that
   * "did not match your market".
   */
  commaBearingTargets: ReadonlySet<string>;
  restoredMissing: Array<{ target: string; missingHeaders: string[] }>;
  newHeaders: string[];
  /** A previous import's decisions, re-applied to this file: the targets it restored. */
  restoredTargets: ReadonlySet<string>;
  /** The resolutions the saved mapping arrived with, to tell its decisions from the organizer's. */
  startedResolutions: Record<string, Record<string, string>>;
}

/** The organizer's decisions: what Map columns edits, and what the check and the import post. */
export interface ImportMapping {
  /** Column index -> target key. The ledger is column-driven, so this is its natural direction. */
  columnTarget: Record<number, string>;
  /** Group stem -> target key: a grid is mapped once, for all of its columns at a time. */
  groupTarget: Record<string, string>;
  /** Stems the organizer has broken apart, when the detection guessed wrong. */
  splitStems: ReadonlySet<string>;
  /** target -> raw value -> the market's own name for it, or `IGNORE_VALUE`. */
  resolutions: Record<string, Record<string, string>>;
}

/** The values check's answer (`/import/preview`), every field defaulted. */
export interface DryRun {
  unmatched: UnmatchedValue[];
  /** The file's values a decision already settles - restored, saved by the proposal, or made here. */
  decided: DecidedValue[];
  /** What the dry run said would import, and what it said would be skipped. */
  validRows: number;
  failures: RefusedRow[];
  /** How the file lands against what is already here. */
  newRows: number;
  updatedRows: number;
  unchangedRows: number;
  /** Updated applications already decided that the import leaves at their verdict. */
  keptVerdicts: number;
  samples: PreviewRow[];
  rejected: PreviewRow[];
  absentApplications: number;
  absentEmails: string[];
  returningToReview: number;
  returningEmails: string[];
  /** Rows the file holds more than once for one applicant: each applicant is one application. */
  repeats: ImportRepeat[];
}

/** What the import wrote. */
export interface ImportResult {
  created: number;
  updated: number;
  /** Applications already here whose answers this file does not change: nothing is written. */
  unchanged: number;
  /** How many the market's automatic rejections rejected (E33/F03/S02). */
  rejectedByRules: number;
  failures: RefusedRow[];
  repeats: ImportRepeat[];
  /**
   * Whether the import was the market's first, as it was when it began: the import moves the market
   * into Review, so the market reads as past its first import by the done step.
   */
  importedFirst: boolean;
  /** The market entered Review with this import. */
  enteredReview: boolean;
}

interface OnFile {
  file: ImportFile;
  inspection: Inspection;
  mapping: ImportMapping;
}

type PreviewStep = OnFile & {
  kind: 'preview';
  values: DryRun;
  refusal: string;
  reviewersRefusal: string;
};

/**
 * Where the import stands. `upload` is Upload, `reading` the file whose inspect is out; `mapping` is
 * Map columns, `reading` the re-read after a form change; `values` is Map columns with the values
 * check out; `preview` is Preview; `importing` is Preview with the reviewers write and the import
 * out, holding its preview whole, since a refused import returns to it; `done` is the done step.
 */
export type ImportStep =
  | { kind: 'upload'; reading: ImportFile | null; refusal: string }
  | (OnFile & { kind: 'mapping'; values: DryRun | null; reading: boolean; refusal: string })
  | (OnFile & { kind: 'values'; values: DryRun | null })
  | PreviewStep
  | { kind: 'importing'; from: PreviewStep }
  | { kind: 'done'; fileName: string; result: ImportResult };

export interface ImportWizard {
  step: ImportStep;
  token: number;
}

/** A change the organizer makes on Map columns. */
export type MappingEdit =
  | { kind: 'map'; column: number; target: string }
  | { kind: 'mapGroup'; stem: string; target: string }
  | { kind: 'split'; stem: string }
  | { kind: 'resolve'; target: string; value: string; choice: string };

export type ImportEvent =
  | { kind: 'choose'; file: ImportFile }
  | { kind: 'unreadable'; sentence: string }
  | {
      kind: 'inspected';
      token: number;
      inspection: Inspection;
      mapping: ImportMapping;
      values: DryRun | null;
    }
  | MappingEdit
  | { kind: 'check' }
  | { kind: 'checked'; token: number; values: DryRun }
  | { kind: 'reread' }
  | {
      kind: 'reinspected';
      token: number;
      inspection: Inspection;
      mapping: ImportMapping;
      values: DryRun | null;
    }
  | { kind: 'back' }
  | { kind: 'confirm' }
  | { kind: 'imported'; token: number; result: ImportResult }
  | { kind: 'reviewersRefused'; token: number; sentence: string }
  | { kind: 'refused'; token: number; sentence: string }
  | { kind: 'reset' };

export const START: ImportWizard = {
  step: { kind: 'upload', reading: null, refusal: '' },
  token: 0,
};

/** Back is offered: Map columns with nothing out starts over, Preview returns to Map columns. */
export function mayGoBack(step: ImportStep): boolean {
  return (step.kind === 'mapping' && !step.reading) || step.kind === 'preview';
}

/**
 * Map columns with nothing out: the values check may be sent, and so may the amend dialog's form
 * read, whose answer would otherwise land inside a step whose own request is still out.
 */
export function mayCheck(step: ImportStep): boolean {
  return step.kind === 'mapping' && !step.reading;
}

/** Import may be pressed: Preview with a row to import. */
export function mayConfirm(step: ImportStep): boolean {
  return step.kind === 'preview' && step.values.validRows > 0;
}

/**
 * A file read and nothing of it written: on Map columns and Preview the mapping and every value
 * settled live in the page alone until the final confirm, so leaving asks first (T271). Upload
 * holds no file and the done step has written it; nor does an import already running ask, since
 * leaving does not stop it.
 */
export function asksBeforeLeaving(step: ImportStep): boolean {
  return step.kind === 'mapping' || step.kind === 'values' || step.kind === 'preview';
}

/** The next wizard; the same object when the event is refused or answers another step. */
export function importStep(wizard: ImportWizard, event: ImportEvent): ImportWizard {
  // Row 30: an answer for another step, or another stay on this one, is dropped.
  if ('token' in event && event.token !== wizard.token) return wizard;
  // Row 29.
  if (event.kind === 'reset') return { step: START.step, token: wizard.token + 1 };
  const next = nextStep(wizard.step, event);
  if (next === null) return wizard;
  return { step: next.step, token: next.moves ? wizard.token + 1 : wizard.token };
}

/** The step an event leads to, and whether the token moves; null when the event changes nothing. */
function nextStep(
  step: ImportStep,
  event: ImportEvent,
): { step: ImportStep; moves: boolean } | null {
  const to = (next: ImportStep, moves = next.kind !== step.kind) => ({ step: next, moves });
  switch (step.kind) {
    case 'upload':
      if (event.kind === 'choose' && !step.reading)
        return to({ kind: 'upload', reading: event.file, refusal: '' }, true); // row 1
      if (event.kind === 'unreadable' && !step.reading)
        return to({ ...step, refusal: event.sentence }); // row 3
      if (event.kind === 'inspected' && step.reading)
        return to({
          kind: 'mapping',
          file: step.reading,
          inspection: event.inspection,
          mapping: event.mapping,
          values: event.values,
          reading: false,
          refusal: '',
        }); // row 4
      if (event.kind === 'refused' && step.reading)
        return to({ kind: 'upload', reading: null, refusal: event.sentence }); // row 5
      return null; // rows 2, 27 and 31

    case 'mapping':
      if (isEdit(event)) return to({ ...step, mapping: edited(step.mapping, event) }); // row 6
      if (step.reading) {
        if (event.kind === 'reinspected')
          return to({
            ...step,
            inspection: event.inspection,
            mapping: keepDecisions(event.mapping, step.mapping, event.inspection),
            values: event.values,
            reading: false,
          }); // row 15
        if (event.kind === 'refused')
          return to({ ...step, reading: false, refusal: event.sentence }); // row 16
        return null; // rows 9 and 18
      }
      if (event.kind === 'check')
        return to({
          kind: 'values',
          file: step.file,
          inspection: step.inspection,
          mapping: step.mapping,
          values: step.values,
        }); // row 8
      if (event.kind === 'refused') return to({ ...step, refusal: event.sentence }); // row 13
      if (event.kind === 'reread') return to({ ...step, reading: true, refusal: '' }, true); // row 14
      if (event.kind === 'back') return to(START.step); // row 17: Start over
      return null;

    case 'values': {
      const onMapping = (
        values: DryRun | null,
        refusal: string,
        mapping = step.mapping,
      ): ImportStep => ({
        kind: 'mapping',
        file: step.file,
        inspection: step.inspection,
        mapping,
        values,
        reading: false,
        refusal,
      });
      // Row 7: a change withdraws the check, whose answer was for the mapping before it.
      if (isEdit(event)) return to(onMapping(step.values, '', edited(step.mapping, event)));
      if (event.kind === 'checked') {
        if (event.values.unmatched.length) return to(onMapping(event.values, '')); // row 11
        return to({
          kind: 'preview',
          file: step.file,
          inspection: step.inspection,
          mapping: step.mapping,
          values: event.values,
          refusal: '',
          reviewersRefusal: '',
        }); // row 10
      }
      if (event.kind === 'refused') return to(onMapping(step.values, event.sentence)); // row 12
      return null; // row 19
    }

    case 'preview':
      if (event.kind === 'back')
        return to({
          kind: 'mapping',
          file: step.file,
          inspection: step.inspection,
          mapping: step.mapping,
          values: step.values,
          reading: false,
          refusal: '',
        }); // row 20
      if (event.kind === 'confirm' && mayConfirm(step))
        return to({ kind: 'importing', from: { ...step, refusal: '', reviewersRefusal: '' } }); // row 21
      return null; // rows 22 and 27

    case 'importing':
      if (event.kind === 'imported')
        return to({ kind: 'done', fileName: step.from.file.name, result: event.result }); // row 23
      if (event.kind === 'refused') return to({ ...step.from, refusal: event.sentence }); // row 24
      if (event.kind === 'reviewersRefused')
        return to({ ...step.from, reviewersRefusal: event.sentence }); // row 25
      return null; // row 26

    case 'done':
      return null; // rows 27 and 28
  }
}

function isEdit(event: ImportEvent): event is MappingEdit {
  return (
    event.kind === 'map' ||
    event.kind === 'mapGroup' ||
    event.kind === 'split' ||
    event.kind === 'resolve'
  );
}

/** The mapping with one edit applied, in new objects: the old mapping is never changed. */
function edited(mapping: ImportMapping, edit: MappingEdit): ImportMapping {
  switch (edit.kind) {
    case 'map':
      return { ...mapping, columnTarget: { ...mapping.columnTarget, [edit.column]: edit.target } };
    case 'mapGroup':
      return { ...mapping, groupTarget: { ...mapping.groupTarget, [edit.stem]: edit.target } };
    case 'split': {
      const groupTarget = { ...mapping.groupTarget };
      delete groupTarget[edit.stem];
      return { ...mapping, groupTarget, splitStems: new Set([...mapping.splitStems, edit.stem]) };
    }
    case 'resolve':
      return {
        ...mapping,
        resolutions: {
          ...mapping.resolutions,
          [edit.target]: { ...(mapping.resolutions[edit.target] ?? {}), [edit.value]: edit.choice },
        },
      };
  }
}

/**
 * The organizer's decisions carried over a re-read after the form changed (E20/F03/S01).
 *
 * Re-inspecting is what picks up a new custom field as a target and drops a question that was
 * turned off, and it rebuilds the mapping from scratch; the decisions are kept by column index and
 * group stem, both of which are properties of the FILE - and the file is the one thing that did not
 * change. A kept column target wins where it is not '', kept grid targets spread over the fresh
 * ones, kept resolutions replace the fresh, and a grid split apart stays split while the file still
 * has it.
 */
export function keepDecisions(
  fresh: ImportMapping,
  kept: ImportMapping,
  inspection: Inspection,
): ImportMapping {
  const columnTarget = { ...fresh.columnTarget };
  for (const [index, target] of Object.entries(kept.columnTarget)) {
    if (target) columnTarget[Number(index)] = target;
  }
  const stems = new Set(inspection.groups.map((group) => group.stem));
  const splitStems = new Set([
    ...fresh.splitStems,
    ...[...kept.splitStems].filter((stem) => stems.has(stem)),
  ]);
  const groupTarget = { ...fresh.groupTarget, ...kept.groupTarget };
  for (const stem of splitStems) delete groupTarget[stem];
  return { columnTarget, groupTarget, splitStems, resolutions: { ...kept.resolutions } };
}

/** The inspect answer as the server sends it (`csv_import.inspect`). */
export interface InspectAnswer {
  headers?: string[];
  sampleValues?: string[][];
  rowCount?: number;
  targets?: ImportTarget[];
  groups?: ColumnGroup[];
  suggestedMapping?: Record<string, number>;
  restoredMapping?: Record<string, number[]>;
  restoredResolutions?: Record<string, Record<string, string | null>>;
  restoredTargetsMissingColumns?: Array<{ target: string; missingHeaders: string[] }>;
  newHeaders?: string[];
  hasSavedMapping?: boolean;
  savedMappingFrom?: string;
  ordersBySubmittedAt?: boolean;
  commaBearingTargets?: string[];
}

/** The inspect answer, read into what the file is and the mapping Map columns opens with. */
export function inspectionFrom(data: InspectAnswer | null | undefined): {
  inspection: Inspection;
  mapping: ImportMapping;
} {
  const answer = data ?? {};
  const headers: string[] = answer.headers ?? [];
  const groups: ColumnGroup[] = answer.groups ?? [];
  const restoredMapping = answer.restoredMapping ?? {};

  // Seed every column with '' - the "Ignore this column" option's value. Left undefined, the
  // select matches no option, reports selectedIndex -1 and renders completely blank, so an
  // unmapped column is indistinguishable from one that has not loaded.
  const columnTarget: Record<number, string> = {};
  headers.forEach((_header, index) => {
    columnTarget[index] = '';
  });
  // And every grid with its "Ignore these columns", for the same reason (bug 43): the columns
  // were seeded and the grids were not, so a grid's select read blank until it was chosen.
  const groupTarget: Record<string, string> = Object.fromEntries(
    groups.map((group) => [group.stem, '']),
  );
  for (const [key, index] of Object.entries(answer.suggestedMapping ?? {})) {
    columnTarget[Number(index)] = key;
  }
  // A previous import's decisions win over the auto-detected two: the organizer already said
  // what these columns mean, and re-asking is the friction this remembers them to avoid.
  const groupByFirstColumn = new Map(groups.map((group) => [group.columns[0], group]));
  for (const [key, indexes] of Object.entries(restoredMapping)) {
    const group = groupByFirstColumn.get(indexes[0]);
    if (group && group.columns.length === indexes.length) groupTarget[group.stem] = key;
    else columnTarget[indexes[0]] = key;
  }
  const resolutions: Record<string, Record<string, string>> = Object.fromEntries(
    Object.entries(answer.restoredResolutions ?? {}).map(([target, byValue]) => [
      target,
      Object.fromEntries(
        Object.entries(byValue).map(([value, choice]) => [value, choice ?? IGNORE_VALUE]),
      ),
    ]),
  );

  return {
    inspection: {
      headers,
      sampleValues: answer.sampleValues ?? [],
      rowCount: answer.rowCount ?? 0,
      targets: answer.targets ?? [],
      groups,
      hasSavedMapping: answer.hasSavedMapping === true,
      savedMappingFrom: answer.savedMappingFrom === 'start' ? 'start' : 'import',
      ordersBySubmittedAt: answer.ordersBySubmittedAt === true,
      commaBearingTargets: new Set(answer.commaBearingTargets ?? []),
      restoredMissing: answer.restoredTargetsMissingColumns ?? [],
      newHeaders: answer.newHeaders ?? [],
      restoredTargets: new Set(Object.keys(restoredMapping)),
      startedResolutions: resolutions,
    },
    mapping: { columnTarget, groupTarget, splitStems: new Set(), resolutions },
  };
}

/** Whether the inspect answer restored a mapping, whose values are read before Map columns opens. */
export function restoresAMapping(inspection: Inspection): boolean {
  return inspection.restoredTargets.size > 0;
}

/** The values check's answer, every field defaulted. */
export function dryRunFrom(data: Partial<DryRun> | null | undefined): DryRun {
  const answer = data ?? {};
  return {
    unmatched: answer.unmatched ?? [],
    decided: answer.decided ?? [],
    validRows: answer.validRows ?? 0,
    failures: answer.failures ?? [],
    newRows: answer.newRows ?? 0,
    updatedRows: answer.updatedRows ?? 0,
    unchangedRows: answer.unchangedRows ?? 0,
    keptVerdicts: answer.keptVerdicts ?? 0,
    samples: answer.samples ?? [],
    rejected: answer.rejected ?? [],
    absentApplications: answer.absentApplications ?? 0,
    absentEmails: answer.absentEmails ?? [],
    returningToReview: answer.returningToReview ?? 0,
    returningEmails: answer.returningEmails ?? [],
    repeats: answer.repeats ?? [],
  };
}

/** The import's answer; `first` is whether it was the market's first import when Import was pressed. */
export function resultFrom(
  data:
    | (Partial<Omit<ImportResult, 'importedFirst' | 'enteredReview'>> & { phase?: string })
    | null
    | undefined,
  first: boolean,
): ImportResult {
  const answer = data ?? {};
  return {
    created: answer.created ?? 0,
    updated: answer.updated ?? 0,
    unchanged: answer.unchanged ?? 0,
    rejectedByRules: answer.rejectedByRules ?? 0,
    failures: answer.failures ?? [],
    repeats: answer.repeats ?? [],
    importedFirst: first,
    enteredReview: first && answer.phase === MarketPhase.Applications,
  };
}

/** The grids still read as one question: those not split apart. */
export function activeGroups(inspection: Inspection, mapping: ImportMapping): ColumnGroup[] {
  return inspection.groups.filter((group) => !mapping.splitStems.has(group.stem));
}

/** The mapping as the server takes it: target -> a column, or a grid's columns. */
export function mappingBody(
  inspection: Inspection,
  mapping: ImportMapping,
): Record<string, number | number[]> {
  const grids = activeGroups(inspection, mapping);
  const grouped = new Set(grids.flatMap((group) => group.columns));
  const body: Record<string, number | number[]> = {};
  for (const [index, key] of Object.entries(mapping.columnTarget)) {
    if (!key || key === NEEDS_A_FIELD) continue;
    if (!grouped.has(Number(index))) body[key] = Number(index);
  }
  for (const group of grids) {
    const key = mapping.groupTarget[group.stem];
    if (key) body[key] = group.columns;
  }
  return body;
}

/** Values the organizer has spoken for, in the shape the back end expects (null means ignore). */
export function resolutionsBody(
  mapping: ImportMapping,
): Record<string, Record<string, string | null>> {
  const out: Record<string, Record<string, string | null>> = {};
  for (const [target, byValue] of Object.entries(mapping.resolutions)) {
    out[target] = {};
    for (const [value, choice] of Object.entries(byValue)) {
      if (choice !== '') out[target][value] = choice === IGNORE_VALUE ? null : choice;
    }
  }
  return out;
}
