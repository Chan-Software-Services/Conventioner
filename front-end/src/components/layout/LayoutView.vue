<script setup lang="ts">
/**
 * A location's layout, its page (T257): `/markets/:marketId/layout/:locationId`, under the Market
 * Setup tab, in the market's frame like every market page.
 *
 * The head row says where it is and how it stands: "Layout", the switch between the market's
 * named locations (each a link to its own address), the save state and the scale ("36.0 m
 * across", or "Not calibrated"), "Export PNG" once the layout has a scale, for anyone who reads it
 * (`LayoutExportDialog.vue`, `exportLayoutPng.ts`), and the way back to Market Setup. Below it the map column and the
 * side panel, the panel going under the map with less than 1100px of room.
 *
 * A location's layout begins with its floorplan: before an image the map column is the upload's
 * drop zone, and its first save (`layoutSave.ts`) is the layout's start, which the server answers
 * with the layout as stored; before a scale it is the calibration over the image
 * (`LayoutCalibration.vue`), and Recalibrate draws the line again; with a scale it is the layout's
 * drawing (`LayoutMap.vue`): the editor (`LayoutEditor.vue`) for someone who may change the
 * layout, at a desk, with the selection's card heading the panel, and the whole hall, read, for
 * anyone else (a Viewer, anyone on an archived market) and at a phone's width, with the card of the
 * table last tapped, pressed or focused (`LayoutPanelTable.vue`) heading the panel. A phone, 640px
 * and below, only reads: no upload, no scale, no edit, the map pinched and dragged by hand, the
 * Floorplan card left out and a hint saying how to read it, under the sections. Past Draft the
 * editor of a layout started in Draft stays under the setup-settled sentence, its seats settled:
 * tables still move and turn, and the zones, the image, the scale and the colours still change,
 * while what would add, remove, renumber, re-section or re-type a table is disabled. A location
 * with no layout past Draft offers the upload all the same, and its layout follows the plan (T422,
 * ADR 0034): under the follows-the-plan sentence its tables are added, removed, numbered and put
 * in another section, up to each section's count, which the Sections card counts against, and the
 * selection's card numbers one table by hand; only the table types stay settled.
 * It is drawn over the floor alone while the image is on its way or could not be had, and the
 * panel lists the location's sections in the colours the map draws them in. The page holds the
 * layout's working copy (`useLayoutEditor.ts`): each save names the revision it read, a save over
 * one another tab saved says so with Reload, and the market is re-read through the one store
 * after every answer. A change still waiting is saved before the page is left; when that save did
 * not land, a move in the app asks before it drops the change, and a reload is asked by the browser.
 * While the layout is edited the page holds one polite live region, which says each move, turn,
 * placement and removal the editor or the selection's card made (`layoutAnnouncements.ts`).
 *
 * With no location in the address it opens the market's first named one. A location with no id
 * (a market stored before ids, until its next write) or no name offers no layout.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import type {
  FloorplanObject,
  FloorplanTable,
  LocationObject,
  TableTypeObject,
} from '@/assets/types/datatypes';
import MarketFrame from '@/components/MarketFrame.vue';
import AppDialog from '@/components/AppDialog.vue';
import { api } from '@/utils/api';
import { useOpenMarket } from '@/utils/openMarket';
import { useUnsavedWork } from '@/utils/useUnsavedWork';
import { MarketAction, mayTake } from '@/utils/marketActions';
import { MarketPhase } from '@/assets/types/datatypes';
import { layoutPath, marketPath } from '@/utils/market';
import FloorplanUploader from './FloorplanUploader.vue';
import LayoutCalibration from './LayoutCalibration.vue';
import LayoutEditor from './LayoutEditor.vue';
import LayoutExportDialog from './LayoutExportDialog.vue';
import LayoutMap from './LayoutMap.vue';
import LayoutPanelSections from './LayoutPanelSections.vue';
import LayoutPanelSelection, { type Arrangement } from './LayoutPanelSelection.vue';
import LayoutPanelTable from './LayoutPanelTable.vue';
import LayoutPanelTypes from './LayoutPanelTypes.vue';
import LayoutPanelZones from './LayoutPanelZones.vue';
import LayoutToolCard from './LayoutToolCard.vue';
import { isAdding, type Tool } from './layoutTools';
import { rememberedChoice } from './layoutViewChoices';
import { metresAcross, pxPerMm, type Point } from './calibration';
import {
  NO_TABLE_FITS,
  saidAdded,
  saidArranged,
  saidRetyped,
  saidSectioned,
  saidRemoved,
  saidRowAdded,
  saidTurned,
  saidZoneRemoved,
  useAnnouncements,
} from './layoutAnnouncements';
import { layoutSections } from './layoutDrawing';
import { exportLayoutPng } from './exportLayoutPng';
import { LAYOUT_IS_FULL, placeTables } from './layoutFill';
import { STANDARD_TABLE, hallOf } from './layoutGeometry';
import { lengthMmOf, saidNoLength } from './layoutLength';
import { MAX_LAYOUT_TABLES, rowChoices, rowOnFrom, standingShapes } from './layoutRow';
import { saveLayout, saveLayoutOnUnload, type UploadedFloorplan } from './layoutSave';
import { turnSelection } from './layoutSelection';
import {
  LayoutNotSaved,
  listSavedTypes,
  saveTableTypes,
  saveTypes,
  tablesOfEachType,
} from './layoutTypes';
import { heldBackSaid, useLayoutEditor } from './useLayoutEditor';
import { useFloorplanImages, type FloorplanImageSource } from './floorplanImages';

const route = useRoute();
const router = useRouter();
const marketId = computed(() => String(route.params.marketId ?? ''));
const locationId = computed(() => String(route.params.locationId ?? ''));
const { market, refresh } = useOpenMarket(marketId);
/** The editor's tool on: any but Select shows its card in place of the selection's. */
const editorTool = ref<Tool>('select');
/** The section and the type the adding tools give a new table, shared by the three, chosen on the
 *  tool's card; the editor starts them at the first of each. */
const toolSectionId = ref<string | null>(null);
const toolTypeId = ref('');
const editorView = ref<InstanceType<typeof LayoutEditor> | null>(null);

/** "Select them" on the Sections card: the tables in no section are selected and the map takes the
 *  focus, so the arrow keys move them at once (D13). */
