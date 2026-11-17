// @vitest-environment happy-dom
/**
 * The public map's card of the table picked (T422 ticket 09, T465), mounted alone: its code, and
 * each part of the table with the vendor's public name, website and Instagram, or that the part is
 * free on the day, or that a vendor sits there unnamed; nothing a vendor typed is markup.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { PublicMapAnswer } from '@/components/daymap/dayMap';
import type { TablePaint } from '@/components/publicmap/publicMapPaint';
import PublicMapTableCard from '@/components/publicmap/PublicMapTableCard.vue';
import * as publicMap from '@/utils/publicMap';
import { dayInWords, tableCard } from '@/utils/publicMap';
import { ANSWER, TODAY, TOMORROW } from './support/publicMapAnswer';

/** The card of one table on one day, as the page mounts it. */
function cardOf(
  tableId: string,
  date: string = TODAY,
  map: PublicMapAnswer = ANSWER,
  paint: TablePaint | null = null,
) {
  return mount(PublicMapTableCard, {
    props: {
      card: tableCard(map, date, tableId)!,
      day: dayInWords(date),
      hallName: 'Upper Hall',
      paint,
    },
  });
}

const GOLD: TablePaint = {
  fill: 'var(--layout-section-1-fill)',
  edge: 'var(--layout-section-1-edge)',
};

describe("a table's card", () => {
  it('is a region named by its heading, "Table <code>", the code alone shown in a pill', () => {
    const card = cardOf('g1', TODAY, ANSWER, GOLD);
    const region = card.get('[data-testid="public-map-card"]');
    expect(region.element.tagName).toBe('SECTION');
    const heading = card.get('h2');
    expect(region.attributes('aria-labelledby')).toBe(heading.attributes('id'));
    expect(heading.text()).toBe('Table Gold row 1');
    expect(heading.get('.visually-hidden').text()).toBe('Table');
    const code = heading.get('[data-testid="public-map-card-code"]');
    expect(code.text()).toBe('Gold row 1');
    expect(code.attributes('style')).toContain('background: var(--layout-section-1-fill)');
    expect(code.attributes('style')).toContain('border-color: var(--layout-section-1-edge)');
  });

  it('names the hall after its heading, outside it', () => {
    const card = cardOf('g1');
    const hall = card.get('.public-map-card__hall');
    expect(hall.text()).toBe('Upper Hall');
    expect(card.get('h2').text()).not.toContain('Upper Hall');
  });

  it('draws the code pill on the floor when the table is in no section', () => {
    const code = cardOf('g1').get('[data-testid="public-map-card-code"]');
    expect(code.attributes('style')).toBeUndefined();
  });

  it('has a close button, named Close, that says so', async () => {
    const card = cardOf('g1');
    const close = card.get('[data-testid="public-map-card-close"]');
    expect(close.element.tagName).toBe('BUTTON');
    expect(close.attributes('type')).toBe('button');
    expect(close.attributes('aria-label')).toBe('Close');
    expect(close.get('svg').attributes('aria-hidden')).toBe('true');
    await close.trigger('click');
    expect(card.emitted('close')).toEqual([[]]);
  });

  it('has no hint to stand for it: no card shows before a pick', () => {
    expect('PICK_A_TABLE' in publicMap).toBe(false);
  });

  it('names its vendor and their links', () => {
    const card = cardOf('g1');
    expect(card.get('h2').text()).toBe('Table Gold row 1');
    expect(card.text()).toContain('Kiln & Co');
    const links = card.findAll('a');
    expect(links.map((a) => [a.text(), a.attributes('href')])).toEqual([
      ['www.kiln-and-co.example', 'https://www.kiln-and-co.example/shop'],
      ['@example_kiln', 'https://www.instagram.com/example_kiln/'],
    ]);
    for (const link of links) {
      expect(link.attributes('target')).toBe('_blank');
      expect(link.attributes('rel')).toBe('noopener noreferrer');
    }
    // Each link's kind is said to a reader alone: the address and the handle show which is which.
    expect(card.findAll('dt').map((dt) => [dt.text(), dt.classes()])).toEqual([
      ['Website', ['visually-hidden']],
      ['Instagram', ['visually-hidden']],
    ]);
    expect(card.get('[data-testid="public-map-card-name"]').classes()).toContain(
      'public-map-card__name',
    );
  });

  it('lists both vendors of a shared table, left then right', () => {
    const card = cardOf('g2');
    const halves = card.findAll('[data-testid="public-map-card-half"]');
    expect(halves.map((h) => h.get('h3').text())).toEqual(['Left half', 'Right half']);
    expect(halves[0].text()).toContain('Acme Ceramics');
    expect(halves[0].get('a').text()).toBe('@example_acme');
    expect(halves[1].text()).toContain('Bee Candles');
    expect(halves[1].find('a').exists()).toBe(false);
  });

  it('says a half with nobody is free on the day, in words, beside the half that is taken', () => {
    const leftOnly = {
      ...ANSWER,
      seats: ANSWER.seats.filter((s) => !(s.tableId === 'g2' && s.half === 'right')),
    };
    const card = cardOf('g2', TODAY, leftOnly);
    const halves = card.findAll('[data-testid="public-map-card-half"]');
    expect(halves.map((h) => h.get('h3').text())).toEqual(['Left half', 'Right half']);
    expect(halves[0].text()).toContain('Acme Ceramics');
    expect(halves[1].text()).toBe('Right halfThis half is free on Fri 5 Jun.');
  });

  it('says a vendor with no public name is there, and nothing of them', () => {
    expect(cardOf('g3').text()).toBe(
      'Table Gold row 3Upper HallA vendor is at this table. Their details are not listed.',
    );
  });

  it('says a free table is free on the day, in words', () => {
    const card = cardOf('g1', TOMORROW);
    expect(card.text()).toBe('Table Gold row 1Upper HallThis table is free on Sat 6 Jun.');
    expect(card.get('[data-testid="public-map-card-whole"]').text()).toBe(
      'This table is free on Sat 6 Jun.',
    );
  });

  it('renders nothing a vendor typed as markup', () => {
    const hostile = {
      ...ANSWER,
      seats: [
        {
          date: TODAY,
          tableId: 'g1',
          half: 'whole' as const,
          name: '<img src=x onerror=alert(1)>Shop',
          website: 'javascript:alert(1)',
          instagram: 'a"b',
        },
      ],
    };
    const card = cardOf('g1', TODAY, hostile);
    expect(card.find('img').exists()).toBe(false);
    expect(card.text()).toContain('<img src=x onerror=alert(1)>Shop');
    expect(card.find('a').exists()).toBe(false);
  });
});
