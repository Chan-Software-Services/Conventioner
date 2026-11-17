/**
 * The public map's backdrop (T465): the market's section colours, each once and mixed light, dealt
 * to four broad ribbons and a lump for each colour past four, so every colour is drawn at least
 * once; a market with no section drawn shows the paper alone.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { publicDayLocations, type PublicMapAnswer } from '@/components/daymap/dayMap';
import PublicMapBackdrop from '@/components/publicmap/PublicMapBackdrop.vue';
import { RIBBONS, dealtShapes, sectionColours } from '@/components/publicmap/publicMapBackdrop';

const table = (id: string, sectionId: string, number: number) => ({
  id,
  sectionId,
  number,
  tableTypeId: 'type-6ft',
  xMm: 4000,
  yMm: 3000,
  rotation: 0,
});

type Hall = PublicMapAnswer['locations'][number];

/** A hall of the given sections, each with the tables named, in the given palette colours. */
function hall(id: string, sections: { id: string; tables: string[]; color?: number }[]): Hall {
  return {
    id,
    name: `Hall ${id}`,
    sections: sections.map((section) => ({ id: section.id, name: `Row ${section.id}` })),
    layout: {
      id: `fp-${id}`,
      locationId: id,
      imageWidth: 800,
      imageHeight: 600,
      scalePxPerUnit: 800 / 30_000,
      hasImage: false,
      tables: sections.flatMap((section) =>
        section.tables.map((one, at) => table(one, section.id, at + 1)),
      ),
      zones: [],
      sectionStyles: sections.flatMap((section) =>
        section.color === undefined
          ? []
          : [{ sectionId: section.id, color: section.color, labelAt: null }],
      ),
    },
  };
}

const coloursOf = (...halls: Hall[]) =>
  sectionColours(publicDayLocations({ locations: halls }, () => ''));

const mix = (n: number) =>
  `color-mix(in oklch, var(--layout-section-${n}-edge) 12%, var(--layout-section-${n}-fill))`;

const COLOURS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];

describe("the market's section colours", () => {
  it("mixes each section's edge into its fill in OKLCH, in the halls' order", () => {
    expect(
      coloursOf(
        hall('north', [
          { id: 'a', tables: ['a1'] },
          { id: 'b', tables: ['b1'] },
        ]),
        hall('south', [{ id: 'c', tables: ['c1'], color: 5 }]),
      ),
    ).toEqual([mix(1), mix(2), mix(5)]);
  });

  it('takes a colour two sections share once', () => {
    expect(
      coloursOf(
        hall('north', [{ id: 'a', tables: ['a1'] }]),
        hall('south', [{ id: 'b', tables: ['b1'] }]),
      ),
    ).toEqual([mix(1)]);
  });

  it('takes no colour from a section with no table drawn', () => {
    expect(
      coloursOf(
        hall('north', [
          { id: 'empty', tables: [] },
          { id: 'a', tables: ['a1'], color: 3 },
        ]),
      ),
    ).toEqual([mix(3)]);
  });

  it('is empty for a market with no section drawn', () => {
    expect(coloursOf(hall('north', []))).toEqual([]);
    expect(coloursOf()).toEqual([]);
  });
});

