import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve as resolvePath } from 'node:path';

/**
 * Every dialog that writes holds through its write by its submission, and a dialog added later
 * cannot quietly skip it (T411).
 *
 * The hold was opt-in: 14 of the 38 files drawing `AppDialog` passed `closeDisabled`, 12 of them
 * while writing, so the others could be closed while a write was out and its answer landed in the
 * next opening. Now `AppDialog` derives the hold from a `useDialogSubmit` handle passed as
 * `submission`, and this test keeps every writing dialog on it.
 *
 * A dialog's writing cannot be read from its source, so the rule is kept by two lists: every file
 * under `src/` (outside `dev/`) that draws `<AppDialog` is on exactly one of them, and a new file
 * fails until someone says whether it writes. A writing file says where its handle is made: in the
 * file, or by the parent that writes on its event and hands it down.
 *
 * What it does NOT see, so that the next reader does not assume otherwise:
 *
 * - Whether a handle is the RIGHT one, keyed by the right opening, or wraps the write at all: the
 *   dialog's own test file holds that, with a held-write case.
 * - A dialog drawn by another name or through `<component :is>`: only the literal `<AppDialog` tag.
 * - Attributes are read from the tag's text: a `v-bind="object"` carrying `submission` is unseen,
 *   and would fail here as a dialog with none.
 */

// Resolved from the project root rather than `import.meta.url`, as `modalsHoldThePageInert.test.ts`
// is: vitest transforms this module, so its `import.meta.url` is not a file: URL.
const SRC = resolvePath(process.cwd(), 'src');

type Writer = {
  /** `'here'`, or the parents (paths under `src/`) that make the handle and pass it down. */
  handle: 'here' | readonly string[];
  /** Dialogs of this file that write nothing, by their `testid`, with why. */
  alsoDraws?: Readonly<Record<string, string>>;
};

const WRITES: Readonly<Record<string, Writer>> = {
  'components/RecordPaymentDialog.vue': { handle: 'here' },
  'components/ChangeOwedDialog.vue': { handle: 'here' },
  'components/VendorPaymentTab.vue': { handle: 'here' },
  'components/UpdateInfoDialog.vue': { handle: 'here' },
  'components/VendorDiscordOffer.vue': { handle: 'here' },
  'components/AddVendorDialog.vue': { handle: 'here' },
  'components/GiveRolesDialog.vue': { handle: 'here' },
  'components/market/MarketDiscordCard.vue': { handle: 'here' },
  'views/ManageMarketOverlay.vue': { handle: 'here' },
  'components/MarketPermissions.vue': {
    handle: 'here',
    alsoDraws: {
      'manage-market-permissions':
        'the table; each change is asked, and written, by a confirmation',
    },
  },
  'views/NewMarketOverlay.vue': { handle: 'here' },
  'views/ManageOrgOverlay.vue': { handle: 'here' },
  'components/DeleteOrgDialog.vue': { handle: 'here' },
  'components/OrganizationPermissions.vue': {
    handle: 'here',
    alsoDraws: {
      'manage-org-permissions': 'the table; each change is asked, and written, by a confirmation',
    },
  },
  'views/OrganizationsView.vue': { handle: 'here' },
  'components/application/ApplicationsAll.vue': { handle: 'here' },
  'components/application/ApplicationMonitor.vue': {
    handle: 'here',
    alsoDraws: {
      'choose-highlights':
        'saves as it is changed through `useSavedOnTheMarket`, whose sequence drops a late answer',
    },
  },
  'components/market/OpenApplicationsDialog.vue': { handle: 'here' },
  'components/market/ReviewersPanel.vue': {
    handle: 'here',
    alsoDraws: { 'reviewers-all': 'reads: the whole list of reviewers' },
  },
  'components/application/PublishResults.vue': { handle: 'here' },
  'components/application/AmendFormDialog.vue': { handle: 'here' },
  'components/DoorCodeScreen.vue': { handle: 'here' },
  'components/SignOutEverywhereDialog.vue': { handle: 'here' },
  'components/InvitationsWaiting.vue': { handle: 'here' },

  'components/HandOnMarketDialog.vue': { handle: ['views/ManageMarketOverlay.vue'] },
  'components/application/FollowUpDialog.vue': {
    handle: [
      'components/application/ApplicationsAll.vue',
      'components/application/ApplicationMonitor.vue',
    ],
  },
  'components/layout/LayoutTypeDialog.vue': { handle: ['components/layout/LayoutPanelTypes.vue'] },
  'components/layout/LayoutSaveTypesDialog.vue': {
    handle: ['components/layout/LayoutPanelTypes.vue'],
  },
  'components/layout/LayoutSavedTypesDialog.vue': {
    handle: ['components/layout/LayoutPanelTypes.vue'],
  },
  'components/layout/LayoutFillDialog.vue': { handle: ['components/layout/LayoutEditor.vue'] },
  'components/PlacementDialog.vue': { handle: ['views/ResultView.vue'] },
};

