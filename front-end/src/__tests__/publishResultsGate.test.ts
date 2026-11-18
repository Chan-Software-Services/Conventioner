/**
 * `Publish results` on both kinds of market (E36/F04/S01, ADR 0022).
 *
 * It flips `resultsPublished`, which is what turns a vendor's "Submitted" into their outcome on
 * their vendor page. A Google Form market's vendors read their table on the same page, which opens
 * with its results, so the control is offered on it under the same rule as on a market whose
 * vendors apply on its page.
 */
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PublishResults from '@/components/application/PublishResults.vue';
import { IntakeMode, MarketPhase, type Market } from '@/assets/types/datatypes';
import { MarketAction } from '@/utils/marketActions';
import { answersRefusing } from './support/servedAnswers';

const publishResults = vi.fn();

// A publish is followed by a re-read of the market, which is the store's to do.
vi.mock('@/stores/market', () => ({ useMarketStore: () => ({ refresh: vi.fn() }) }));
vi.mock('@/utils/applicantApi', () => ({
  publishResults: (id: string) => publishResults(id),
}));

function marketTaking(intakeMode?: IntakeMode, publish: Partial<Market> = {}): Market {
  return {
    id: 'm1',
    applicationForm: { fields: [] },
    intakeMode,
    actionRefusals: answersRefusing(),
    publishWaitsReason: null,
    publishOutcomes: { haveATable: 3, notAssigned: 2 },
    phase: MarketPhase.Assignment,
    ...publish,
  } as unknown as Market;
}

async function mounted(market: Market) {
  // The dialog teleports to the body; stubbed, it renders in place, where the wrapper reads it.
  const wrapper = mount(PublishResults, {
    props: { market },
    global: { stubs: { teleport: true } },
  });
  await wrapper.vm.$nextTick();
  return wrapper;
}

const button = '[data-testid="applications-publish-button"]';
const hint = '[data-testid="applications-publish-hint"]';

describe('a Google Form market (ADR 0022)', () => {
  it('offers the Publish results control once the server would take it', async () => {
    const wrapper = await mounted(marketTaking(IntakeMode.Csv));

    expect(wrapper.find(button).exists()).toBe(true);
    expect(wrapper.find<HTMLButtonElement>(button).element.disabled).toBe(false);
  });

  it('offers it on a market that names no intake mode, which reads as CSV', async () => {
    const wrapper = await mounted(marketTaking(undefined));

    expect(wrapper.find(button).exists()).toBe(true);
  });

  it("disables it with the server's reason until results may be published", async () => {
    const reason = 'Allocate tables first: results tell each applicant whether they have a table.';
    const wrapper = await mounted(
      marketTaking(IntakeMode.Csv, { publishWaitsReason: reason, publishOutcomes: null }),
    );

    expect(wrapper.find<HTMLButtonElement>(button).element.disabled).toBe(true);
    expect(wrapper.find(hint).text()).toBe(reason);
  });
});

describe('a form-intake market (E36/F04/S01)', () => {
  it('offers the control once the server would take it', async () => {
    const wrapper = await mounted(marketTaking(IntakeMode.Form));

    expect(wrapper.find(button).exists()).toBe(true);
    expect(wrapper.find<HTMLButtonElement>(button).element.disabled).toBe(false);
    expect(wrapper.find(button).text()).toBe('Publish results');
  });

  it("disables it with the server's reason until results may be published", async () => {
    const reason = 'Allocate tables first: results tell each applicant whether they have a table.';
    const wrapper = await mounted(
      marketTaking(IntakeMode.Form, { publishWaitsReason: reason, publishOutcomes: null }),
    );

    expect(wrapper.find<HTMLButtonElement>(button).element.disabled).toBe(true);
    expect(wrapper.find(hint).text()).toBe(reason);
  });

  it('confirms with how many will read each outcome before publishing', async () => {
    const wrapper = await mounted(marketTaking(IntakeMode.Form));

    await wrapper.find(button).trigger('click');
    const confirm = wrapper.find('[data-testid="publish-results-window"]');
    expect(confirm.text()).toContain('3 vendors will read "You have a table"');
    expect(confirm.text()).toContain('2 will read "You did not get assigned"');
    expect(publishResults).not.toHaveBeenCalled();

    await wrapper.find('[data-testid="publish-results-submit-button"]').trigger('submit');
    expect(publishResults).toHaveBeenCalledWith('m1');
  });
});

