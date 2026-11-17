// @vitest-environment happy-dom
/**
 * The public map's card of the table picked (T422 ticket 09, T465), mounted alone: its code, and
 * each part of the table with the vendor's public name, website and Instagram, or that the part is
 * free on the day, or that a vendor sits there unnamed; nothing a vendor typed is markup.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { PublicMapAnswer } from '@/components/daymap/dayMap';
import PublicMapTableCard from '@/components/publicmap/PublicMapTableCard.vue';
import { dayInWords, tableCard } from '@/utils/publicMap';
import { ANSWER, TODAY, TOMORROW } from './support/publicMapAnswer';

/** The card of one table on one day, as the page mounts it. */
function cardOf(tableId: string, date: string = TODAY, map: PublicMapAnswer = ANSWER) {
  return mount(PublicMapTableCard, {
    props: {
      card: tableCard(map, date, tableId)!,
      day: dayInWords(date),
      hallName: 'Upper Hall',
      paint: null,
    },
  });
}

describe("a table's card", () => {
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
    expect(card.text()).toContain('Website');
    expect(card.text()).toContain('Instagram');
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
      'Table Gold row 3A vendor is at this table. Their details are not listed.',
    );
  });

  it('says a free table is free on the day, in words', () => {
    const card = cardOf('g1', TOMORROW);
    expect(card.text()).toBe('Table Gold row 1This table is free on Sat 6 Jun.');
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
