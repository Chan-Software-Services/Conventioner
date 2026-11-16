// @vitest-environment happy-dom
/**
 * A dialog's write belongs to its opening (T277 ticket 08, report 4.8, T411).
 *
 * `useDialogSubmit` is `useSubmit`'s table keyed by what the dialog is open on, so an answer for an
 * earlier opening never touches the one the person is typing in; `AppDialog` takes the handle and
 * holds every close while it sends. Record payment is the first dialog on it: closed while its
 * write is out and opened again, the second opening is its own, and the first one's answer is
 * handed on to the account behind it.
 *
 * Each test holds the answer open with a promise it settles when it says, and reads what the
 * screen shows and what was sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import AppDialog from '@/components/AppDialog.vue';
import RecordPaymentDialog from '@/components/RecordPaymentDialog.vue';
import VendorPaymentTab from '@/components/VendorPaymentTab.vue';
import { useDialogSubmit } from '@/utils/useDialogSubmit';
import type { Payment, VendorAccount } from '@/utils/payments';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const config = { headers: {} } as InternalAxiosRequestConfig;

/** The server's refusal, as axios rejects it, with the body given. */
function refusal(status: number, data: Record<string, unknown>) {
  return new AxiosError(`${status}`, 'ERR_BAD_REQUEST', config, null, {
    status,
    statusText: '',
    data,
    headers: {},
    config,
  });
}

const q = <T extends HTMLElement = HTMLElement>(testid: string) =>
  document.querySelector<T>(`[data-testid="${testid}"]`);

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  api.get.mockReset();
  api.post.mockReset();
  api.put.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/** What the tiny dialog's handlers were told, in order. */
const told: string[] = [];
afterEach(() => {
  told.length = 0;
});

/**
 * A page with a dialog it opens on one of two things, `a` or `b`: the dialog names it, sends on its
 * confirm, closes itself on `done`, and is closed by the page on `close`.
 */
function tinyDialog(send: () => Promise<string>, refusedSays?: string) {
  return defineComponent({
    setup(_props, { expose }) {
      const on = ref<'a' | 'b' | null>(null);
      const submission = useDialogSubmit({
        opening: () => on.value,
        failure: 'It did not save.',
      });
      const press = () =>
        submission.submit(send, {
          done: (answer) => {
            told.push(`done ${on.value} ${answer}`);
            on.value = null;
          },
          refused: () => {
            told.push(`refused ${on.value}`);
            return refusedSays;
          },
          late: (answer) => told.push(answer.ok ? `late ok ${answer.answer}` : 'late refused'),
        });
      expose({ on });
      return () =>
        h('main', [
          h('button', { 'data-testid': 'open-a', onClick: () => (on.value = 'a') }),
          h('button', { 'data-testid': 'open-b', onClick: () => (on.value = 'b') }),
          h(
            AppDialog,
            {
              open: on.value !== null,
              title: `Rename ${on.value}`,
              testid: 'tiny',
              confirmLabel: 'Save',
              submission,
              onClose: () => (on.value = null),
              onSubmit: () => void press(),
            },
            { default: () => h('input', { 'data-testid': 'tiny-field', class: 'field' }) },
          ),
        ]);
    },
  });
}

function onWhat(): 'a' | 'b' | null {
  return (wrapper!.vm as unknown as { on: 'a' | 'b' | null }).on;
}

async function openOn(which: 'a' | 'b') {
  q(`open-${which}`)!.click();
  await flushPromises();
}

async function confirm() {
  q<HTMLFormElement>('tiny-window')!.querySelector('form')!.requestSubmit();
  await flushPromises();
}