describe('publishing, confirmed (T411)', () => {
  const byId = (wrapper: Awaited<ReturnType<typeof mounted>>, id: string) =>
    wrapper.find(`[data-testid="${id}"]`);
  const press = (wrapper: Awaited<ReturnType<typeof mounted>>) =>
    wrapper.get('[data-testid="publish-results-window"] form').trigger('submit');

  it('holds while it publishes, and publishes once however often pressed', async () => {
    publishResults.mockReset();
    const published = Promise.withResolvers<unknown>();
    publishResults.mockReturnValue(published.promise);
    const wrapper = await mounted(marketTaking(IntakeMode.Form));
    await wrapper.find(button).trigger('click');

    await press(wrapper);
    await press(wrapper);
    await byId(wrapper, 'publish-results-cancel-button').trigger('click');
    await byId(wrapper, 'publish-results-close-button').trigger('click');
    await byId(wrapper, 'publish-results-background').trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();

    expect(byId(wrapper, 'publish-results-window').exists()).toBe(true);
    expect(byId(wrapper, 'publish-results-submit-button').text()).toBe('Publishing…');
    expect(byId(wrapper, 'publish-results-submit-button').attributes('disabled')).toBeDefined();
    expect(publishResults).toHaveBeenCalledTimes(1);

    published.resolve(undefined);
    await flushPromises();
    expect(byId(wrapper, 'publish-results-window').exists()).toBe(false);
    expect(byId(wrapper, 'applications-published-badge').exists()).toBe(true);
  });

  it('says a refusal in the dialog, and a new opening starts with none', async () => {
    publishResults.mockReset().mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { error: 'Results wait for a current run.' } },
    });
    const wrapper = await mounted(marketTaking(IntakeMode.Form));
    await wrapper.find(button).trigger('click');
    await press(wrapper);
    await flushPromises();
    expect(byId(wrapper, 'publish-results-error').text()).toBe('Results wait for a current run.');

    await byId(wrapper, 'publish-results-cancel-button').trigger('click');
    expect(wrapper.text()).not.toContain('Results wait for a current run.');
    await wrapper.find(button).trigger('click');

    expect(byId(wrapper, 'publish-results-window').exists()).toBe(true);
    expect(byId(wrapper, 'publish-results-error').exists()).toBe(false);
  });
});

describe("where vendors read it: the market's vendor page (ADR 0022)", () => {
  const withSlug = () => marketTaking(IntakeMode.Form, { slug: 'spring-market' });

  it('says beside the button that vendors read it on the vendor page and no email is sent', async () => {
    const wrapper = await mounted(withSlug());

    expect(wrapper.find(hint).text()).toBe(
      "Vendors read whether they have a table on the market's vendor page. No email is sent.",
    );
  });

  it("confirms with the telling and the page's address to share", async () => {
    const wrapper = await mounted(withSlug());

    await wrapper.find(button).trigger('click');
    const confirm = wrapper.find('[data-testid="publish-results-window"]');
    expect(confirm.find('[data-testid="publish-results-telling"]').text()).toContain(
      'No email is sent',
    );
    const address = confirm.find('[data-testid="publish-results-address-url"]');
    expect(address.text()).toBe(`${window.location.origin}/spring-market/vendor`);
    expect(address.attributes('href')).toBe(`${window.location.origin}/spring-market/vendor`);
  });

  it('copies the address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const wrapper = await mounted(withSlug());

    await wrapper.find(button).trigger('click');
    const copy = wrapper.find('[data-testid="publish-results-address-copy"]');
    await copy.trigger('click');
    await wrapper.vm.$nextTick();

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/spring-market/vendor`);
    expect(copy.text()).toBe('Copied');
    vi.unstubAllGlobals();
  });
});

describe('before the assignment (E38/F05, Daniel on 2026-10-29)', () => {
  it.each([MarketPhase.Draft, MarketPhase.Applications])(
    'offers no Publish results, not even a disabled one, in %s',
    async (phase) => {
      const wrapper = await mounted(marketTaking(IntakeMode.Form, { phase }));

      expect(wrapper.find(button).exists()).toBe(false);
      expect(wrapper.find(hint).exists()).toBe(false);
    },
  );

  it('offers it again from the assignment on', async () => {
    const days = await mounted(marketTaking(IntakeMode.Form, { phase: MarketPhase.MarketDays }));
    expect(days.find(button).exists()).toBe(true);
  });
});

describe('once published (T466, release walk F7)', () => {
  it.each([MarketPhase.Assignment, MarketPhase.Offers])(
    'says so quietly in %s, a dot and the words, with no button',
    async (phase) => {
      const wrapper = await mounted(
        marketTaking(IntakeMode.Form, { phase, resultsPublished: true }),
      );

      const status = wrapper.get('[data-testid="applications-published-badge"]');
      expect(status.text()).toBe('Results published · vendors can see them');
      expect(status.classes()).not.toContain('chip');
      expect(status.find('.publish-status-dot').attributes('aria-hidden')).toBe('true');
      expect(wrapper.find(button).exists()).toBe(false);
      expect(wrapper.find(hint).exists()).toBe(false);
    },
  );

  it('says nothing in market days, where results are out by definition', async () => {
    const wrapper = await mounted(
      marketTaking(IntakeMode.Form, { phase: MarketPhase.MarketDays, resultsPublished: true }),
    );

    expect(wrapper.html()).toBe('<!--v-if-->');
  });
});

describe('who may publish: the Publish results row (E39/F01, E38/F05)', () => {
  it('offers none to someone the row refuses', async () => {
    const wrapper = await mounted(
      marketTaking(IntakeMode.Form, {
        actionRefusals: answersRefusing(MarketAction.PublishResults),
      }),
    );

    expect(wrapper.find(button).exists()).toBe(false);
  });

  it('offers none on a market read that does not say who may', async () => {
    const wrapper = await mounted(marketTaking(IntakeMode.Form, { actionRefusals: undefined }));

    expect(wrapper.find(button).exists()).toBe(false);
  });

  it('asks its own row, not the one that moves the phase', async () => {
    const wrapper = await mounted(
      marketTaking(IntakeMode.Form, { actionRefusals: answersRefusing(MarketAction.MovePhase) }),
    );

    expect(wrapper.find(button).exists()).toBe(true);
  });
});
