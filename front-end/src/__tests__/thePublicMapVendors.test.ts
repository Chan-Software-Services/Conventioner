// @vitest-environment happy-dom
/**
 * The public map's vendor panel (T422 ticket 09, T465 ticket 06), mounted alone: "Find a vendor", a
 * search whose dropdown offers the vendors the words find, over every vendor of the day, each led
 * by their table's code in their section's colours; a pick or a row's press asks the page to open
 * the vendor, and the list fades under the field only once it has scrolled.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { PublicMapAnswer } from '@/components/daymap/dayMap';
import PublicMapVendors from '@/components/publicmap/PublicMapVendors.vue';
import SearchPicker from '@/components/SearchPicker.vue';
import type { TablePaint } from '@/components/publicmap/publicMapPaint';
import { mapListing } from '@/utils/publicMap';
import { ANSWER, TODAY } from './support/publicMapAnswer';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

const GOLD: TablePaint = { fill: 'rgb(248, 231, 194)', edge: 'rgb(169, 122, 27)' };
const PAINTS: ReadonlyMap<string, TablePaint> = new Map([
  ['g1', GOLD],
  ['g2', GOLD],
]);

function open(
  map: PublicMapAnswer = ANSWER,
  picked: { tableId?: string | null; seatKey?: string | null } = {},
) {
  wrapper = mount(PublicMapVendors, {
    props: {
      map,
      date: TODAY,
      pickedTableId: picked.tableId ?? null,
      pickedSeatKey: picked.seatKey ?? null,
      paints: PAINTS,
    },
    attachTo: document.body,
  });
  return wrapper;
}

const rows = () => wrapper!.findAll('[data-testid="public-map-vendor"]');
const field = () => wrapper!.get<HTMLInputElement>('[data-testid="public-map-find-input"]');
const options = () => wrapper!.findAll('[data-testid="public-map-find-option"]');

async function type(words: string) {
  // happy-dom focuses nothing on an event alone.
  field().element.focus();
  await field().setValue(words);
  await flushPromises();
}

describe('the vendor panel', () => {
  it('is an aside named "Vendors", the search over the list, and says no count', () => {
    const panel = open();
    const aside = panel.get('aside[data-testid="public-map-vendors"]');
    expect(aside.attributes('aria-label')).toBe('Vendors');
    const search = aside.get('[data-testid="public-map-find"]');
    const list = aside.get('[data-testid="public-map-vendors-list"]');
    expect(
      search.element.compareDocumentPosition(list.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(list.element.contains(search.element)).toBe(false);
    expect(panel.find('[data-testid="public-map-vendors-count"]').exists()).toBe(false);
    expect(panel.find('[data-testid="public-map-vendors-find"]').exists()).toBe(false);
    expect(panel.text()).not.toMatch(/\d+ vendors?\b/);
  });

  it('gives the search its words, its cap and its way of finding', () => {
    const panel = open();
    const picker = panel.getComponent(SearchPicker);
    expect(picker.props()).toMatchObject({
      label: 'Find a vendor',
      placeholder: 'Name, table, website or Instagram',
      testid: 'public-map-find',
      modelValue: '',
      clearsOnChoice: true,
      listOver: true,
      cap: 8,
      noneWord: 'No vendor',
    });
    expect(picker.props('groups')).toEqual([
      {
        options: [
          { value: 'g2:left', label: 'Acme Ceramics', detail: 'Table Gold row 2, Upper Hall' },
          { value: 'g2:right', label: 'Bee Candles', detail: 'Table Gold row 2, Upper Hall' },
          { value: 's1:whole', label: 'Cog Prints', detail: 'Table Silver aisle 1, Lower Hall' },
          { value: 'g1:whole', label: 'Kiln & Co', detail: 'Table Gold row 1, Upper Hall' },
        ],
      },
    ]);
    expect(panel.get('label[for]').text()).toBe('Find a vendor');
  });

  it('lists every vendor of the day, each led by their code, then their name over their hall', () => {
    open();
    expect(rows().map((row) => row.text())).toEqual([
      'Gold row 2Acme CeramicsTable Gold row 2, Upper Hall',
      'Gold row 2Bee CandlesTable Gold row 2, Upper Hall',
      'Silver aisle 1Cog PrintsTable Silver aisle 1, Lower Hall',
      'Gold row 1Kiln & CoTable Gold row 1, Upper Hall',
    ]);
    const first = rows()[0]!;
    expect(first.element.tagName).toBe('BUTTON');
    expect(first.attributes('type')).toBe('button');
    expect(first.get('.visually-hidden').text()).toBe('Table Gold row 2,');
  });

  it("paints each code pill in its table's section colours, hidden from a reader", () => {
    open();
    const pill = rows()[0]!.get('[data-testid="public-map-vendor-code"]');
    expect(pill.attributes('aria-hidden')).toBe('true');
    expect(pill.text()).toBe('Gold row 2');
    expect(pill.attributes('style')).toContain(`background: ${GOLD.fill}`);
    expect(pill.attributes('style')).toContain(`border-color: ${GOLD.edge}`);
    const unpainted = rows()[2]!.get('[data-testid="public-map-vendor-code"]');
    expect(unpainted.attributes('style')).toBeUndefined();
  });

  it('does not filter the list as the search is typed in', async () => {
    open();
    await type('cog');
    expect(options().map((option) => option.text())).toEqual([
      'Cog PrintsTable Silver aisle 1, Lower Hall',
    ]);
    expect(rows()).toHaveLength(4);
  });

  it('finds by public fields alone, and says "No vendor matches" for other words', async () => {
    open();
    await type('@example_acme');
    expect(options().map((option) => option.attributes('data-value'))).toEqual(['g2:left']);
    await type('gold row 1');
    expect(options().map((option) => option.attributes('data-value'))).toEqual(['g1:whole']);
    await type('upper hall');
    expect(options()).toHaveLength(0);
    expect(wrapper!.get('[data-testid="public-map-find-none"]').text()).toBe(
      'No vendor matches "upper hall".',
    );
  });

  it('asks the page to open a vendor picked from the dropdown, and empties the field', async () => {
    const panel = open();
    await type('cog');
    await options()[0]!.trigger('click');
    await flushPromises();
    expect(panel.emitted('open')).toEqual([[mapListing(ANSWER, TODAY)[2]]]);
    expect(field().element.value).toBe('');
    expect(document.activeElement).toBe(field().element);
    expect(panel.find('[data-testid="public-map-find-list"]').exists()).toBe(false);
  });

  it('asks the page to open a vendor when their row is pressed', async () => {
    const panel = open();
    await rows()[2]!.trigger('click');
    expect(panel.emitted('open')).toEqual([[mapListing(ANSWER, TODAY)[2]]]);
    expect(panel.emitted('open')![0]![0]).toMatchObject({ name: 'Cog Prints', tableId: 's1' });
  });

  it('marks the seat picked alone as current', () => {
    open(ANSWER, { tableId: 'g2', seatKey: 'g2:right' });
    expect(rows().map((row) => row.attributes('aria-current') ?? null)).toEqual([
      null,
      'true',
      null,
      null,
    ]);
  });

  it('marks every row at the table picked as current when no seat is picked alone', () => {
    open(ANSWER, { tableId: 'g2' });
    expect(rows().map((row) => row.attributes('aria-current') ?? null)).toEqual([
      'true',
      'true',
      null,
      null,
    ]);
  });

  it('draws the fade only once the list has scrolled', async () => {
    const panel = open();
    const fade = () => panel.find('[data-testid="public-map-vendors-fade"]');
    const scroller = panel.get('[data-testid="public-map-vendors-list"]').element as HTMLElement;
    expect(fade().exists()).toBe(false);

    scroller.scrollTop = 200;
    scroller.dispatchEvent(new Event('scroll'));
    await flushPromises();
    expect(fade().exists()).toBe(true);
    expect(fade().attributes('aria-hidden')).toBe('true');

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await flushPromises();
    expect(fade().exists()).toBe(false);
  });

  it('says so when no vendor is listed for the day, and the search never opens', async () => {
    const panel = open({ ...ANSWER, seats: [] });
    expect(panel.get('[data-testid="public-map-vendors-empty"]').text()).toBe(
      'No vendors are listed for this day yet.',
    );
    expect(rows()).toHaveLength(0);
    await field().trigger('click');
    await type('a');
    expect(panel.find('[data-testid="public-map-find-list"]').exists()).toBe(false);
  });
});