function selectUnsectioned() {
  editor.select(unsectioned.value.map((table) => table.id));
  void editorView.value?.focusSelection();
}

/** The locations a layout can be opened for: named, and with the id a layout names. */
const locations = computed<(LocationObject & { id: string })[]>(() =>
  (market.value?.setupObject?.locations ?? []).filter(
    (location): location is LocationObject & { id: string } =>
      Boolean(location.id) && location.name.trim() !== '',
  ),
);

const location = computed(() => locations.value.find((l) => l.id === locationId.value) ?? null);

// The market's layout address opens its first location's.
watch(
  [market, locationId],
  () => {
    if (market.value && !locationId.value && locations.value.length) {
      void router.replace(layoutPath(market.value.id, locations.value[0].id));
    }
  },
  { immediate: true },
);

/** Whether this person may change the layout here: the Market Setup row's answer, which refuses
 * everyone on an archived market. */
const editable = computed(() => mayTake(market.value, MarketAction.ChangeSetup));
/** Whether the market has left Draft, so a layout started in Draft has its seats settled: where a
 * table stands still changes, but no table is added, removed, renumbered or given another section
 * or type (`the-setup-settles-on-leaving-draft.md`); a layout started then follows the plan. */
const settled = computed(() => Boolean(market.value?.setupLockReason));
/** Whether the layout follows the plan: started after Draft, it draws the seats the plan settled
 * and numbers them up to each section's count, in any phase (T422, D21). */
const followsPlan = computed(() => Boolean(floorplan.value?.followsPlan));
/** Whether the layout's seats are settled: past Draft, on a layout started in Draft. */
const seatsSettled = computed(() => settled.value && !followsPlan.value);
/** Whether the page says the layout follows the plan: one that does, past Draft, and a location
 * with no layout yet past Draft for someone who may start it here, since the layout they start
 * will; a reader is told the setup is settled. */
const saysFollowsPlan = computed(
  () => followsPlan.value || (settled.value && !floorplan.value && editsHere.value),
);
/** What the page says under its head past Draft, of a layout that follows the plan. */
const FOLLOWS_THE_PLAN =
  "This layout follows the plan: place each section's tables, up to its count. The seats " +
  'themselves are settled.';
/** Whether the market is archived, which its rail says, so the page does not say it is settled. */
const archived = computed(() => market.value?.phase === MarketPhase.Archived);

const stored = computed<FloorplanObject | null>(
  () =>
    (market.value?.setupObject?.floorplans ?? []).find(
      (floorplan) => floorplan.locationId === locationId.value,
    ) ?? null,
);

// ── The working copy and its saves ───────────────────────────────────────────

/** The plan's sections of this location, with the id a table names its section by. */
const ownSections = () =>
  (market.value?.setupObject?.sections ?? []).filter(
    (section) => section.id && section.location?.id === locationId.value,
  );

/** The layout as the page shows and changes it: the server's, and what is not saved yet. A change
 * to the layout's own fields (its start, its image, its scale) is written at once; a change to
 * its tables saves itself (`useLayoutEditor.ts`). Every answer is followed by the market's
 * re-read through the one store. */
const editor = useLayoutEditor({
  save: (layout, revision) => saveLayout(marketId.value, layout, revision),
  saveOnUnload: (layout, revision) => saveLayoutOnUnload(marketId.value, layout, revision),
  onSaved: () => void refresh(),
  draft: () => !settled.value,
  may: () => editable.value,
  tableTypes: () => market.value?.setupObject?.tableTypes ?? [],
  // The location's sections, by which a table whose section is gone is put in no section.
  sectionIds: () => ownSections().map((section) => section.id as string),
  // Their counts in the plan, which a layout that follows it numbers its tables up to.
  counts: () => new Map(ownSections().map((section) => [section.id as string, section.count])),
});
const floorplan = editor.layout;
const saveState = editor.saveState;
const saveMessage = editor.saveMessage;

watch(stored, (held) => editor.adopt(held), { immediate: true });
// Once this person may no longer change the layout here (the market was archived elsewhere, or
// their role went), a change no save stored can never land: it is dropped, with its failed line,
// and the layout shown is the server's, as Market Setup forgets such a plan.
watch(editable, (may) => {
  if (!may && editor.pending()) editor.reload(stored.value);
});
// Once the market leaves Draft with the layout open, a change made in Draft and not stored may
// change a seat, which the server now refuses: it is dropped the same way. And undo forgets its
// steps, since taking one back could put back a table removed or renumbered in Draft.
watch(settled, (now) => {
  if (!now) return;
  if (editor.pending()) editor.reload(stored.value);
  else editor.forgetUndo();
});
watch(locationId, () => {
  readId.value = null;
  editor.reload(stored.value);
  recalibrating.value = false;
  calibrationRefusal.value = '';
  stopReplacing();
});

// A change still waiting is saved before the page is left, for another location's layout or
// another page, and before a phase move, which reads the market as the server holds it.
onBeforeRouteUpdate(async () => {
  await editor.flush();
});
onBeforeRouteLeave(async () => {
  await editor.flush();
});
// Called after the guards above, so its question comes only once that save has been tried: what is
// still unsaved then is a change whose save failed or was refused, which leaving would drop.
useUnsavedWork({
  unsaved: () => editor.pending(),
  sentence: "This layout's last changes are not saved. Leaving drops them.",
});

// ── The floorplans' images ───────────────────────────────────────────────────

/** A floorplan image's bytes, read with the session, since the image is read on its market by
 *  anyone with a role on it (T272). */
async function fetchFloorplanImage(id: string): Promise<Blob> {
  const { data } = await api.get<Blob>(`/floorplans/${encodeURIComponent(id)}`, {
    responseType: 'blob',
  });
  return data;
}

/** The bytes of the replacement's image, once its own loader read them, so the layout that takes
 *  that image draws them as they came rather than asking for them again. */
let replacementBytes: { id: string; blob: Blob } | null = null;

/** Every image the page may draw: each layout's as the market holds it, and the open layout's as
 *  the page holds it, which differs from the market's from a write until its re-read (a first
 *  image, or a replacement). An image leaves once neither names it, and its URL is let go. */