describe("the backdrop's shapes", () => {
  it('are the four ribbons of a 1440 x 900 view, at their opacities', () => {
    expect(RIBBONS.map((ribbon) => ribbon.opacity)).toEqual([0.85, 0.8, 0.8, 0.85]);
    expect(RIBBONS[0]!.d).toBe(
      'M-200 -100 C 200 100, 500 -50, 900 150 C 1200 300, 1400 200, 1700 350 L 1700 560 C 1400 410, 1200 510, 900 360 C 500 160, 200 310, -200 110 Z',
    );
    // Each ribbon is the one before it moved 250 down.
    for (const [at, ribbon] of RIBBONS.entries()) {
      const ys = [...ribbon.d.matchAll(/(-?\d+) (-?\d+)/g)].map((pair) => Number(pair[2]));
      const firstYs = [...RIBBONS[0]!.d.matchAll(/(-?\d+) (-?\d+)/g)].map((pair) =>
        Number(pair[2]),
      );
      expect(ys).toEqual(firstYs.map((y) => y + 250 * at));
    }
  });

  it('are none for no colour: the paper alone', () => {
    expect(dealtShapes([])).toEqual([]);
  });

  it.each([
    [1, ['c0', 'c0', 'c0', 'c0']],
    [2, ['c0', 'c0', 'c1', 'c1']],
    [3, ['c0', 'c0', 'c1', 'c2']],
    [4, ['c0', 'c1', 'c2', 'c3']],
  ])('give the four ribbons a run of the %i colours each, top to bottom', (n, dealt) => {
    const shapes = dealtShapes(COLOURS.slice(0, n));
    expect(shapes.map((shape) => shape.colour)).toEqual(dealt);
    expect(shapes.map(({ d, opacity }) => ({ d, opacity }))).toEqual(RIBBONS);
  });

  it('give each colour past four a lump of its own, spread along the middle band', () => {
    const shapes = dealtShapes(COLOURS.slice(0, 7));
    expect(shapes.slice(0, 4).map((shape) => shape.colour)).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(shapes.slice(4)).toEqual([
      {
        d: 'M120 560 c 120 -60, 260 0, 240 110 c -20 110, -170 110, -240 50 c -70 -60, -90 -120, 0 -160 Z',
        opacity: 0.75,
        colour: 'c4',
      },
      {
        d: 'M640 350 c 120 -60, 260 0, 240 110 c -20 110, -170 110, -240 50 c -70 -60, -90 -120, 0 -160 Z',
        opacity: 0.75,
        colour: 'c5',
      },
      {
        d: 'M1160 520 c 120 -60, 260 0, 240 110 c -20 110, -170 110, -240 50 c -70 -60, -90 -120, 0 -160 Z',
        opacity: 0.75,
        colour: 'c6',
      },
    ]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('draw every one of %i colours at least once', (n) => {
    const colours = COLOURS.slice(0, n);
    const shapes = dealtShapes(colours);
    expect(shapes).toHaveLength(Math.max(4, n));
    expect(new Set(shapes.map((shape) => shape.colour))).toEqual(new Set(colours));
    // A lump sits inside the view, whatever its number.
    for (const lump of shapes.slice(4)) {
      const [x, y] = lump.d.slice(1).split(' ').map(Number);
      expect(x! - 90).toBeGreaterThanOrEqual(0);
      expect(x! + 260).toBeLessThanOrEqual(1440);
      expect(y! - 60).toBeGreaterThanOrEqual(0);
      expect(y! + 220).toBeLessThanOrEqual(900);
    }
  });
});

describe('the backdrop', () => {
  const answer = (...halls: Hall[]) => publicDayLocations({ locations: halls }, () => '');

  it('draws the paper first, then one path for each shape in its colour and opacity', () => {
    const wrapper = mount(PublicMapBackdrop, {
      props: {
        locations: answer(
          hall('north', [
            { id: 'a', tables: ['a1'] },
            { id: 'b', tables: ['b1'] },
          ]),
        ),
      },
    });
    const svg = wrapper.get('[data-testid="public-map-backdrop"]');
    expect(svg.element.tagName).toBe('svg');
    expect(svg.attributes('aria-hidden')).toBe('true');
    expect(svg.attributes('focusable')).toBe('false');
    expect(svg.attributes('viewBox')).toBe('0 0 1440 900');
    expect(svg.attributes('preserveAspectRatio')).toBe('none');

    const drawn = [...svg.element.children];
    expect(drawn.map((one) => one.tagName)).toEqual(['rect', 'path', 'path', 'path', 'path']);
    expect(drawn[0]!.getAttribute('width')).toBe('1440');
    expect(drawn[0]!.getAttribute('height')).toBe('900');
    expect(drawn[0]!.classList.contains('public-map-backdrop__paper')).toBe(true);
    const shapes = dealtShapes([mix(1), mix(2)]);
    for (const [at, path] of drawn.slice(1).entries()) {
      const shape = shapes[at]!;
      expect(path.getAttribute('d')).toBe(shape.d);
      expect((path as SVGPathElement).style.opacity).toBe(String(shape.opacity));
      expect(path.getAttribute('style')).toContain(`fill: ${shape.colour}`);
    }
  });

  it('draws the paper alone for a market with no section drawn', () => {
    const wrapper = mount(PublicMapBackdrop, { props: { locations: answer(hall('north', [])) } });
    const drawn = [...wrapper.get('[data-testid="public-map-backdrop"]').element.children];
    expect(drawn.map((one) => one.tagName)).toEqual(['rect']);
  });

  it('draws a lump for each colour past four', () => {
    const wrapper = mount(PublicMapBackdrop, {
      props: {
        locations: answer(
          hall(
            'north',
            [1, 2, 3, 4, 5, 6].map((color) => ({
              id: `s${color}`,
              tables: [`t${color}`],
              color,
            })),
          ),
        ),
      },
    });
    expect(wrapper.findAll('path')).toHaveLength(6);
  });
});
