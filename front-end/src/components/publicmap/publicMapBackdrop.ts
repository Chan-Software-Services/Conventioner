/**
 * The public map's backdrop, dealt from the market's own section colours (T465): four broad wavy
 * ribbons sweep down the window from the top left, each colour taking a run of them so it holds a
 * band of its own, and each colour past four gets a lump along the middle band, so every colour is
 * drawn at least once. Blurred whole, they blend into one soft gradient.
 */
import type { DayMapLocation } from '@/components/daymap/dayMap';
import { layoutSections, paintValue } from '@/components/layout/layoutDrawing';

/** A shape of the backdrop, in its `1440 x 900` view box. */
export interface BackdropShape {
  d: string;
  opacity: number;
  /** A CSS colour value. */
  colour: string;
}

/** The four ribbons, top to bottom, each the one before it moved 250 down. */
export const RIBBONS: readonly Omit<BackdropShape, 'colour'>[] = [
  {
    d: 'M-200 -100 C 200 100, 500 -50, 900 150 C 1200 300, 1400 200, 1700 350 L 1700 560 C 1400 410, 1200 510, 900 360 C 500 160, 200 310, -200 110 Z',
    opacity: 0.85,
  },
  {
    d: 'M-200 150 C 200 350, 500 200, 900 400 C 1200 550, 1400 450, 1700 600 L 1700 810 C 1400 660, 1200 760, 900 610 C 500 410, 200 560, -200 360 Z',
    opacity: 0.8,
  },
  {
    d: 'M-200 400 C 200 600, 500 450, 900 650 C 1200 800, 1400 700, 1700 850 L 1700 1060 C 1400 910, 1200 1010, 900 860 C 500 660, 200 810, -200 610 Z',
    opacity: 0.8,
  },
  {
    d: 'M-200 650 C 200 850, 500 700, 900 900 C 1200 1050, 1400 950, 1700 1100 L 1700 1310 C 1400 1160, 1200 1260, 900 1110 C 500 910, 200 1060, -200 860 Z',
    opacity: 0.85,
  },
];

const LUMP_OPACITY = 0.75;

/**
 * Each section's colour, once, for each hall in order and each of its sections with a table drawn:
 * its light fill with a breath of its edge, mixed in OKLCH, which keeps the colour clear, never
 * darker than the tables. A market with no section drawn has none.
 */
export function sectionColours(locations: readonly DayMapLocation[]): string[] {
  const colours = new Set<string>();
  for (const location of locations) {
    for (const { paint, tables } of layoutSections(location.layout, location.sections)) {
      if (tables.length) {
        colours.add(
          `color-mix(in oklch, ${paintValue(paint.edge)} 12%, ${paintValue(paint.fill)})`,
        );
      }
    }
  }
  return [...colours];
}

/**
 * The backdrop's shapes for the colours: none for no colour, so the paper shows alone; else ribbon
 * `i` takes colour `floor(i * n / 4)` of the first four (one colour washes all four, two split
 * them top and bottom), and colour `4 + k` takes lump `k`.
 */
export function dealtShapes(colours: readonly string[]): BackdropShape[] {
  if (!colours.length) return [];
  const dealt = Math.min(colours.length, RIBBONS.length);
  const shapes: BackdropShape[] = RIBBONS.map((ribbon, index) => ({
    ...ribbon,
    colour: colours[Math.floor((index * dealt) / RIBBONS.length)]!,
  }));
  for (let index = RIBBONS.length; index < colours.length; index++) {
    const k = index - RIBBONS.length;
    const x = 120 + ((k * 520) % 1200);
    const y = 260 + ((index * 170) % 380);
    shapes.push({
      d: `M${x} ${y} c 120 -60, 260 0, 240 110 c -20 110, -170 110, -240 50 c -70 -60, -90 -120, 0 -160 Z`,
      opacity: LUMP_OPACITY,
      colour: colours[index]!,
    });
  }
  return shapes;
}