const imageSources = computed<FloorplanImageSource[]>(() => {
  const ids = (market.value?.setupObject?.floorplans ?? []).map((each) => each.imageGridfsId);
  const open = floorplan.value?.imageGridfsId;
  if (open && !ids.includes(open)) ids.push(open);
  return [...new Set(ids.filter((id): id is string => Boolean(id)))].map((id) => ({
    key: id,
    fetch: () => {
      const taken = replacementBytes;
      if (taken?.id !== id) return fetchFloorplanImage(id);
      replacementBytes = null;
      return Promise.resolve(taken.blob);
    },
  }));
});

/** The open location's image: its tables wait for it (`imagePending`), for at most two seconds,
 *  and never stand over another location's (T501). */
const { open: image } = useFloorplanImages(
  imageSources,
  computed(() => floorplan.value?.imageGridfsId),
);
const imageUrl = computed(() => image.value.url);
const imageFailed = computed(() => image.value.failed);

const scaleText = computed(() => metresAcross(floorplan.value) ?? 'Not calibrated');
const calibrated = computed(() => Boolean(floorplan.value?.scalePxPerUnit));
const recalibrating = ref(false);

/** Whether the venue's floorplan is drawn under the tables; unticked, the hall is its floor. */
const showImage = rememberedChoice('showImage', true);
/** Whether it is drawn in greyscale, as it is by default, so the sections' colours are the only
 *  colours; unticked, in its own. A choice of the person viewing, as `showImage` is, kept in their
 *  browser. */
const imageInGrey = rememberedChoice('imageInGrey', true);
/** Whether it is drawn at half strength, as it is by default, so the tables stand out over a busy
 *  plan; unticked, at full strength. A choice of the person viewing, kept in their browser. */
const imageFaded = rememberedChoice('imageFaded', true);
/** Whether the tables wait for the open image: only while it is shown, since unticked the hall is
 *  drawn on its floor and an image still loading holds nothing back. */
const imagePending = computed(() => image.value.pending && showImage.value);
/** Whether the Layout settings dialog is open. */
const settingsOpen = ref(false);

// ── Replacing the image ──────────────────────────────────────────────────────

/**
 * "Replace the image": the upload again, then the scale over the new image, its line started from
 * the old one where it stands on the new image's pixels (the same drawing at another size reads
 * the same), so "Set the scale" alone keeps the hall's size. Only then is the layout written with
 * the new image and its scale, every table keeping its place in millimetres, and the server
 * deletes the old image. Given up, the new image is deleted.
 */
const replacing = ref(false);
const replacement = ref<UploadedFloorplan | null>(null);
/** The replacement's image, under its calibration: a loader of its own, so neither it nor the
 *  layout's lets the other's image go. */
const { open: replacementImage } = useFloorplanImages(
  computed<FloorplanImageSource[]>(() => {
    const id = replacement.value?.gridfs_id;
    if (!id) return [];
    return [
      {
        key: id,
        fetch: async () => {
          const blob = await fetchFloorplanImage(id);
          if (replacement.value?.gridfs_id === id) replacementBytes = { id, blob };
          return blob;
        },
      },
    ];
  }),
  computed(() => replacement.value?.gridfs_id),
);
const replacementUrl = computed(() => replacementImage.value.url);
const replacementFailed = computed(() => replacementImage.value.failed);

/** The old line, on the new image's pixels. */
const carriedLine = computed(() => {
  const old = floorplan.value;
  const next = replacement.value;
  if (!old?.referenceLineStart || !old.referenceLineEnd || !next) return null;
  const across = next.width / (old.imageWidth || next.width);
  const down = next.height / (old.imageHeight || next.height);
  const on = ([x, y]: [number, number]): [number, number] => [x * across, y * down];
  return { start: on(old.referenceLineStart), end: on(old.referenceLineEnd) };
});

/** What the last try to take the new image said, where it was refused or failed. */
const replaceError = ref('');

function startReplacing() {
  recalibrating.value = false;
  calibrationRefusal.value = '';
  dropReplacement();
  replacing.value = true;
}

/** The new image, uploaded and named by nothing, is deleted. */
function dropReplacement() {
  const unused = replacement.value?.gridfs_id;
  replacement.value = null;
  replacementBytes = null;
  replaceError.value = '';
  if (unused) void api.delete(`/floorplans/${encodeURIComponent(unused)}`).catch(() => {});
}

function onReplacement(image: UploadedFloorplan) {
  replacement.value = image;
}

/** Give up the replacement: the new image, uploaded and named by nothing, is deleted. */
function stopReplacing() {
  replacing.value = false;
  dropReplacement();
}
// Left with a replacement in hand, the page gives it up too.
onUnmounted(dropReplacement);

async function onReplacementCalibrated(line: { start: Point; end: Point; lengthMm: number }) {
  const current = floorplan.value;
  const image = replacement.value;
  const scale = pxPerMm(line.start, line.end, line.lengthMm);
  if (!current || !image || scale === null) return;
  const round = (n: number) => Math.round(n * 10) / 10;
  replaceError.value = '';
  const saved = await editor.write(
    {
      ...current,
      imageGridfsId: image.gridfs_id,
      imageWidth: image.width,
      imageHeight: image.height,
      pdfPage: image.page ?? null,
      scalePxPerUnit: scale,
      referenceLineStart: [round(line.start[0]), round(line.start[1])],
      referenceLineEnd: [round(line.end[0]), round(line.end[1])],
      referenceLineLengthMm: line.lengthMm,
    },
    // Not taken, the layout stays on its old image, so giving the new one up deletes nothing in use.
    { rollBack: true, onRefused: (sentence) => (replaceError.value = sentence) },
  );
  if (!saved) return;
  // Taken: the layout names it now, so it is no longer the replacement's to delete.
  replacement.value = null;
  replacing.value = false;
}

/** The location's sections as the map draws them, for the panel's list. */
const sections = computed(() =>
  floorplan.value ? layoutSections(floorplan.value, market.value?.setupObject?.sections ?? []) : [],
);
/** Those sections themselves, which the adding tools put a new table in. */
const ownLaidOutSections = computed(() => sections.value.map(({ section }) => section));

/** The layout's tables in no section: of none, or of one that is gone or another location's. */
const unsectioned = computed(() => {
  const placed = new Set(sections.value.flatMap(({ tables }) => tables.map((table) => table.id)));
  return (floorplan.value?.tables ?? []).filter((table) => !placed.has(table.id));
});