const WRITES_NOTHING: Readonly<Record<string, string>> = {
  'components/AssignmentHistoryDialog.vue': 'reads the assignment history',
  'components/DiscordRoleReport.vue': 'reads who has the role',
  'components/UnsavedWorkDialog.vue': 'answers its asker, which does the dropping',
  'components/elements/ElementLocationSetup.vue': 'answers locally; the setup saves the location',
  'views/StartFromCsvView.vue': 'answers locally; the import writes after it',
  'components/layout/LayoutExportDialog.vue': 'draws a PNG, held by `closeDisabled`',
  'components/layout/LayoutView.vue':
    "Layout settings: its table types' dialogs write by their own submissions, and Replace the " +
    'image and Recalibrate close it before the page starts either',
  'components/ExportVendorsForm.vue': 'downloads a file, held by `closeDisabled`',
  'components/PhaseRail.vue':
    'its confirmations close before the move is sent, and the rail holds the move',
};

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return vueFiles(full);
    return full.endsWith('.vue') ? [full] : [];
  });
}

function source(file: string): string {
  return readFileSync(join(SRC, file), 'utf-8');
}

/** Each opening tag `<name ...>`, read to its closing `>` outside quotes (`=>` sits in quotes). */
function openingTags(text: string, name: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(new RegExp(`<${name}(?=[\\s/>])`, 'g'))) {
    let quote = '';
    for (let i = match.index; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        tags.push(text.slice(match.index, i + 1));
        break;
      }
    }
  }
  return tags;
}

const hasSubmission = (tag: string) => /\s(?::|v-bind:)submission=/.test(tag);
const hasCloseDisabled = (tag: string) =>
  /\s(?::|v-bind:)?(?:close-disabled|closeDisabled)(?=[\s=/>])/.test(tag);