describe('useDialogSubmit', () => {
  it('sends once for a second press while the first is out, and holds the dialog meanwhile', async () => {
    const answer = held<string>();
    const send = vi.fn(() => answer.promise);
    wrapper = mount(tinyDialog(send), { attachTo: document.body });
    await openOn('a');

    await confirm();
    await confirm();

    expect(send).toHaveBeenCalledTimes(1);
    expect(q<HTMLButtonElement>('tiny-submit-button')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>('tiny-cancel-button')!.disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(onWhat()).toBe('a');

    answer.resolve('saved');
    await flushPromises();
    expect(told).toEqual(['done a saved']);
    expect(q('tiny-window')).toBeNull();
  });

  it("hands an earlier opening's answer only to `late`, the new opening untouched", async () => {
    const answer = held<string>();
    wrapper = mount(
      tinyDialog(() => answer.promise),
      { attachTo: document.body },
    );
    await openOn('a');
    await confirm();

    // The page moves the dialog to another thing while the write is out: a new opening.
    (wrapper.vm as unknown as { on: string }).on = 'b';
    await flushPromises();
    expect(q<HTMLButtonElement>('tiny-submit-button')!.disabled).toBe(false);

    answer.resolve('saved');
    await flushPromises();
    expect(told).toEqual(['late ok saved']);
    expect(onWhat()).toBe('b');
  });

  it("keeps an earlier opening's refusal out of the new one, handing it to `late`", async () => {
    const answer = held<string>();
    wrapper = mount(
      tinyDialog(() => answer.promise),
      { attachTo: document.body },
    );
    await openOn('a');
    await confirm();
    (wrapper.vm as unknown as { on: string }).on = 'b';
    await flushPromises();

    answer.reject(refusal(400, { error: 'No.' }));
    await flushPromises();

    expect(told).toEqual(['late refused']);
    expect(q('tiny-error')).toBeNull();
  });

  it("says the server's sentence for a refusal, else the dialog's `failure`", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(refusal(409, { error: 'That name is taken.' }))
      .mockRejectedValueOnce(new Error('Network Error'));
    wrapper = mount(tinyDialog(send), { attachTo: document.body });
    await openOn('a');

    await confirm();
    expect(q('tiny-error')!.textContent?.trim()).toBe('That name is taken.');

    await confirm();
    expect(q('tiny-error')!.textContent?.trim()).toBe('It did not save.');
    expect(told).toEqual(['refused a', 'refused a']);
  });

  it("says the dialog's own sentence when its `refused` handler gives one", async () => {
    wrapper = mount(
      tinyDialog(() => Promise.reject(new Error('no')), 'Wait a minute.'),
      {
        attachTo: document.body,
      },
    );
    await openOn('a');
    await confirm();

    expect(q('tiny-error')!.textContent?.trim()).toBe('Wait a minute.');
  });

  it('calls nothing for an answer that lands after the dialog is gone', async () => {
    const answer = held<string>();
    wrapper = mount(
      tinyDialog(() => answer.promise),
      { attachTo: document.body },
    );
    await openOn('a');
    await confirm();

    wrapper.unmount();
    wrapper = null;
    answer.resolve('saved');
    await flushPromises();

    expect(told).toEqual([]);
  });

  it("says its refusal in the shell's error line by default, and nowhere under `says: 'self'`", async () => {
    const Self = defineComponent({
      setup() {
        const submission = useDialogSubmit({
          opening: () => true,
          failure: 'It did not save.',
          says: 'self',
        });
        return () =>
          h(
            AppDialog,
            {
              open: true,
              title: 'Rename',
              testid: 'self',
              confirmLabel: 'Save',
              submission,
              onSubmit: () => void submission.submit(() => Promise.reject(new Error('no'))),
            },
            {
              default: () => h('p', { 'data-testid': 'self-said' }, submission.sentence.value),
            },
          );
      },
    });
    wrapper = mount(Self, { attachTo: document.body });
    await flushPromises();

    q<HTMLFormElement>('self-window')!.querySelector('form')!.requestSubmit();
    await flushPromises();

    expect(q('self-error')).toBeNull();
    expect(q('self-said')!.textContent).toBe('It did not save.');
  });
});

const ACCOUNT: VendorAccount = {
  currency: 'CAD',
  lines: [],
  payments: [],
  owedCents: 0,
  paidCents: 0,
  balanceState: null,
  compares: true,
};

const ENTRY: Payment = {
  id: 'p1',
  kind: 'payment',
  cents: 3500,
  method: 'e-transfer',
  paidOn: '2099-04-01',
  note: '',
  recordedBy: 'editor@example.com',
  recordedAt: '2099-04-01T18:00:00+00:00',
  editedBy: null,
  editedAt: null,
  removedBy: null,
  removedAt: null,
};

const RECORDED: VendorAccount = { ...ACCOUNT, payments: [ENTRY], paidCents: 3500 };