/** What the editor's changes did, in words, for the page's live region. */
const { said, say } = useAnnouncements();

/**
 * The panel's status line: what Fill an area did ("Placed 24 of 30; the rest did not fit."), or
 * why an area could not be closed. It stands until a table is next added or removed, by an undo
 * say, or another location is opened, and is said in the live region by the editor.
 */
const status = ref('');
/** Which tables the layout holds, by their ids: a save's answer brings the same tables back. */
const held = () => (floorplan.value?.tables ?? []).map((table) => table.id).join(' ');
let statusOf = '';
function showStatus(words: string) {
  status.value = words;
  statusOf = held();
}
watch(held, (tables) => {
  if (tables !== statusOf) status.value = '';
});

/** The layout's tables of the ids named, as they stand now. */
function tablesOf(ids: readonly string[]) {
  const named = new Set(ids);
  return (floorplan.value?.tables ?? []).filter((table) => named.has(table.id));
}

/** Duplicate the selection, and select the copies, which the next change is most likely for. */
function duplicateSelection() {
  const copies = editor.duplicate(editor.selection.value);
  if (!copies.length) {
    if (editor.selection.value.length && !tellHeldBack()) say(LAYOUT_IS_FULL);
    return;
  }
  editor.select(copies);
  if (!tellHeldBack()) say(saidAdded(tablesOf(copies), sections.value));
}

/** On a layout that follows the plan, what the last add or change of section held back, on the
 *  status line and in the live region; null when nothing was. */
function tellHeldBack(): string | null {
  const held = heldBackSaid(editor, ownSections());
  if (!held) return null;
  showStatus(held);
  say(held);
  return held;
}

/**
 * "Row of N…": that many more tables of the one selected table's section and type, going on along
 * its line from its end, the gap of Row of tables apart, past what stands in the way and no
 * further than the floorplan. The table stays selected, so "Add row" again goes on from the row's
 * end.
 */
function rowOnFromTheSelection(count: number) {
  const [table] = tablesOf(editor.selection.value);
  const layout = floorplan.value;
  if (!table || !layout || editor.selection.value.length !== 1) return;
  // The gap of Row of tables, as its field reads it: one that is no length lays nothing.
  const gapMm = lengthMmOf(rowChoices.gapCm);
  if (gapMm === null) {
    say(saidNoLength('gap'));
    return;
  }
  const sizeOf = (one: FloorplanTable) =>
    tableTypes.value.find((type) => type.id === one.tableTypeId) ?? STANDARD_TABLE;
  const poses = rowOnFrom(table, sizeOf(table), count, {
    gapMm,
    obstacles: standingShapes(layout, sizeOf),
    hall: hallOf(layout),
  }).slice(0, Math.max(0, MAX_LAYOUT_TABLES - layout.tables.length));
  const ids = editor.addTables(
    poses.map((pose) => ({
      sectionId: table.number === null ? null : table.sectionId,
      tableTypeId: table.tableTypeId,
      xMm: pose.xMm,
      yMm: pose.yMm,
      rotation: pose.rotation,
    })),
  );
  if (!tellHeldBack())
    say(ids.length ? saidRowAdded(tablesOf(ids), sections.value) : NO_TABLE_FITS);
}

function turnTheSelection() {
  turnSelection(editor, tableTypes.value, 90);
  say(saidTurned(tablesOf(editor.selection.value), 90, sections.value));
}

function arrangeSelection(how: Arrangement) {
  if (how === 'across' || how === 'down') editor.distribute(editor.selection.value, how);
  else editor.align(editor.selection.value, how);
  say(saidArranged(tablesOf(editor.selection.value), how));
}

function sectionSelection(sectionId: string | null) {
  const before = tablesOf(editor.selection.value);
  editor.setSection(editor.selection.value, sectionId);
  const section = market.value?.setupObject?.sections.find((one) => one.id === sectionId);
  if (!tellHeldBack()) say(saidSectioned(before, section?.name ?? null, sections.value));
}

/** The Number field: the one selected table's number, swapped with the table that held it. */
function numberSelection(number: number) {
  const [table] = tablesOf(editor.selection.value);
  if (!table || !editor.setNumber(table.id, number)) return;
  const section = ownSections().find((one) => one.id === table.sectionId);
  say(`Numbered ${section?.name ?? 'the table'} ${number}`);
}

function typeSelection(tableTypeId: string) {
  const before = tablesOf(editor.selection.value);
  editor.setType(editor.selection.value, tableTypeId);
  const type = tableTypes.value.find((one) => one.id === tableTypeId);
  if (type) say(saidRetyped(before, type.name, sections.value));
}

function removeSelection() {
  const going = tablesOf(editor.selection.value);
  editor.removeTables(editor.selection.value);
  if (going.length) say(saidRemoved(going, sections.value));
}

/**
 * When the selection empties its card's fields and buttons go, by "Remove" or by an undo that
 * takes the selected tables away (Ctrl+Z after "Duplicate"); the focus one of them held goes to
 * the map's stop, or to the toolbar when no table is left, rather than being lost with it.
 */
watch(
  () => editor.selection.value.length,
  async (now, before) => {
    if (now > 0 || before === 0) return;
    if (!document.activeElement?.closest('[data-testid="layout-panel-selection"]')) return;
    await nextTick();
    if (document.activeElement && document.activeElement !== document.body) return;
    const next =
      document.querySelector<SVGElement>(
        '[data-testid="layout-map"] [data-table-id][tabindex="0"]',
      ) ?? document.querySelector<HTMLElement>('[data-testid="layout-toolbar"] [tabindex="0"]');
    next?.focus();
  },
  { flush: 'pre' },
);

/** The no-table zones card, whose field for a zone just drawn takes the focus. */
const zonesCard = ref<InstanceType<typeof LayoutPanelZones> | null>(null);

function removeZone(id: string) {
  const zone = floorplan.value?.zones.find((one) => one.id === id);
  editor.removeZone(id);
  if (zone) say(saidZoneRemoved(zone.label));
}

/** The layout's pending change lands before a phase move reads the market, and one that did not
 * land stops the move, as Market Setup's plan does: past Draft the server would refuse it. */
