/**
 * The Public map card on the Tools tab (T422, D25, D26, D30).
 *
 * An Admin chooses which of the form's short text questions hold each vendor's public name, website
 * and Instagram handle, and turns the map on; each change saves at once and the market is read
 * again. The card says what the map shows and never shows, what is still missing before it opens,
 * and once on its address to copy and open. Anyone the "Publish the map" row refuses reads the card
 * with every control disabled, and why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';

import MarketPublicMapCard from '@/components/market/MarketPublicMapCard.vue';
import type { Market, PublicMapSettings } from '@/assets/types/datatypes';
import { MarketAction } from '@/utils/marketActions';
import { layoutPath } from '@/utils/market';
import { EDITOR_ANSWERS, answersRefusing } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

const FIELDS = [
  { key: 'shop', label: 'Shop name', type: 'text', required: true, options: [], order: 0 },
  { key: 'site', label: 'Your website', type: 'text', required: false, options: [], order: 1 },
  { key: 'insta', label: 'Instagram handle', type: 'text', required: false, options: [], order: 2 },
  { key: 'days', label: 'Days', type: 'select', required: true, options: ['One'], order: 3 },
];

const HALL = { id: 'loc-hall', name: 'Main Hall' };
const GOLD = { id: 'sec-gold', name: 'Gold', location: HALL, tier: null, count: 2 };

/** A plan whose one location is laid out as the map draws it: a scale, and a table numbered in
 * one of the location's sections. */
function laidOut(table: { sectionId: string | null; number: number | null } = GOLD_TABLE) {
  return {
    locations: [HALL],
    sections: [GOLD],
    floorplans: [
      {
        id: 'fp-hall',
        locationId: HALL.id,
        revision: 1,
        scalePxPerUnit: 0.5,
        tables: [{ id: 't1', tableTypeId: 'tt', xMm: 0, yMm: 0, rotation: 0, ...table }],
        zones: [],
        sectionStyles: [],
        startingCounts: [],
      },
    ],
  };
}
const GOLD_TABLE = { sectionId: GOLD.id, number: 1 };

const OFF: PublicMapSettings = {
  enabled: false,
  nameQuestion: null,
  websiteQuestion: null,
  instagramQuestion: null,
};

function market(overrides: Record<string, unknown> = {}, ...refused: MarketAction[]): Market {
  return {
    id: 'market-123',
    name: 'Riverside Spring',
    slug: 'riverside-spring',
    phase: 'market_days',
    resultsPublished: true,
    roles: {},
    applicationForm: { fields: FIELDS },
    setupObject: laidOut(),
    publicMap: OFF,
    actionRefusals: answersRefusing(...refused),
    ...overrides,
  } as unknown as Market;
}

function card(props: Market) {
  return mount(MarketPublicMapCard, {
    props: { market: props },
    attachTo: document.body,
    global: { stubs: { RouterLink: RouterLinkStub } },
  });
}
type Card = ReturnType<typeof card>;

const find = (wrapper: Card, id: string) => wrapper.find(`[data-testid="${id}"]`);
const select = (wrapper: Card, which: string) =>
  find(wrapper, `public-map-${which}-select`).element as HTMLSelectElement;
const theSwitch = (wrapper: Card) => find(wrapper, 'public-map-switch').element as HTMLInputElement;

async function choose(wrapper: Card, which: string, value: string): Promise<void> {
  const element = select(wrapper, which);
  element.value = value;
  await find(wrapper, `public-map-${which}-select`).trigger('change');
  await flushPromises();
}

async function flip(wrapper: Card): Promise<void> {
  const element = theSwitch(wrapper);
  element.checked = !element.checked;
  await find(wrapper, 'public-map-switch').trigger('change');
  await flushPromises();
}

const refusedWith = (error: string) => ({
  isAxiosError: true,
  response: { status: 400, data: { error } },
});

let wrapper: Card | undefined;