const testidOf = (tag: string) => /\stestid="([^"]+)"/.exec(tag)?.[1] ?? '(no static testid)';
/** A CALL, not a mention: a dialog handed its handle imports the type by the same name. */
const makesAHandle = (text: string) => /\buseDialogSubmit\s*\(/.test(text);

/** Every `.vue` under `src/`, outside the dev-only library, that draws `<AppDialog`. */
const drawing = vueFiles(SRC)
  .map((full) => relative(SRC, full))
  .filter((file) => !file.startsWith('dev/'))
  .filter((file) => openingTags(source(file), 'AppDialog').length > 0)
  .sort();

const parents = [
  ...new Set(
    Object.values(WRITES).flatMap((writer) => (writer.handle === 'here' ? [] : writer.handle)),
  ),
];
const makers = [
  ...Object.entries(WRITES)
    .filter(([, writer]) => writer.handle === 'here')
    .map(([file]) => file),
  ...parents,
];

describe('every writing dialog uses the submission', () => {
  it('finds the files that draw AppDialog, so the rules below are not passing on an empty list', () => {
    expect(drawing.length).toBeGreaterThanOrEqual(30);
  });

  it('has every file that draws AppDialog on exactly one list', () => {
    const neither = drawing.filter((file) => !(file in WRITES) && !(file in WRITES_NOTHING));
    const both = drawing.filter((file) => file in WRITES && file in WRITES_NOTHING);
    expect(
      neither,
      'a file draws AppDialog and nobody has said whether it writes: put it on WRITES, with where ' +
        'its useDialogSubmit handle is made, or on WRITES_NOTHING, with why',
    ).toEqual([]);
    expect(both, 'a file is on both lists').toEqual([]);
  });

  it('lists no file that has gone or no longer draws AppDialog', () => {
    const stale = [...Object.keys(WRITES), ...Object.keys(WRITES_NOTHING)].filter(
      (file) => !drawing.includes(file),
    );
    const goneParents = parents.filter((file) => !existsSync(join(SRC, file)));
    expect(stale, 'listed but drawing no AppDialog (moved, renamed or deleted)').toEqual([]);
    expect(goneParents, 'a listed handle maker no longer exists').toEqual([]);
  });

  it('hands every dialog of a writing file its submission, and holds none by close-disabled', () => {
    const without: string[] = [];
    const closeDisabled: string[] = [];
    const staleExceptions: string[] = [];
    for (const [file, writer] of Object.entries(WRITES)) {
      if (!drawing.includes(file)) continue;
      const tags = openingTags(source(file), 'AppDialog');
      const exceptions = writer.alsoDraws ?? {};
      for (const tag of tags) {
        const testid = testidOf(tag);
        if (!hasSubmission(tag) && !(testid in exceptions)) without.push(`${file} (${testid})`);
        if (hasCloseDisabled(tag)) closeDisabled.push(`${file} (${testid})`);
      }
      const drawn = tags.map(testidOf);
      for (const testid of Object.keys(exceptions)) {
        if (!drawn.includes(testid)) staleExceptions.push(`${file} (${testid})`);
      }
    }
    expect(
      without,
      'a writing dialog with no `:submission` can be closed while its write is out, and its ' +
        'answer lands in its next opening; a dialog of this file that writes nothing goes in ' +
        'its `alsoDraws`, with why',
    ).toEqual([]);
    expect(
      closeDisabled,
      'a writing dialog holds by its submission, never by `close-disabled`',
    ).toEqual([]);
    expect(staleExceptions, 'an `alsoDraws` names a dialog the file no longer draws').toEqual([]);
  });

  it('has every handle maker make its handle with useDialogSubmit', () => {
    const missing = makers
      .filter((file) => existsSync(join(SRC, file)))
      .filter((file) => !makesAHandle(source(file)));
    expect(missing, 'a listed handle maker does not call useDialogSubmit').toEqual([]);
  });

  it("has each parent hand its dialog the submission on the dialog's tag", () => {
    const unhanded: string[] = [];
    for (const [file, writer] of Object.entries(WRITES)) {
      if (writer.handle === 'here') continue;
      const name = basename(file, '.vue');
      for (const parent of writer.handle) {
        if (!existsSync(join(SRC, parent))) continue;
        const tags = openingTags(source(parent), name);
        if (tags.length === 0 || !tags.every(hasSubmission)) unhanded.push(`${parent} -> ${name}`);
      }
    }
    expect(unhanded, 'a parent draws its dialog without handing it `:submission`').toEqual([]);
  });

  it('has no file listed as writing nothing make a submission', () => {
    const writing = Object.keys(WRITES_NOTHING)
      .filter((file) => drawing.includes(file))
      .filter((file) => {
        const text = source(file);
        return makesAHandle(text) || openingTags(text, 'AppDialog').some(hasSubmission);
      });
    expect(writing, 'a file on WRITES_NOTHING makes a submission: move it to WRITES').toEqual([]);
  });
});