async function flushLayout(): Promise<string | null> {
  const why = await editor.flush();
  return why === null ? null : `The market did not move, because the layout did not save. ${why}`;
}

async function reload() {
  await refresh();
  editor.reload(stored.value);
}

/** The floorplan chosen for the location: its layout's start, or its image on a layout begun. */
function onUploaded(image: UploadedFloorplan) {
  const imageFields = {
    imageGridfsId: image.gridfs_id,
    imageWidth: image.width,
    imageHeight: image.height,
    pdfPage: image.page ?? null,
  };
  const next: FloorplanObject = floorplan.value
    ? { ...floorplan.value, ...imageFields }
    : {
        id: crypto.randomUUID(),
        locationId: locationId.value,
        revision: 0,
        ...imageFields,
        tables: [],
        zones: [],
        sectionStyles: [],
        startingCounts: [],
      };
  void editor.write(next);
}

/** Why the last scale drawn was not taken: tables it would leave outside the floorplan, or the
 * server's refusal. Said in the calibration's own error line. */
const calibrationRefusal = ref('');

/** How far past the floorplan's edge a centre may stand, as the server allows (`layout.py`). */
const EDGE_MM = 0.5;

function outsideAt(layout: FloorplanObject, scale: number): number {
  const width = (layout.imageWidth ?? 0) / scale;
  const depth = (layout.imageHeight ?? 0) / scale;
  return layout.tables.filter(
    (table) =>
      table.xMm < -EDGE_MM ||
      table.yMm < -EDGE_MM ||
      table.xMm > width + EDGE_MM ||
      table.yMm > depth + EDGE_MM,
  ).length;
}

async function onCalibrated(line: { start: Point; end: Point; lengthMm: number }) {
  const current = floorplan.value;
  const scale = pxPerMm(line.start, line.end, line.lengthMm);
  if (!current || scale === null) return;
  // The tables keep their places in metres, so a smaller hall can leave some outside it, which
  // the server refuses on every Retry: the page says so first and writes nothing.
  const outside = outsideAt(current, scale);
  if (outside) {
    calibrationRefusal.value =
      outside === 1
        ? 'At this scale 1 table would stand outside the floorplan. Draw the line again, or move it in first.'
        : `At this scale ${outside} tables would stand outside the floorplan. Draw the line again, or move them in first.`;
    return;
  }
  calibrationRefusal.value = '';
  const round = (n: number) => Math.round(n * 10) / 10;
  const saved = await editor.write(
    {
      ...current,
      scalePxPerUnit: scale,
      referenceLineStart: [round(line.start[0]), round(line.start[1])],
      referenceLineEnd: [round(line.end[0]), round(line.end[1])],
      referenceLineLengthMm: line.lengthMm,
    },
    { rollBack: true, onRefused: (sentence) => (calibrationRefusal.value = sentence) },
  );
  if (saved) recalibrating.value = false;
}

/** The save state is the writer's: someone who only reads the layout, or reads it on a phone, is
 *  told nothing of saves. */
const showSaveState = computed(
  () => editsHere.value && (saveState.value !== 'idle' || Boolean(stored.value)),
);

/** A layout is edited at a desk: at a phone's width, 640px and below, its map is read. */
const atADesk = ref(true);
let phoneWindow: MediaQueryList | null = null;
function readTheWindow() {
  atADesk.value = !phoneWindow?.matches;
}
onMounted(() => {
  phoneWindow = window.matchMedia('(width <= 640px)');
  phoneWindow.addEventListener('change', readTheWindow);
  readTheWindow();
});
onUnmounted(() => phoneWindow?.removeEventListener('change', readTheWindow));

/** Whether this page changes the layout: for someone who may, at a desk. On a phone a layout is
 *  read only: nothing is uploaded, calibrated or edited there. */
const editsHere = computed(() => editable.value && atADesk.value);

/** Whether the map is the editor: a calibrated layout, for someone who may change it, at a desk. */
const editing = computed(
  () => calibrated.value && editsHere.value && !recalibrating.value && !replacing.value,
);

/** Whether the map is read: a calibrated layout, not edited, and not being recalibrated or given
 *  a new image here. */
const reading = computed(
  () =>
    calibrated.value &&
    !editing.value &&
    !(editsHere.value && (recalibrating.value || replacing.value)),
);

/** The table the read map last had tapped, pressed or focused, which the panel's first card reads. */
const readId = ref<string | null>(null);
const readTable = computed(
  () => (floorplan.value?.tables ?? []).find((table) => table.id === readId.value) ?? null,
);

const selectedTables = computed(() => {
  const ids = new Set(editor.selection.value);
  return (floorplan.value?.tables ?? []).filter((table) => ids.has(table.id));
});
const tableTypes = computed(() => market.value?.setupObject?.tableTypes ?? []);

/** How many of the market's tables are of each type, this layout's as it stands unsaved. */
const typeCounts = computed(() =>
  tablesOfEachType(market.value?.setupObject?.floorplans ?? [], floorplan.value),
);

/** Write the market's types once the layout's own last change has landed, so the server judges
 * which types its tables use as the page shows them; then re-read the market, whose types the
 * map and the editor draw by. */
async function writeTableTypes(types: TableTypeObject[]) {
  const refused = await editor.flush();
  if (refused) throw new LayoutNotSaved(refused);
  await saveTableTypes(marketId.value, types);
  // Written: a re-read that fails leaves the old types shown until the next, but is no failure of
  // the write.
  await refresh().catch(() => {});
}

/** The market's organization, for its saved types, when this person is in it: an editor of this
 *  market alone may not list or file an organization's templates. */
const typesOrganization = () =>
  market.value?.inOrganization ? (market.value.organizationId ?? null) : null;
const listSaved = () => listSavedTypes(typesOrganization());
const saveTheseTypes = (name: string) => saveTypes(name, tableTypes.value, typesOrganization());

// ── Export PNG ───────────────────────────────────────────────────────────────

const exportOpen = ref(false);
const exporting = ref(false);
const exportError = ref('');

function openExport() {
  exportError.value = '';
  exportOpen.value = true;
}

