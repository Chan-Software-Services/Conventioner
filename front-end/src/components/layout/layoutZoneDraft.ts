/**
 * A no-table zone drawn and not yet added (T422, the QC walk of 2026-11-16, item 19), pure: a box
 * dragged with the No-table zone tool is a draft, about its centre and turned, that the organizer
 * moves, sizes by a corner or an edge and turns by its knob before Enter adds it. Its sides are
 * sized in the zone's own axes, so a turned draft sizes along its sides; a turn is held to 15°
 * steps from the page's axis, or the whole degree (D11's absolute steps).
 *
 * Once added a zone is stored as its unturned box from the top-left corner and its turn
 * (`FloorplanZone.rotation`), held inside the floorplan as it stands turned (`heldInHall`).
 */
import type { FloorplanZone } from '@/assets/types/datatypes';
import {
  ANGLE_STEP,
  angleFrom,
  roundTurn,
  snapAngle,
  zoneBounds,
  type Bounds,
  type Hall,
  type PointMm,
} from './layoutGeometry';

/** The smallest side a no-table zone is drawn or sized with: smaller is a slip of the pointer. */
export const MIN_ZONE_SIDE_MM = 100;

/** Said when a box is drawn: it is a draft until Enter. */
export const ZONE_DRAFT_DRAWN =
  'Zone drawn. Move it, size it by an edge or a corner, or turn it by its knob, then press Enter ' +
  'to add it.';
/** Said when a zone drawn is dropped, by Escape or a right-click. */
export const ZONE_DROPPED = 'Zone dropped. No zone was added.';
/** Said of a box dragged smaller than a zone, or a zone that would be added smaller than one. */
export const ZONE_TOO_SMALL = 'Drag a larger box to mark a no-table zone.';
/** Said when Enter finds a draft so far off the floorplan that too little of it is left on. */
export const ZONE_OFF_THE_FLOORPLAN =
  'Too little of the zone is on the floorplan. Move it further on, then press Enter to add it.';

/** A zone drawn and not added: its centre, its sides in its own axes, and its turn. */
export interface ZoneDraft {
  cxMm: number;
  cyMm: number;
  widthMm: number;
  depthMm: number;
  /** Degrees clockwise about its centre, 0 to 360. */
  rotation: number;
}

/** What a handle sizes, as the signs of the side it stands on in the zone's own axes: a corner is
 *  ±1 both ways, an edge is 0 along itself. */
export type ZoneHandle = readonly [sx: -1 | 0 | 1, sy: -1 | 0 | 1];