beforeEach(() => {
  for (const call of Object.values(api)) call.mockReset();
  api.put.mockResolvedValue({ data: { publicMap: OFF } });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe('what the card says', () => {
  it('says what the map shows and never shows, and offers three pickers and the switch', () => {
    wrapper = card(market());

    expect(wrapper.find('h2').text()).toBe('Public map');
    expect(find(wrapper, 'public-map-lead').text()).toBe(
      'A page anyone can open, with no sign-in, that shows each market day’s tables and who is ' +
        'at them. It shows only the answers you choose here, never an email address or a full name.',
    );
    for (const [which, label] of [
      ['name', 'Public name'],
      ['website', 'Website'],
      ['instagram', 'Instagram'],
    ]) {
      const element = select(wrapper, which);
      expect(wrapper.find(`label[for="${element.id}"]`).text()).toBe(label);
      // "Not shown" first, then the form's short text questions alone, in the form's order.
      expect([...element.options].map((option) => option.text.trim())).toEqual([
        'Not shown',
        'Shop name',
        'Your website',
        'Instagram handle',
      ]);
      expect(element.value).toBe('');
    }
    expect(find(wrapper, 'public-map-name-help').text()).toBe(
      'The question that holds each vendor’s business or artist name.',
    );
    expect(select(wrapper, 'name').getAttribute('aria-describedby')).toContain(
      find(wrapper, 'public-map-name-help').attributes('id'),
    );
    expect(wrapper.find('label[for="public-map-switch"]').text()).toBe('Show the public map');
    expect(theSwitch(wrapper).getAttribute('role')).toBe('switch');
  });

  it('shows each stored question, and a question the form lost as not shown', () => {
    wrapper = card(
      market({
        publicMap: {
          ...OFF,
          nameQuestion: 'shop',
          websiteQuestion: 'site',
          instagramQuestion: 'gone',
        },
      }),
    );

    expect(select(wrapper, 'name').value).toBe('shop');
    expect(select(wrapper, 'website').value).toBe('site');
    expect(select(wrapper, 'instagram').value).toBe('');
  });

  it('reads a market never set as off, with nothing chosen', () => {
    wrapper = card(market({ publicMap: null }));

    expect(select(wrapper, 'name').value).toBe('');
    expect(theSwitch(wrapper).checked).toBe(false);
  });
});

describe('a change saves at once', () => {
  it('saves a question as it is chosen, and has the market read again', async () => {
    wrapper = card(market());
    await choose(wrapper, 'name', 'shop');

    expect(api.put).toHaveBeenCalledWith('/markets/market-123/public-map', {
      nameQuestion: 'shop',
    });
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });

  it('saves "Not shown" as no question', async () => {
    wrapper = card(market({ publicMap: { ...OFF, websiteQuestion: 'site' } }));
    await choose(wrapper, 'website', '');

    expect(api.put).toHaveBeenCalledWith('/markets/market-123/public-map', {
      websiteQuestion: null,
    });
  });

  it('says a refusal in the card`s error line, and puts the picker back to what is stored', async () => {
    api.put.mockRejectedValue(refusedWith("Choose one of the form's short text questions."));
    wrapper = card(market({ publicMap: { ...OFF, nameQuestion: 'shop' } }));
    await choose(wrapper, 'name', 'site');

    expect(find(wrapper, 'public-map-save-error').text()).toBe(
      "Choose one of the form's short text questions.",
    );
    expect(select(wrapper, 'name').value).toBe('shop');
    expect(wrapper.emitted('changed')).toBeUndefined();
  });

  it('clears the error line on the next change that saves', async () => {
    api.put.mockRejectedValueOnce(refusedWith('No.'));
    wrapper = card(market());
    await choose(wrapper, 'website', 'site');
    expect(find(wrapper, 'public-map-save-error').exists()).toBe(true);

    await choose(wrapper, 'website', 'site');
    expect(find(wrapper, 'public-map-save-error').exists()).toBe(false);
  });
});

describe('the switch', () => {
  it('is disabled, and says why, while no public name is chosen', () => {
    wrapper = card(market());

    expect(theSwitch(wrapper).disabled).toBe(true);
    expect(find(wrapper, 'public-map-switch-reason').text()).toBe(
      'Choose the public name’s question first.',
    );
    expect(theSwitch(wrapper).getAttribute('aria-describedby')).toBe(
      find(wrapper, 'public-map-switch-reason').attributes('id'),
    );
  });

  it('turns the map on once a name is chosen', async () => {
    wrapper = card(market({ publicMap: { ...OFF, nameQuestion: 'shop' } }));
    expect(theSwitch(wrapper).disabled).toBe(false);
    expect(find(wrapper, 'public-map-switch-reason').exists()).toBe(false);

    await flip(wrapper);
    expect(api.put).toHaveBeenCalledWith('/markets/market-123/public-map', { enabled: true });
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });

  it('turns an open map off, even with its name question gone from the form', async () => {
    wrapper = card(market({ publicMap: { ...OFF, enabled: true, nameQuestion: 'gone' } }));
    expect(theSwitch(wrapper).checked).toBe(true);
    expect(theSwitch(wrapper).disabled).toBe(false);

    await flip(wrapper);
    expect(api.put).toHaveBeenCalledWith('/markets/market-123/public-map', { enabled: false });
  });

  it('says a refusal and goes back to off', async () => {
    api.put.mockRejectedValue(refusedWith('Not now.'));
    wrapper = card(market({ publicMap: { ...OFF, nameQuestion: 'shop' } }));
    await flip(wrapper);

    expect(find(wrapper, 'public-map-save-error').text()).toBe('Not now.');
    expect(theSwitch(wrapper).checked).toBe(false);
  });
});

describe('a person the row refuses', () => {
  it('reads the card with every control disabled and the row`s sentence', async () => {
    const settings = { ...OFF, enabled: true, nameQuestion: 'shop' };
    wrapper = card(market({ publicMap: settings, actionRefusals: EDITOR_ANSWERS }));

    for (const which of ['name', 'website', 'instagram']) {
      expect(select(wrapper, which).disabled).toBe(true);
    }
    expect(select(wrapper, 'name').value).toBe('shop');
    expect(theSwitch(wrapper).disabled).toBe(true);
    expect(theSwitch(wrapper).checked).toBe(true);
    expect(find(wrapper, 'public-map-refusal').text()).toBe(
      EDITOR_ANSWERS[MarketAction.PublishMap],
    );
    // Why the switch is disabled is the row's sentence, not a missing name.
    expect(find(wrapper, 'public-map-switch-reason').exists()).toBe(false);
    // The address is still the market's to read and share.
    expect(find(wrapper, 'public-map-address').exists()).toBe(true);
  });

  it('says an archived market`s map is closed, in place of the archived sentence', () => {
    wrapper = card(market({ phase: 'archived' }, MarketAction.PublishMap));

    expect(find(wrapper, 'public-map-missing').text()).toBe('An archived market’s map is closed.');
    expect(find(wrapper, 'public-map-refusal').exists()).toBe(false);
    expect(select(wrapper, 'name').disabled).toBe(true);
    expect(theSwitch(wrapper).disabled).toBe(true);
  });
});

describe('while the map is on', () => {
  const ON = { ...OFF, enabled: true, nameQuestion: 'shop' };

  it('shows nothing of an address while off', () => {
    wrapper = card(market({ publicMap: { ...ON, enabled: false } }));
    expect(find(wrapper, 'public-map-address').exists()).toBe(false);
  });

  it('shows its address, opens it in a new tab, and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    wrapper = card(market({ publicMap: ON }));
    const address = `${window.location.origin}/riverside-spring`;

    expect(find(wrapper, 'public-map-url').text()).toBe(address);
    const open = find(wrapper, 'public-map-open');
    expect(open.text()).toBe('Open the map');
    expect(open.attributes()).toMatchObject({
      href: address,
      target: '_blank',
      rel: 'noopener noreferrer',
    });

    const copy = find(wrapper, 'public-map-copy');
    expect(copy.text()).toBe('Copy link');
    await copy.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(address);
    expect(copy.text()).toBe('Copied');
  });
});

describe('what is still missing', () => {
  it('says a location must be laid out first, linked to the layout page', () => {
    wrapper = card(market({ setupObject: { ...laidOut(), floorplans: [] } }));

    const missing = find(wrapper, 'public-map-missing');
    expect(missing.text()).toContain(
      'Lay out a location first: the map draws the market’s layouts.',
    );
    expect(wrapper.findComponent(RouterLinkStub).props('to')).toBe(layoutPath('market-123'));
  });

  it.each([
    [
      'a layout with no scale',
      { ...laidOut(), floorplans: [{ ...laidOut().floorplans[0], scalePxPerUnit: null }] },
    ],
    ['tables in no section', laidOut({ sectionId: null, number: null })],
    ['tables with no number', laidOut({ sectionId: GOLD.id, number: null })],
    [
      'tables in another location`s section',
      { ...laidOut(), sections: [{ ...GOLD, location: { id: 'loc-other', name: 'Annex' } }] },
    ],
  ])('takes %s for no location laid out', (_name, setupObject) => {
    wrapper = card(market({ setupObject }));
    expect(find(wrapper, 'public-map-layout-link').exists()).toBe(true);
  });

  it('says the map opens with the results, once a location is laid out', () => {
    wrapper = card(market({ phase: 'assignment', resultsPublished: false }));
    expect(find(wrapper, 'public-map-missing').text()).toBe(
      'The map opens once results are published.',
    );
  });

  it('says the first that applies: the layout before the results', () => {
    wrapper = card(
      market({
        phase: 'assignment',
        resultsPublished: false,
        setupObject: { ...laidOut(), floorplans: [] },
      }),
    );
    expect(find(wrapper, 'public-map-missing').text()).toContain('Lay out a location first');
    expect(find(wrapper, 'public-map-missing').text()).not.toContain('results');
  });

  it('takes a market that reached its market days for results out', () => {
    wrapper = card(
      market({
        phase: 'archived',
        resultsPublished: false,
        phasesReached: ['market_days'],
      }),
    );
    expect(find(wrapper, 'public-map-missing').text()).toBe('An archived market’s map is closed.');

    wrapper.unmount();
    wrapper = card(market({ phase: 'market_days', resultsPublished: false }));
    expect(find(wrapper, 'public-map-missing').exists()).toBe(false);
  });

  it('says nothing is missing on a market whose map can open', () => {
    wrapper = card(market());
    expect(find(wrapper, 'public-map-missing').exists()).toBe(false);
  });
});

describe('a form with no short text question', () => {
  it('offers only "Not shown", and says what to add', () => {
    wrapper = card(market({ applicationForm: { fields: [FIELDS[3]] } }));

    expect([...select(wrapper, 'name').options].map((option) => option.text.trim())).toEqual([
      'Not shown',
    ]);
    expect(find(wrapper, 'public-map-no-questions').text()).toBe(
      'The form asks no short text question yet. Add one that asks for each vendor’s business name.',
    );
  });
});