/** The layout as the page shows it, its last change saved or not, made into a PNG and saved. */
async function exportPng(choice: { withImage: boolean; withNumbers: boolean }) {
  const layout = floorplan.value;
  const place = location.value;
  if (!market.value || !layout || !place || exporting.value) return;
  exporting.value = true;
  exportError.value = '';
  try {
    await exportLayoutPng({
      market: {
        name: market.value.name,
        slug: market.value.slug,
        dates: (market.value.setupObject?.marketDates ?? []).map((day) => day.date),
      },
      location: place,
      layout,
      sections: market.value.setupObject?.sections ?? [],
      tableTypes: tableTypes.value,
      ...choice,
    });
    exportOpen.value = false;
  } catch {
    exportError.value = 'The PNG could not be made. Try again.';
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <MarketFrame :market="market" :beforeTransition="flushLayout">
    <div v-if="market" class="layout-page" data-testid="layout-page">
      <header class="layout-head">
        <h1 class="layout-title">Layout</h1>
        <nav
          v-if="locations.length"
          class="layout-locations"
          aria-label="Locations"
          data-testid="layout-locations"
        >
          <RouterLink
            v-for="place in locations"
            :key="place.id"
            :to="layoutPath(market.id, place.id)"
            class="layout-location"
            :class="{ 'layout-location--here': place.id === locationId }"
            :aria-current="place.id === locationId ? 'page' : undefined"
            :data-testid="`layout-location-${place.id}`"
          >
            {{ place.name }}
          </RouterLink>
        </nav>
        <div class="layout-status">
          <template v-if="showSaveState && location">
            <p
              v-if="saveState === 'failed' || saveState === 'stale'"
              class="layout-save layout-save--failed"
              role="alert"
              data-testid="layout-save-state"
            >
              {{ saveMessage }}
              <button
                v-if="saveState === 'failed'"
                type="button"
                class="btn btn--secondary btn--compact"
                data-testid="layout-save-retry"
                @click="editor.retry()"
              >
                Retry
              </button>
              <button
                v-else
                type="button"
                class="btn btn--secondary btn--compact"
                data-testid="layout-save-reload"
                @click="reload"
              >
                Reload
              </button>
            </p>
            <p v-else class="layout-save" role="status" data-testid="layout-save-state">
              {{ saveState === 'saving' ? 'Saving…' : 'Saved' }}
            </p>
          </template>
          <p v-if="location && floorplan" class="layout-scale" data-testid="layout-scale">
            {{ scaleText }}
          </p>
          <button
            v-if="location && calibrated"
            type="button"
            class="btn btn--secondary"
            data-testid="layout-export-open"
            @click="openExport"
          >
            Export PNG
          </button>
          <button
            v-if="editing"
            type="button"
            class="btn btn--secondary"
            data-testid="layout-settings-open"
            @click="settingsOpen = true"
          >
            Layout settings
          </button>
          <RouterLink
            :to="marketPath(market.id, 'setup')"
            class="btn btn--secondary"
            data-testid="layout-back-to-setup"
          >
            Back to Market Setup
          </RouterLink>
        </div>
      </header>

      <p
        v-if="settled && !archived && saysFollowsPlan"
        class="note"
        data-testid="layout-follows-plan"
      >
        {{ FOLLOWS_THE_PLAN }}
      </p>
      <p v-else-if="settled && !archived" class="note" data-testid="layout-setup-settled">
        {{ market.setupLockReason }}
      </p>

      <p v-if="!locations.length" class="layout-empty" data-testid="layout-no-locations">
        Name a location on Market Setup's Location Setup to lay it out.
      </p>
      <p v-else-if="locationId && !location" class="layout-empty" data-testid="layout-no-location">
        This location is not one of the market's.
      </p>

      <div v-else-if="location" class="layout-columns">
        <section class="layout-map-column" :aria-label="`${location.name}'s floorplan`">
          <template v-if="!floorplan?.imageGridfsId">
            <FloorplanUploader
              v-if="editsHere"
              :marketId="market.id"
              :busy="saveState === 'saving'"
              @uploaded="onUploaded"
            />
            <p v-else class="layout-empty" data-testid="layout-no-floorplan">
              No floorplan has been uploaded for {{ location.name }} yet.
            </p>
          </template>
          <template v-else-if="editsHere && replacing">
            <p
              v-if="replaceError"
              class="layout-replace-error"
              role="alert"
              data-testid="layout-replace-error"
            >
              {{ replaceError }}
            </p>
            <template v-if="!replacement || !replacementUrl">
              <FloorplanUploader
                v-if="!replacement"
                :marketId="market.id"
                :busy="saveState === 'saving'"
                @uploaded="onReplacement"
              />
              <p
                v-else-if="replacementFailed"
                class="layout-empty"
                data-testid="layout-image-failed"
              >
                The new image could not be shown. Choose it again, or keep the current one.
              </p>
              <p v-else class="layout-empty" data-testid="layout-replace-loading">
                Showing the new image…
              </p>
              <div class="layout-card-actions">
                <button
                  v-if="replacementFailed"
                  type="button"
                  class="btn btn--secondary"
                  data-testid="layout-replace-again"
                  @click="startReplacing"
                >
                  Choose another image
                </button>
                <button
                  type="button"
                  class="btn btn--secondary"
                  data-testid="layout-replace-cancel"
                  @click="stopReplacing"
                >
                  Keep the current image
                </button>
              </div>
            </template>
            <LayoutCalibration
              v-else
              :key="replacement.gridfs_id"
              :imageUrl="replacementUrl"
              :imageWidth="replacement.width"
              :imageHeight="replacement.height"
              :locationName="location.name"
              :start="carriedLine?.start"
              :end="carriedLine?.end"
              :lengthMm="floorplan.referenceLineLengthMm"
              :busy="saveState === 'saving'"
              cancellable
              cancelLabel="Keep the current image"
              @set="onReplacementCalibrated"
              @cancel="stopReplacing"
            />
          </template>
          <template v-else-if="calibrated && !(editsHere && recalibrating)">
            <p v-if="imageFailed" class="layout-empty" data-testid="layout-image-failed">
              The floorplan's image could not be shown. Reload the page to try again.
            </p>
            <LayoutEditor
              v-if="editing"
              :editor="editor"
              :locationName="location.name"
              :sections="market.setupObject?.sections ?? []"
              :tableTypes="tableTypes"
              :imageUrl="imageUrl"
              :imagePending="imagePending"
              v-model:showImage="showImage"
              v-model:imageInGrey="imageInGrey"
              v-model:imageFaded="imageFaded"
              :settled="seatsSettled"
              :fill="(request) => placeTables(marketId, request)"
              @announce="say"
              @status="showStatus"
              @zoneAdded="zonesCard?.focusZone($event)"
              @tool="editorTool = $event"
              ref="editorView"
              v-model:sectionId="toolSectionId"
              v-model:typeId="toolTypeId"
            />
            <div
              v-else
              class="layout-map-frame"
              :style="{
                aspectRatio: `${floorplan.imageWidth ?? 1} / ${floorplan.imageHeight ?? 1}`,
              }"
            >
              <LayoutMap
                :layout="floorplan"
                :locationName="location.name"
                :sections="market.setupObject?.sections ?? []"
                :tableTypes="tableTypes"
                :imageUrl="imageUrl"
                :imagePending="imagePending"
                :showImage="showImage"
                :imageInGrey="imageInGrey"
                :imageFaded="imageFaded"
                mode="read"
                :selection="readTable ? [readTable.id] : []"
                @activate="readId = $event"
                @focused="readId = $event"
              />
            </div>
          </template>
          <p v-else-if="imageFailed" class="layout-empty" data-testid="layout-image-failed">
            The floorplan's image could not be shown. Reload the page to try again.
          </p>
          <LayoutCalibration
            v-else-if="imageUrl && editsHere"
            :key="`${floorplan.id}-${floorplan.imageGridfsId}`"
            :imageUrl="imageUrl"
            :imageWidth="floorplan.imageWidth ?? 1"
            :imageHeight="floorplan.imageHeight ?? 1"
            :locationName="location.name"
            :start="floorplan.referenceLineStart"
            :end="floorplan.referenceLineEnd"
            :lengthMm="floorplan.referenceLineLengthMm"
            :busy="saveState === 'saving'"
            :cancellable="calibrated"
            :refusal="calibrationRefusal"
            @set="onCalibrated"
            @cancel="
              recalibrating = false;
              calibrationRefusal = '';
            "
          />
          <img
            v-else-if="imageUrl"
            :src="imageUrl"
            class="layout-image"
            :alt="`${location.name}'s floorplan`"
            data-testid="layout-image"
          />
        </section>

        <aside class="layout-panel" aria-label="Layout details">
          <section v-if="!floorplan?.imageGridfsId" class="layout-card">
            <p class="layout-card-text" data-testid="layout-panel-start">
              <template v-if="editsHere">
                Upload the venue's floorplan for {{ location.name }} to start.
              </template>
              <template v-else>{{ location.name }} has no layout yet.</template>
            </p>
          </section>
          <section v-else-if="!calibrated && editsHere" class="layout-card">
            <h2 class="layout-card-title">Set the scale</h2>
            <p class="layout-card-text">
              Draw a line over something of known length, then type its length, so every table is
              drawn at its true size.
            </p>
          </section>
          <template v-else-if="calibrated">
            <!-- A reader's card of the table read heads the panel, where a phone shows it first under
                 the map. -->
            <LayoutPanelTable
              v-if="reading"
              class="layout-card"
              :table="readTable"
              :sections="sections"
              :tableTypes="tableTypes"
              :phone="!atADesk"
            />
            <!-- What stands: the location's sections, informational, at the head of an editor's
                 panel; what is worked with (the status, the tool's or the selection's card) under
                 it. -->
            <LayoutPanelSections
              class="layout-card layout-card--info"
              :locationName="location.name"
              :sections="sections"
              :unsectioned="unsectioned.length"
              :startingCounts="floorplan?.startingCounts ?? []"
              :editable="editing"
              :settled="seatsSettled"
              :followsPlan="followsPlan"
              @color="(sectionId, color) => editor.setSectionStyle(sectionId, { color })"
              @renumber="editor.renumber($event)"
              @selectUnsectioned="selectUnsectioned"
            />
            <p
              v-if="editing && status"
              class="layout-card layout-fill-status"
              data-testid="layout-status"
            >
              {{ status }}
            </p>
            <!-- The card of the tool on, while it is one that adds tables, in place of the
                 selection's: its options, never over the map. -->
            <LayoutToolCard
              v-if="editing && isAdding(editorTool)"
              v-model:sectionId="toolSectionId"
              v-model:typeId="toolTypeId"
              :tool="editorTool"
              :sections="ownLaidOutSections"
              :tableTypes="tableTypes"
              :rowClosed="editorView?.rowClosed ?? false"
              @flip="editorView?.flipRow()"
              @fillInView="editorView?.fillInView()"
            />
            <!-- The no-table zones are the No-table zone tool's card: a zone is named as it is
                 drawn. -->
            <LayoutPanelZones
              v-if="editing && editorTool === 'zone'"
              ref="zonesCard"
              class="layout-card"
              :zones="floorplan?.zones ?? []"
              @label="editor.setZoneLabel"
              @remove="removeZone"
            />
            <LayoutPanelSelection
              v-if="editing && editorTool === 'select'"
              class="layout-card"
              :tables="selectedTables"
              :sections="sections"
              :tableTypes="tableTypes"
              :settled="seatsSettled"
              :typesSettled="settled"
              :followsPlan="followsPlan"
              @turn="turnTheSelection"
              @remove="removeSelection"
              @duplicate="duplicateSelection"
              @arrange="arrangeSelection"
              @section="sectionSelection"
              @type="typeSelection"
              @row="rowOnFromTheSelection"
              @number="numberSelection"
            />
            <section
              v-if="atADesk && !editing"
              class="layout-card"
              data-testid="layout-panel-floorplan"
            >
              <h2 class="layout-card-title">Floorplan</h2>
              <p class="layout-card-text">{{ location.name }}'s floorplan reads {{ scaleText }}.</p>
              <label class="layout-tick">
                <input v-model="showImage" type="checkbox" data-testid="layout-show-image" />
                <span>Show the floorplan</span>
              </label>
              <label class="layout-tick">
                <input
                  v-model="imageInGrey"
                  type="checkbox"
                  :disabled="!showImage"
                  data-testid="layout-image-grey"
                />
                <span>Greyscale</span>
              </label>
              <label class="layout-tick">
                <input
                  v-model="imageFaded"
                  type="checkbox"
                  :disabled="!showImage"
                  data-testid="layout-image-faded"
                />
                <span>Faded</span>
              </label>
            </section>
            <p v-if="reading && !atADesk" class="layout-phone-hint" data-testid="layout-phone-hint">
              Pinch to zoom, drag to look around, tap a table to read it. The layout is edited at a
              desk.
            </p>
          </template>
        </aside>
      </div>
      <!-- What is set up once or seldom, out of the panel: the table types, and the floorplan's
           image and scale (the QC walk of 2026-11-16). -->
      <AppDialog
        v-if="editing && location"
        :open="settingsOpen"
        title="Layout settings"
        testid="layout-settings"
        size="wide"
        scroll="body"
        @close="settingsOpen = false"
      >
        <div class="layout-settings">
          <div class="layout-settings__column">
            <LayoutPanelTypes
              class="layout-settings__section"
              :tableTypes="tableTypes"
              :counts="typeCounts"
              :settled="settled"
              :save="writeTableTypes"
              :listSaved="listSaved"
              :saveAs="saveTheseTypes"
            />
            <section
              class="layout-settings__section"
              aria-labelledby="layout-settings-floorplan"
              data-testid="layout-panel-floorplan"
            >
              <h2 id="layout-settings-floorplan" class="layout-card-title">Floorplan image</h2>
              <p class="layout-card-text">{{ location.name }}'s floorplan reads {{ scaleText }}.</p>
              <div v-if="!recalibrating && !replacing" class="layout-card-actions">
                <button
                  type="button"
                  class="btn btn--secondary"
                  data-testid="layout-replace-image"
                  @click="
                    settingsOpen = false;
                    startReplacing();
                  "
                >
                  Replace the image
                </button>
                <button
                  type="button"
                  class="btn btn--secondary"
                  data-testid="layout-recalibrate"
                  @click="
                    settingsOpen = false;
                    recalibrating = true;
                  "
                >
                  Recalibrate
                </button>
              </div>
            </section>
          </div>
        </div>
      </AppDialog>
      <LayoutExportDialog
        v-if="location"
        :open="exportOpen"
        :locationName="location.name"
        :busy="exporting"
        :error="exportError"
        @close="exportOpen = false"
        @export="exportPng"
      />
      <p
        v-if="editing"
        class="visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="layout-announcement"
      >
        {{ said }}
      </p>
    </div>
  </MarketFrame>
</template>

<style scoped>
/* The frame's gutter, as on every market page. A container, so the panel moves under the map by
   the room the page has, not the window's. */
.layout-page {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
  container-type: inline-size;
  min-width: 0;
}

/* The page's head is a bar across the whole page, ruled off from the work under it: where it is and
   how it stands (the title, the locations, the save state, the scale) and the page's own actions
   above; the tools, the map and the panel below (the QC walk of 2026-11-16). */
.layout-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3) var(--space-4);
  /* Out to the page's edges, through its inset, which it keeps inside. */
  margin: calc(-1 * var(--space-6)) calc(-1 * var(--space-6)) 0;
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--mm-border);
}

