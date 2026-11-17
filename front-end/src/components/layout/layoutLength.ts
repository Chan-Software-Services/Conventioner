/**
 * A length typed in centimetres, as Row of tables' Gap and Aisle, Fill an area's Aisle and the
 * grouping's Spacer take it: how it is read, and what a field says of a value that is no length.
 * Its own module, so the row's and the grouping's modules each read it without the other.
 */

/** The widest gap, aisle or spacer a row or a fill takes, in centimetres: the placement's
 *  10,000 mm. */
export const MAX_LENGTH_CM = 1000;

/** A length typed, in millimetres: a number of centimetres from 0 to 1,000, a comma for the point
 *  taken; null for anything else, which its field says rather than reading as none. */
export function lengthMmOf(typed: string): number | null {
  const text = String(typed).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const cm = Number(text);
  return cm <= MAX_LENGTH_CM ? Math.round(cm * 10) : null;
}

/** What a gap's, an aisle's or a spacer's field says of a value that is no length. */
export const saidNoLength = (what: 'gap' | 'aisle' | 'spacer') =>
  `Type the ${what}'s width in centimetres, 0 to ${MAX_LENGTH_CM.toLocaleString('en')}.`;