/** The corners, clockwise from the zone's own top-left. */
export const ZONE_CORNERS: readonly ZoneHandle[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
/** The edges, clockwise from its own top. */
export const ZONE_EDGES: readonly ZoneHandle[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** What a press on a zone drawn does: moves it by its middle, sizes it by a corner or an edge, or
 *  turns it by its knob. */
export type ZoneEditMode = 'move' | 'size' | 'turn';
const ZONE_EDIT_MODES: readonly ZoneEditMode[] = ['move', 'size', 'turn'];

/**
 * The handle a press found, from the names the drawing gives it: its mode (`data-zone-handle`)
 * and, for a corner or an edge, its side (`data-handle`, as "1,-1"). Null for a name that is
 * none of them; the body and the knob size by no side.
 */
export function zoneHandleNamed(
  mode: string | null,
  side: string | null,
): { mode: ZoneEditMode; handle: ZoneHandle } | null {
  const named = ZONE_EDIT_MODES.find((one) => one === mode);
  if (!named) return null;
  if (named !== 'size') return { mode: named, handle: [0, 0] };
  const handle = [...ZONE_CORNERS, ...ZONE_EDGES].find(([sx, sy]) => `${sx},${sy}` === side);
  return handle ? { mode: named, handle } : null;
}

/**
 * Whether enough of a draft is on the floorplan to be added: held inside the hall as it stands
 * (`heldInHall`), both its sides still a zone's least. An unturned draft is cut at the hall's
 * edges, so one carried mostly off it keeps too little.
 */
export function draftOnTheFloorplan(draft: ZoneDraft, hall: Hall | null): boolean {
  const held = heldInHall(shapeOfDraft(draft), hall);
  return held.widthMm >= MIN_ZONE_SIDE_MM && held.depthMm >= MIN_ZONE_SIDE_MM;
}

/** A box dragged, as a draft square to the page. */
export function draftOfBox(box: Bounds): ZoneDraft {
  return {
    cxMm: (box.left + box.right) / 2,
    cyMm: (box.top + box.bottom) / 2,
    widthMm: box.right - box.left,
    depthMm: box.bottom - box.top,
    rotation: 0,
  };
}

/** A draft's box before it is turned, about its centre: what a zone stores beside its turn. */
export function boxOfDraft(draft: ZoneDraft): Bounds {
  return {
    left: draft.cxMm - draft.widthMm / 2,
    top: draft.cyMm - draft.depthMm / 2,
    right: draft.cxMm + draft.widthMm / 2,
    bottom: draft.cyMm + draft.depthMm / 2,
  };
}

/** A draft as a zone's shape: its unturned box from the top-left corner, and its turn. */
export function shapeOfDraft(
  draft: ZoneDraft,
): Pick<FloorplanZone, 'xMm' | 'yMm' | 'widthMm' | 'depthMm' | 'rotation'> {
  return {
    xMm: draft.cxMm - draft.widthMm / 2,
    yMm: draft.cyMm - draft.depthMm / 2,
    widthMm: draft.widthMm,
    depthMm: draft.depthMm,
    rotation: draft.rotation,
  };
}

/** The draft dragged by its middle, by a move of the pointer. */
export function movedDraft(start: ZoneDraft, by: { dxMm: number; dyMm: number }): ZoneDraft {
  return { ...start, cxMm: start.cxMm + by.dxMm, cyMm: start.cyMm + by.dyMm };
}

/** The zone's own axes on the page: along its width, and along its depth. */
function axesOf(rotation: number): { ux: PointMm; uy: PointMm } {
  const turn = (rotation * Math.PI) / 180;
  return {
    ux: { xMm: Math.cos(turn), yMm: Math.sin(turn) },
    uy: { xMm: -Math.sin(turn), yMm: Math.cos(turn) },
  };
}

/**
 * The draft sized by a handle held at a point: the corner or the edge held follows the pointer in
 * the zone's own axes, and the opposite corner or edge stays where it stands. An edge sizes the
 * side across it alone. No side is sized below the zone's smallest.
 */
export function sizedDraft(start: ZoneDraft, handle: ZoneHandle, at: PointMm): ZoneDraft {
  const [sx, sy] = handle;
  const { ux, uy } = axesOf(start.rotation);
  // The opposite corner, or the middle of the opposite edge.
  const held = {
    xMm: start.cxMm - (ux.xMm * sx * start.widthMm) / 2 - (uy.xMm * sy * start.depthMm) / 2,
    yMm: start.cyMm - (ux.yMm * sx * start.widthMm) / 2 - (uy.yMm * sy * start.depthMm) / 2,
  };
  const vx = at.xMm - held.xMm;
  const vy = at.yMm - held.yMm;
  const widthMm = sx ? Math.max(MIN_ZONE_SIDE_MM, sx * (vx * ux.xMm + vy * ux.yMm)) : start.widthMm;
  const depthMm = sy ? Math.max(MIN_ZONE_SIDE_MM, sy * (vx * uy.xMm + vy * uy.yMm)) : start.depthMm;
  return {
    ...start,
    widthMm,
    depthMm,
    cxMm: held.xMm + (ux.xMm * sx * widthMm) / 2 + (uy.xMm * sy * depthMm) / 2,
    cyMm: held.yMm + (ux.yMm * sx * widthMm) / 2 + (uy.yMm * sy * depthMm) / 2,
  };
}

/**
 * The draft turned by its knob, about its centre, from where the knob was pressed (`fromMm`) to
 * where the pointer is: held to 15° steps from the page's axis, or with `fine` to the degree.
 */
export function turnedDraft(
  start: ZoneDraft,
  fromMm: PointMm,
  at: PointMm,
  fine: boolean,
): ZoneDraft {
  const centre = { xMm: start.cxMm, yMm: start.cyMm };
  const by = angleFrom(centre, at) - angleFrom(centre, fromMm);
  return {
    ...start,
    rotation: roundTurn(snapAngle(start.rotation + by, fine ? 1 : ANGLE_STEP)),
  };
}

/**
 * A zone held inside the hall as it stands turned: moved in whole until the box round its turned
 * shape is inside, and first made smaller about its centre where that box is wider or deeper than
 * the hall. An unturned zone is held as it always was, its box cut at the hall's edges, which
 * keeps the part of it inside where it was drawn.
 */
export function heldInHall<Z extends Pick<FloorplanZone, 'xMm' | 'yMm' | 'widthMm' | 'depthMm'>>(
  zone: Z & { rotation?: number },
  hall: Hall | null,
): Z & { rotation?: number } {
  if (!hall) return zone;
  if (!roundTurn(zone.rotation ?? 0)) {
    const left = Math.max(zone.xMm, 0);
    const top = Math.max(zone.yMm, 0);
    const right = Math.min(zone.xMm + zone.widthMm, hall.widthMm);
    const bottom = Math.min(zone.yMm + zone.depthMm, hall.heightMm);
    return { ...zone, xMm: left, yMm: top, widthMm: right - left, depthMm: bottom - top };
  }
  const round = zoneBounds(zone);
  const scale = Math.min(
    1,
    hall.widthMm / (round.right - round.left),
    hall.heightMm / (round.bottom - round.top),
  );
  const widthMm = zone.widthMm * scale;
  const depthMm = zone.depthMm * scale;
  const cx = zone.xMm + zone.widthMm / 2;
  const cy = zone.yMm + zone.depthMm / 2;
  // The box round it shrinks about the same centre, by the same scale.
  const halfW = ((round.right - round.left) * scale) / 2;
  const halfH = ((round.bottom - round.top) * scale) / 2;
  const heldCx = Math.min(Math.max(cx, halfW), hall.widthMm - halfW);
  const heldCy = Math.min(Math.max(cy, halfH), hall.heightMm - halfH);
  return {
    ...zone,
    xMm: heldCx - widthMm / 2,
    yMm: heldCy - depthMm / 2,
    widthMm,
    depthMm,
  };
}

const CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'] as const;

/** The cursor a handle shows: the resize arrow nearest the way it sizes on the page, turned with
 *  the zone. */
export function handleCursor(handle: ZoneHandle, rotation: number): (typeof CURSORS)[number] {
  const [sx, sy] = handle;
  const way = (Math.atan2(sy, sx) * 180) / Math.PI + rotation;
  const step = Math.round((((way % 180) + 180) % 180) / 45) % 4;
  return CURSORS[step];
}