.layout-title {
  margin: 0;
  font-family: 'Merge One';
  font-size: var(--text-xl);
  font-weight: 400;
}

/* A segmented control of the market's locations, the one shown pressed. */
.layout-locations {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-1);
  border-radius: var(--radius-pill);
  background: var(--mm-beige);
}

.layout-location {
  display: inline-flex;
  align-items: center;
  /* A thumb's target on a phone, where --target-min is 44px. */
  min-height: var(--target-min);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  font-size: var(--text-sm);
  color: var(--mm-black);
  text-decoration: none;
}

.layout-location:hover {
  background: var(--mm-beige-hover);
}

.layout-location--here,
.layout-location--here:hover {
  background: white;
  box-shadow: var(--shadow-card);
}

/* Its own shadow outranks the global halo, so it says its focus too, the halo over the shadow. */
.layout-location--here:focus-visible {
  box-shadow: var(--focus-halo), var(--shadow-card);
}

.layout-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-left: auto;
}

.layout-save,
.layout-scale {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

.layout-save--failed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--mm-text-red-on-tint);
}

.layout-scale {
  color: var(--mm-black);
}

.layout-empty {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.layout-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  align-items: start;
  gap: var(--space-6);
}

@container (width < 1100px) {
  .layout-columns {
    grid-template-columns: minmax(0, 1fr);
  }
}