async function type(testid: string, value: string) {
  const input = q<HTMLInputElement>(testid)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

async function press() {
  q('record-payment-window')!.querySelector('form')!.requestSubmit();
  await flushPromises();
}

describe('Record payment: a second opening is its own (probe 8)', () => {
  async function dialog() {
    wrapper = mount(RecordPaymentDialog, {
      props: { open: true, marketId: 'm1', email: 'ana@example.com', currency: 'CAD' },
      attachTo: document.body,
    });
    await flushPromises();
    return wrapper;
  }

  async function closeAndReopen(w: VueWrapper) {
    await w.setProps({ open: false });
    await flushPromises();
    await w.setProps({ open: true });
    await flushPromises();
  }

  it("opens again on Record payment, enabled, while the first opening's write is out", async () => {
    const w = await dialog();
    const first = held<{ data: VendorAccount }>();
    api.post.mockReturnValueOnce(first.promise);
    await type('record-payment-amount', '35');
    await press();

    await closeAndReopen(w);
    await type('record-payment-amount', '20');

    const submit = q<HTMLButtonElement>('record-payment-submit-button')!;
    expect(submit.textContent?.trim()).toBe('Record payment');
    expect(submit.disabled).toBe(false);
    first.resolve({ data: ACCOUNT });
    await flushPromises();
  });

  it("does not show the first opening's refusal in the second", async () => {
    const w = await dialog();
    const first = held<{ data: VendorAccount }>();
    api.post.mockReturnValueOnce(first.promise);
    await type('record-payment-amount', '35');
    await press();

    await closeAndReopen(w);
    first.reject(refusal(400, { error: 'No.' }));
    await flushPromises();

    expect(q('record-payment-error')).toBeNull();
    expect(w.emitted('refreshed')).toBeUndefined();
  });

  it("hands the first opening's success on as the account, never as `saved`, keeping what was typed", async () => {
    const w = await dialog();
    const first = held<{ data: VendorAccount }>();
    api.post.mockReturnValueOnce(first.promise);
    await type('record-payment-amount', '35');
    await press();

    await closeAndReopen(w);
    await type('record-payment-amount', '20');
    first.resolve({ data: RECORDED });
    await flushPromises();

    expect(w.emitted('saved')).toBeUndefined();
    expect(w.emitted('refreshed')).toEqual([[RECORDED]]);
    expect(q<HTMLInputElement>('record-payment-amount')!.value).toBe('20');
  });

  it('hands on the account a late refusal carries, saying nothing of it in the new opening', async () => {
    const w = await dialog();
    const first = held<{ data: VendorAccount }>();
    api.post.mockReturnValueOnce(first.promise);
    await type('record-payment-amount', '35');
    await press();

    await closeAndReopen(w);
    first.reject(refusal(409, { error: 'Already recorded.', account: RECORDED }));
    await flushPromises();

    expect(w.emitted('refreshed')).toEqual([[RECORDED]]);
    expect(q('record-payment-error')).toBeNull();
  });

  it('sends a new request key in the second opening', async () => {
    const w = await dialog();
    const first = held<{ data: VendorAccount }>();
    api.post.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ data: RECORDED });
    await type('record-payment-amount', '35');
    await press();
    await closeAndReopen(w);
    await type('record-payment-amount', '20');
    await press();

    const keys = api.post.mock.calls.map(([, body]) => (body as { requestKey: string }).requestKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(w.emitted('saved')).toEqual([[RECORDED]]);
    first.resolve({ data: RECORDED });
    await flushPromises();
  });
});

describe('Record payment holds while it records (probe 9)', () => {
  async function recordingOnTheTab() {
    api.get.mockResolvedValue({ data: ACCOUNT });
    wrapper = mount(VendorPaymentTab, {
      props: { marketId: 'm1', email: 'ana@example.com', canRecord: true },
      attachTo: document.body,
    });
    await flushPromises();
    await wrapper.get('[data-testid="payment-record"]').trigger('click');
    await flushPromises();
    const first = held<{ data: VendorAccount }>();
    api.post.mockReturnValueOnce(first.promise);
    await type('record-payment-amount', '35');
    await press();
    return first;
  }

  it('refuses Cancel, the close, Escape and the scrim while the write is out, and closes on its answer', async () => {
    const first = await recordingOnTheTab();

    const cancel = q<HTMLButtonElement>('record-payment-cancel-button')!;
    const close = q<HTMLButtonElement>('record-payment-close-button')!;
    expect(cancel.disabled).toBe(true);
    expect(close.disabled).toBe(true);
    expect(q('record-payment-submit-button')!.textContent?.trim()).toBe('Recording…');
    cancel.click();
    close.click();
    q('record-payment-background')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(q('record-payment-window')).not.toBeNull();

    first.resolve({ data: RECORDED });
    await flushPromises();
    expect(q('record-payment-window')).toBeNull();
    expect(wrapper!.findAll('[data-testid="payment-entry"]')).toHaveLength(1);
  });

  it('a second press while it records sends nothing', async () => {
    const first = await recordingOnTheTab();
    await press();

    expect(api.post).toHaveBeenCalledTimes(1);
    first.resolve({ data: RECORDED });
    await flushPromises();
  });

  it('keeps its refusal until a field changes, and the closes work again', async () => {
    const first = await recordingOnTheTab();
    first.reject(refusal(400, { error: 'That payment could not be recorded.' }));
    await flushPromises();

    expect(q('record-payment-error')!.textContent?.trim()).toBe(
      'That payment could not be recorded.',
    );
    expect(q<HTMLButtonElement>('record-payment-cancel-button')!.disabled).toBe(false);

    await type('record-payment-note', 'At the door');
    expect(q('record-payment-error')).toBeNull();
  });
});
