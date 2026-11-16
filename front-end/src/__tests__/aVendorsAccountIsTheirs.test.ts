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
import { PAYMENT_WRITTEN, type Payment, type VendorAccount } from '@/utils/payments';

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

    expect(w.emitted('changed')).toBeUndefined();
    recorded.settle({ data: account(999900) });
    await flushPromises();

    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
    expect(w.text()).not.toContain('9,999.00');
    expect(q('record-payment-window')).toBeNull();
    // Payments is told once to read its totals again, the payment being recorded on Ana.
    expect(w.emitted('changed')).toHaveLength(1);
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

    expect(w.emitted('changed')).toBeUndefined();
    removed.settle({ data: account(999900) });
    await flushPromises();

    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
    expect(w.text()).not.toContain('9,999.00');
    // Payments is told once to read its totals again, the payment being removed on Ana.
    expect(w.emitted('changed')).toHaveLength(1);
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

    expect(w.emitted('changed')).toBeUndefined();
    changed.settle({ data: account(999900) });
    await flushPromises();

    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
    expect(w.text()).not.toContain('9,999.00');
    expect(w.emitted('changed')).toHaveLength(1);
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

describe('a payment written from a dialog', () => {
  const written = vi.fn();

  /** The tab on Ana inside a page that hears of a write that outlived the tab (Payments). */
  async function onAnaInAPage(
    ana: VendorAccount = account(3000),
    may: { canChangeOwed?: boolean; canAdjustPaid?: boolean } = {},
  ): Promise<VueWrapper> {
    written.mockReset();
    api.get.mockImplementation((url: string) =>
      Promise.resolve({ data: url.includes('ana') ? ana : account(1000) }),
    );
    wrapper = mount(VendorPaymentTab, {
      props: { marketId: 'm-a', email: 'ana@example.com', canRecord: true, ...may },
      attachTo: document.body,
      global: { provide: { [PAYMENT_WRITTEN as symbol]: written } },
    });
    await flushPromises();
    return wrapper;
  }

  /** Record $35 cash on Ana, its answer held. */
  async function recordOnAna(w: VueWrapper) {
    await w.get('[data-testid="payment-record"]').trigger('click');
    await flushPromises();
    const amount = q<HTMLInputElement>('record-payment-amount')!;
    amount.value = '35';
    amount.dispatchEvent(new Event('input'));
    q<HTMLInputElement>('record-payment-method-cash')!.click();
    await flushPromises();
    let settle!: (value: unknown) => void;
    let refuse!: (error: unknown) => void;
    api.post.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        settle = resolve;
        refuse = reject;
      }),
    );
    q<HTMLButtonElement>('record-payment-submit-button')!.click();
    await flushPromises();
    return { settle, refuse };
  }

  it('answered on the tab it was made on tells Payments once, through the tab', async () => {
    const w = await onAnaInAPage();
    const recorded = await recordOnAna(w);

    recorded.settle({ data: account(-500) });
    await flushPromises();

    expect(w.emitted('changed')).toHaveLength(1);
    expect(written).not.toHaveBeenCalled();
  });

  it('answering once the tab is gone, the drawer closed, tells Payments through the page', async () => {
    const w = await onAnaInAPage();
    const recorded = await recordOnAna(w);

    w.unmount();
    wrapper = null;
    recorded.settle({ data: account(-500) });
    await flushPromises();

    expect(written).toHaveBeenCalledTimes(1);
  });

  it("answering after a move away and back to Ana, past her re-read, reads Ana's account again", async () => {
    const w = await onAnaInAPage();
    const recorded = await recordOnAna(w);
    await w.setProps({ email: 'ben@example.com' });
    await flushPromises();

    // Back on Ana while the payment is still out: her re-read answers first, read before the
    // payment was stored.
    const reread = held<unknown>();
    api.get.mockImplementation(() => reread.promise);
    await w.setProps({ email: 'ana@example.com' });
    await nextTick();
    reread.settle({ data: account(3000) });
    await flushPromises();
    expect(w.get('[data-testid="payment-paid"]').text()).toBe('$0.00');

    const afterThePayment = { ...account(3000), paidCents: 3500 };
    api.get.mockImplementation(() => Promise.resolve({ data: afterThePayment }));
    recorded.settle({ data: afterThePayment });
    await flushPromises();

    const anasReads = api.get.mock.calls.filter(
      ([url]) => url === '/markets/m-a/payments/ana%40example.com',
    );
    expect(anasReads).toHaveLength(3);
    expect(w.get('[data-testid="payment-paid"]').text()).toBe('$35.00');
    expect(w.emitted('changed')).toHaveLength(1);
    expect(written).not.toHaveBeenCalled();
  });

  it('answering after a move to Ben reads nothing more for Ben', async () => {
    const w = await onAnaInAPage();
    const recorded = await recordOnAna(w);
    await w.setProps({ email: 'ben@example.com' });
    await flushPromises();
    const reads = api.get.mock.calls.length;

    recorded.settle({ data: { ...account(3000), paidCents: 3500 } });
    await flushPromises();

    expect(api.get.mock.calls.length).toBe(reads);
    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
    expect(w.emitted('changed')).toHaveLength(1);
  });

  it('a removal confirmed on Ana, answering once the tab is gone, tells Payments through the page', async () => {
    const w = await onAnaInAPage(account(3000, [ENTRY]), { canAdjustPaid: true });
    await w.get('[data-testid="payment-entry-menu-button"]').trigger('click');
    await w.get('[data-testid="payment-entry-menu-remove"]').trigger('click');
    await flushPromises();
    const removed = held<unknown>();
    api.delete.mockReturnValueOnce(removed.promise);
    q<HTMLFormElement>('payment-confirm-window')!.querySelector('form')!.requestSubmit();
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/markets/m-a/payment-entries/p1');

    w.unmount();
    wrapper = null;
    removed.settle({ data: account(3000) });
    await flushPromises();

    expect(written).toHaveBeenCalledTimes(1);
  });

  it('the calculated price used on Ana, answering once the tab is gone, tells Payments through the page', async () => {
    const line = {
      date: '2099-05-07',
      tableCode: 'North Wing 1',
      tier: 'Gold',
      tableChoice: 'Full Table',
      priceCents: 3000,
      owedCents: 2500,
      owedSetBy: 'admin@example.com',
      owedSetAt: '2099-04-01T18:00:00+00:00',
      freed: false,
      freedAt: null,
      freedBy: null,
    };
    const w = await onAnaInAPage({ ...account(2500), lines: [line] }, { canChangeOwed: true });
    await w.get('[data-testid="payment-line-menu-button"]').trigger('click');
    await w.get('[data-testid="payment-line-menu-calculated"]').trigger('click');
    await flushPromises();
    const used = held<unknown>();
    api.delete.mockReturnValueOnce(used.promise);
    q<HTMLFormElement>('payment-confirm-window')!.querySelector('form')!.requestSubmit();
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith(
      '/markets/m-a/payments/ana%40example.com/owed/2099-05-07',
    );

    w.unmount();
    wrapper = null;
    used.settle({ data: account(3000) });
    await flushPromises();

    expect(written).toHaveBeenCalledTimes(1);
  });

  it('a confirmation answered on the tab it was made on tells Payments once, through the tab', async () => {
    const w = await onAnaInAPage(account(3000, [ENTRY]), { canAdjustPaid: true });
    await w.get('[data-testid="payment-entry-menu-button"]').trigger('click');
    await w.get('[data-testid="payment-entry-menu-remove"]').trigger('click');
    await flushPromises();
    api.delete.mockResolvedValueOnce({ data: account(3000) });
    q<HTMLFormElement>('payment-confirm-window')!.querySelector('form')!.requestSubmit();
    await flushPromises();

    expect(w.emitted('changed')).toHaveLength(1);
    expect(written).not.toHaveBeenCalled();
  });

  it('refused after the move tells Payments nothing new', async () => {
    const w = await onAnaInAPage();
    const recorded = await recordOnAna(w);
    await w.setProps({ email: 'ben@example.com' });
    await flushPromises();

    recorded.refuse({ isAxiosError: true, response: { status: 500, data: {} } });
    await flushPromises();

    expect(w.emitted('changed')).toBeUndefined();
    expect(written).not.toHaveBeenCalled();
    expect(w.get('[data-testid="payment-owed"]').text()).toBe('$10.00');
  });
});
