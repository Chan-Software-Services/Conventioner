// @vitest-environment happy-dom
/**
 * A vendor's account on the drawer's Payment tab is theirs (T421, T277 ticket 11): the tab reads
 * the account keyed by market and vendor, so moving the drawer from Ana to Ben shows Ben's tab
 * loading and then Ben's account, never Ana's late answer, and a dialog's answer is taken only into
 * the account it was opened on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import VendorPaymentTab from '@/components/VendorPaymentTab.vue';
import type { Payment, VendorAccount } from '@/utils/payments';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

function held<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

const ENTRY: Payment = {
  id: 'p1',
  kind: 'payment',
  cents: 1000,
  method: 'cash',
  paidOn: '2099-04-01',
  note: '',
  recordedBy: 'editor@example.com',
  recordedAt: '2099-04-01T18:00:00+00:00',
  editedBy: null,
  editedAt: null,
  removedBy: null,
  removedAt: null,
};

function account(owedCents: number, payments: Payment[] = []): VendorAccount {
  return {
    currency: 'CAD',
    lines: [],
    payments,
    owedCents,
    paidCents: 0,
    balanceState: 'owes',
    compares: true,
  };
}

const q = <T extends HTMLElement = HTMLElement>(testid: string) =>
  document.querySelector<T>(`[data-testid="${testid}"]`);

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  api.get.mockReset();
  api.post.mockReset();
  api.put.mockReset();
  api.delete.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/** The tab open on Ana, her account read and shown. */
async function onAna(ana: VendorAccount, ben: Promise<unknown>) {
  api.get.mockImplementation((url: string) =>
    url.includes('ana') ? Promise.resolve({ data: ana }) : ben,
  );
  wrapper = mount(VendorPaymentTab, {
    props: { marketId: 'm-a', email: 'ana@example.com', canRecord: true, canAdjustPaid: true },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

describe("the drawer's Payment tab never shows one vendor's account on another's", () => {
  it("drops Ana's late account landing after the drawer moved to Ben", async () => {
    const ana = held<unknown>();
    const ben = held<unknown>();
    api.get.mockImplementation((url: string) => (url.includes('ana') ? ana.promise : ben.promise));
    wrapper = mount(VendorPaymentTab, {
      props: { marketId: 'm-a', email: 'ana@example.com', canRecord: true },
      attachTo: document.body,
    });
    await flushPromises();
    await wrapper.setProps({ email: 'ben@example.com' });
    await flushPromises();
    ben.settle({ data: account(1000) });
    await flushPromises();
    ana.settle({ data: account(999900) });
    await flushPromises();

    expect(wrapper.text()).not.toContain('9,999.00');
    expect(wrapper.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
  });

  it("says Ben's tab is loading on the move, never Ana's totals", async () => {
    const ben = held<unknown>();
    const w = await onAna(account(999900), ben.promise);
    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$9,999.00');

    await w.setProps({ email: 'ben@example.com' });
    await nextTick();

    expect(w.text()).toContain('Loading…');
    expect(w.text()).not.toContain('9,999.00');
    expect(w.find('[data-testid="payment-owed"]').exists()).toBe(false);

    ben.settle({ data: account(1000) });
    await flushPromises();
    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
  });

  it("takes a payment recorded on Ana that answers after the move into nothing on Ben's tab", async () => {
    const w = await onAna(account(3000), Promise.resolve({ data: account(1000) }));
    await w.get('[data-testid="payment-record"]').trigger('click');
    await flushPromises();
    const amount = q<HTMLInputElement>('record-payment-amount')!;
    amount.value = '35';
    amount.dispatchEvent(new Event('input'));
    q<HTMLInputElement>('record-payment-method-cash')!.click();
    await flushPromises();
    const recorded = held<unknown>();
    api.post.mockReturnValueOnce(recorded.promise);
    q<HTMLButtonElement>('record-payment-submit-button')!.click();
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(
      '/markets/m-a/payments/ana%40example.com',
      expect.objectContaining({ cents: 3500 }),
    );

    await w.setProps({ email: 'ben@example.com' });
    await flushPromises();
    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
    expect(q('record-payment-window')).toBeNull();

    recorded.settle({ data: account(999900) });
    await flushPromises();

    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
    expect(w.text()).not.toContain('9,999.00');
    expect(q('record-payment-window')).toBeNull();
  });

  it("takes a removal confirmed on Ana that answers after the move into nothing on Ben's tab", async () => {
    const w = await onAna(account(3000, [ENTRY]), Promise.resolve({ data: account(1000) }));
    await w.get('[data-testid="payment-entry-menu-button"]').trigger('click');
    await w.get('[data-testid="payment-entry-menu-remove"]').trigger('click');
    await flushPromises();
    const removed = held<unknown>();
    api.delete.mockReturnValueOnce(removed.promise);
    q<HTMLFormElement>('payment-confirm-window')!.querySelector('form')!.requestSubmit();
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/markets/m-a/payment-entries/p1');

    await w.setProps({ email: 'ben@example.com' });
    await flushPromises();
    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
    expect(q('payment-confirm-window')).toBeNull();

    removed.settle({ data: account(999900) });
    await flushPromises();

    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
    expect(w.text()).not.toContain('9,999.00');
  });

  it("takes an amount owed changed on Ana that answers after the move into nothing on Ben's tab", async () => {
    const line = {
      date: '2099-05-07',
      tableCode: 'North Wing 1',
      tier: 'Gold',
      tableChoice: 'Full Table',
      priceCents: 3000,
      owedCents: 3000,
      owedSetBy: null,
      owedSetAt: null,
      freed: false,
      freedAt: null,
      freedBy: null,
    };
    api.get.mockImplementation((url: string) =>
      Promise.resolve({
        data: url.includes('ana') ? { ...account(3000), lines: [line] } : account(1000),
      }),
    );
    const w = mount(VendorPaymentTab, {
      props: { marketId: 'm-a', email: 'ana@example.com', canRecord: true, canChangeOwed: true },
      attachTo: document.body,
    });
    wrapper = w;
    await flushPromises();
    await w.get('[data-testid="payment-line-menu-button"]').trigger('click');
    await w.get('[data-testid="payment-line-menu-owed"]').trigger('click');
    await flushPromises();
    const amount = q<HTMLInputElement>('change-owed-amount')!;
    amount.value = '25';
    amount.dispatchEvent(new Event('input'));
    await flushPromises();
    const changed = held<unknown>();
    api.put.mockReturnValueOnce(changed.promise);
    q<HTMLFormElement>('change-owed-window')!.querySelector('form')!.requestSubmit();
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(
      '/markets/m-a/payments/ana%40example.com/owed/2099-05-07',
      { cents: 2500 },
    );

    await w.setProps({ email: 'ben@example.com' });
    await flushPromises();
    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
    expect(q('change-owed-window')).toBeNull();

    changed.settle({ data: account(999900) });
    await flushPromises();

    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
    expect(w.text()).not.toContain('9,999.00');
  });

  it('reads Ana again on coming back to her, never the account last shown for Ben', async () => {
    const w = await onAna(account(3000), Promise.resolve({ data: account(1000) }));
    await w.setProps({ email: 'ben@example.com' });
    await flushPromises();
    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');

    const again = held<unknown>();
    api.get.mockImplementation(() => again.promise);
    await w.setProps({ email: 'ana@example.com' });
    await nextTick();
    expect(w.text()).toContain('Loading…');

    again.settle({ data: account(4000) });
    await flushPromises();
    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$40.00');
    expect(api.get).toHaveBeenLastCalledWith('/markets/m-a/payments/ana%40example.com');
  });
});