.layout-map-column {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

/* A floorplan with no scale yet, shown to someone who cannot set one: the image alone, whole. */
.layout-image {
  display: block;
  width: 100%;
  height: auto;
  max-height: 70vh;
  object-fit: contain;
  background: var(--layout-floor);
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
}

/* The map fills the column at the floorplan's shape, the whole hall in it edge to edge. It caps no
   height of its own: a tall hall grows the page, which scrolls, as every screen does. */
.layout-map-frame {
  width: 100%;
  overflow: hidden;
  background: var(--layout-floor);
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
}

.layout-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.layout-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-card);
  background: white;
  box-shadow: var(--shadow-card);
}

/* Layout settings: what is set up once, each part set off by a rule rather than drawn as a card
   inside the dialog's own card. */
.layout-settings {
  display: flex;
  flex-direction: column;
}

.layout-settings__column {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  min-width: 0;
}

.layout-settings__section {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
}

.layout-settings__section + .layout-settings__section {
  padding-top: var(--space-6);
  border-top: 1px solid var(--mm-border);
}

/* A card that informs rather than one worked in: flat on the page's ground, edged and unlifted,
   so the card of the tool or the selection under it reads as the one in hand. */
.layout-card--info {
  background: var(--mm-beige);
  box-shadow: none;
  border: 1px solid var(--mm-border);
}

.layout-card-title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
}

.layout-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.layout-tick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--target-min);
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.layout-replace-error {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-text-red-on-tint);
}

.layout-card-text {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
}

/* How a phone reads the map, under the sections, as the editor's hint stands under its map. */
.layout-phone-hint {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

/* A phone's 16px gutter, as on every page that fits one. */
@media (width <= 640px) {
  .layout-page {
    padding: var(--space-4);
  }

  .layout-head {
    margin: calc(-1 * var(--space-4)) calc(-1 * var(--space-4)) 0;
    padding: var(--space-4);
  }
}
</style>
