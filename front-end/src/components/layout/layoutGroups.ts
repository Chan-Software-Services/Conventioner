/**
 * Tables in groups, a choice of Row of tables and of Fill an area (T422, the QC walk of
 * 2026-11-16, item 15): the tables of a line stand in groups of so many, spaced as the tool spaces
 * them, with a wider spacer between one group and the next, as a hall's tables often stand in
 * pairs with a walkway between pairs. One choice serves both tools and lasts while the app is open
 * (D10). A field that holds no usable number says so under the tool's card, and no row is shown
 * or area filled meanwhile (D9).
 */
import { reactive } from 'vue';
import { lengthMmOf, saidNoLength } from './layoutLength';

/** The most tables a group holds, as the placement takes. */
export const MAX_GROUP_SIZE = 50;

/** The grouping's fields: whether it is on, and its two numbers as typed. */
export const groupChoices = reactive({
  grouped: false,
  /** Tables to a group, as typed. */
  size: '2',
  /** The spacer between one group and the next, in centimetres, as typed. */
  spacerCm: '120',
});

/** What `groupChoices` holds when the app opens. */
export const GROUP_CHOICES_AT_FIRST = { ...groupChoices } as const;

/** A grouping to lay tables by: `size` to a group, then `spacerMm` of floor before the next. */
export interface Grouping {
  size: number;
  spacerMm: number;
}

/** The tables to a group typed: a whole number from 1 to `MAX_GROUP_SIZE`, else null. */
function sizeOf(typed: string): number | null {
  const text = String(typed).trim();
  if (!/^\d+$/.test(text)) return null;
  const size = Number(text);
  return size >= 1 && size <= MAX_GROUP_SIZE ? size : null;
}

/** What Per group says of a value that is no size. */
export const SAID_NO_GROUP_SIZE = `Type how many tables to a group, 1 to ${MAX_GROUP_SIZE}.`;

/** What Per group and Spacer say of themselves while grouping is on: each one's sentence where it
 *  holds no usable number, else ''. */
export function groupFieldErrors(choices: typeof groupChoices = groupChoices) {
  if (!choices.grouped) return { size: '', spacer: '' };
  return {
    size: sizeOf(choices.size) === null ? SAID_NO_GROUP_SIZE : '',
    spacer: lengthMmOf(choices.spacerCm) === null ? saidNoLength('spacer') : '',
  };
}

/** Why no row is shown or area filled for the grouping: the first field's sentence, else ''. */
export function groupRefusal(choices: typeof groupChoices = groupChoices): string {
  const errors = groupFieldErrors(choices);
  return errors.size || errors.spacer;
}

/** The grouping asked, or null where grouping is off or a field holds no usable number. */
export function groupingOf(choices: typeof groupChoices = groupChoices): Grouping | null {
  if (!choices.grouped) return null;
  const size = sizeOf(choices.size);
  const spacerMm = lengthMmOf(choices.spacerCm);
  return size === null || spacerMm === null ? null : { size, spacerMm };
}
