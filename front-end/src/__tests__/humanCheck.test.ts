// @vitest-environment happy-dom
/**
 * The human check (T539): Cloudflare Turnstile, loaded once a page and rendered only by
 * `HumanCheck.vue`, which hands a form its token and says, in one sentence, when it could not
 * load. A fake `window.turnstile` stands in for Cloudflare's script: it records each render's
 * options and lets a case call the widget's callbacks as Cloudflare would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';

type Options = Record<string, unknown> & {
  callback?: (token: string) => void;
  'error-callback'?: (code: string) => void;
  'expired-callback'?: () => void;
  'unsupported-callback'?: () => void;
  'before-interactive-callback'?: () => void;
  'after-interactive-callback'?: () => void;
};

/** Cloudflare's script as a case drives it: each render's container and options, and its calls. */
function fakeTurnstile() {
  const renders: { container: HTMLElement; options: Options }[] = [];
  const fake = {
    renders,
    render: vi.fn((container: HTMLElement, options: Options) => {
      renders.push({ container, options });
      return `widget-${renders.length}`;
    }),
    reset: vi.fn(),
    remove: vi.fn(),
    getResponse: vi.fn(),
    /** The last widget's options, whose callbacks a case calls as Cloudflare would. */
    get last(): Options {
      return renders[renders.length - 1]!.options;
    },
  };
  return fake;
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const DIDNT_LOAD =
  "The check that you're a person didn't load. Check your connection, then reload the page.";
const NOT_CONFIRMED = "We couldn't confirm you're a person. Try again.";

/** A fresh copy of the module, so the once-a-page load starts again in each case. */
async function freshModules() {
  vi.resetModules();
  const captcha = await import('@/utils/captcha');
  const { default: HumanCheck } = await import('@/components/HumanCheck.vue');
  return { captcha, HumanCheck };
}

let wrapper: VueWrapper | null = null;
let turnstile: ReturnType<typeof fakeTurnstile>;
let width = 320;
let height = 0;
/** Each `ResizeObserver` the check made, as a call that tells it its box changed. */
let resized: (() => void)[] = [];

beforeEach(() => {
  turnstile = fakeTurnstile();
  (window as unknown as { turnstile?: unknown }).turnstile = turnstile;
  width = 320;
  height = 0;
  resized = [];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 }) as DOMRect,
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly changed: () => void) {
        resized.push(() => this.changed());
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  delete (window as unknown as { turnstile?: unknown }).turnstile;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** What a form holds of the check: its `token()` and `reset()`, through a template ref. */
interface Handle {
  token: () => Promise<string>;
  reset: () => void;
}

async function mountCheck(props: { action: string; siteKey?: string } = { action: 'sign-up' }) {
  const { captcha, HumanCheck } = await freshModules();
  const check = ref<Handle | null>(null);
  wrapper = mount(
    defineComponent({
      setup: () => () =>
        h('form', [h(HumanCheck, { ...props, ref: check }), h('button', { type: 'submit' })]),
    }),
    { attachTo: document.body },
  );
  await flushPromises();
  return { captcha, check: () => check.value!, wrapper };
}

/** Whether a promise has settled yet, and how. */
function watched<T>(promise: Promise<T>) {
  const state: { settled: 'no' | 'resolved' | 'rejected'; value?: T; error?: unknown } = {
    settled: 'no',
  };
  promise.then(
    (value) => Object.assign(state, { settled: 'resolved', value }),
    (error) => Object.assign(state, { settled: 'rejected', error }),
  );
  return state;
}

describe('loadHumanCheck', () => {
  /** The scripts the loader adds, held out of the document so none is fetched. */
  function heldScripts() {
    const scripts: HTMLScriptElement[] = [];
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => {
      scripts.push(node as unknown as HTMLScriptElement);
      return node;
    });
    return scripts;
  }

  beforeEach(() => {
    delete (window as unknown as { turnstile?: unknown }).turnstile;
  });

  it("adds Cloudflare's script once a page, rendered explicitly, and resolves with turnstile", async () => {
    const scripts = heldScripts();
    const { captcha } = await freshModules();

    const first = captcha.loadHumanCheck();
    const second = captcha.loadHumanCheck();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toBe(SCRIPT_URL);
    expect(scripts[0]!.async).toBe(true);

    (window as unknown as { turnstile: unknown }).turnstile = turnstile;
    scripts[0]!.dispatchEvent(new Event('load'));

    await expect(first).resolves.toBe(turnstile);
    await expect(second).resolves.toBe(turnstile);
    await expect(captcha.loadHumanCheck()).resolves.toBe(turnstile);
    expect(scripts).toHaveLength(1);
  });

  it('adds no script when the page already has turnstile', async () => {
    const scripts = heldScripts();
    (window as unknown as { turnstile: unknown }).turnstile = turnstile;
    const { captcha } = await freshModules();

    await expect(captcha.loadHumanCheck()).resolves.toBe(turnstile);
    expect(scripts).toHaveLength(0);
  });

  it("rejects with HumanCheckUnavailable on the script's error, and tries again on the next call", async () => {
    const scripts = heldScripts();
    const { captcha } = await freshModules();

    const loading = captcha.loadHumanCheck();
    scripts[0]!.dispatchEvent(new Event('error'));

    await expect(loading).rejects.toBeInstanceOf(captcha.HumanCheckUnavailable);
    await expect(loading).rejects.toThrow(DIDNT_LOAD);

    void captcha.loadHumanCheck().catch(() => {});
    expect(scripts).toHaveLength(2);
  });

  it('rejects when the script loads and gives no turnstile', async () => {
    const scripts = heldScripts();
    const { captcha } = await freshModules();

    const loading = captcha.loadHumanCheck();
    scripts[0]!.dispatchEvent(new Event('load'));

    await expect(loading).rejects.toBeInstanceOf(captcha.HumanCheckUnavailable);
  });

  it('rejects after 15 seconds with no turnstile, and not before', async () => {
    vi.useFakeTimers();
    heldScripts();
    const { captcha } = await freshModules();

    const loading = watched(captcha.loadHumanCheck());
    await vi.advanceTimersByTimeAsync(14_999);
    expect(loading.settled).toBe('no');
    await vi.advanceTimersByTimeAsync(1);
    expect(loading.settled).toBe('rejected');
    expect(loading.error).toBeInstanceOf(captcha.HumanCheckUnavailable);
  });
});

describe('HumanCheck', () => {
  it("renders once with the spec's options, compact under 300 pixels wide", async () => {
    width = 299;
    await mountCheck({ action: 'sign-up', siteKey: 'a-site-key' });

    expect(turnstile.render).toHaveBeenCalledTimes(1);
    const { container, options } = turnstile.renders[0]!;
    expect(container.dataset.testid).toBe('human-check');
    expect(options).toMatchObject({
      sitekey: 'a-site-key',
      action: 'sign-up',
      appearance: 'interaction-only',
      size: 'compact',
      'refresh-expired': 'auto',
      retry: 'auto',
      execution: 'render',
      theme: 'light',
      language: 'auto',
    });
  });

  it('is flexible from 300 pixels wide', async () => {
    width = 300;
    await mountCheck({ action: 'vendor-sign-in', siteKey: 'a-site-key' });

    expect(turnstile.last).toMatchObject({ size: 'flexible', action: 'vendor-sign-in' });
  });

  it("resolves token() with the widget's token, and with the next one once the last is spent", async () => {
    const { check } = await mountCheck({ action: 'sign-up', siteKey: 'a-site-key' });

    const waiting = watched(check().token());
    await flushPromises();
    expect(waiting.settled).toBe('no');

    turnstile.last.callback!('token-1');
    await flushPromises();
    expect(waiting).toMatchObject({ settled: 'resolved', value: 'token-1' });
    await expect(check().token()).resolves.toBe('token-1');

    check().reset();
    expect(turnstile.reset).toHaveBeenCalledWith('widget-1');
    const next = watched(check().token());
    await flushPromises();
    expect(next.settled).toBe('no');

    turnstile.last.callback!('token-2');
    await flushPromises();
    expect(next).toMatchObject({ settled: 'resolved', value: 'token-2' });
  });

  it('holds no token once Cloudflare says it expired', async () => {
    const { check } = await mountCheck({ action: 'sign-up', siteKey: 'a-site-key' });
    turnstile.last.callback!('token-1');
    turnstile.last['expired-callback']!();

    const waiting = watched(check().token());
    await flushPromises();
    expect(waiting.settled).toBe('no');
    turnstile.last.callback!('token-2');
    await flushPromises();
    expect(waiting.value).toBe('token-2');
  });

  it.each([
    ['error-callback', () => turnstile.last['error-callback']!('300030')],
    ['unsupported-callback', () => turnstile.last['unsupported-callback']!()],
  ])('rejects a waiting token() with HumanCheckUnavailable on %s', async (_name, fire) => {
    const { captcha, check } = await mountCheck({ action: 'sign-up', siteKey: 'a-site-key' });
    const waiting = watched(check().token());

    fire();
    await flushPromises();

    expect(waiting.settled).toBe('rejected');
    expect(waiting.error).toBeInstanceOf(captcha.HumanCheckUnavailable);
    expect((waiting.error as Error).message).toBe(DIDNT_LOAD);
    await expect(check().token()).rejects.toBeInstanceOf(captcha.HumanCheckUnavailable);
  });

  it('gives a token again once Cloudflare recovers from an error', async () => {
    const { check } = await mountCheck({ action: 'sign-up', siteKey: 'a-site-key' });
    turnstile.last['error-callback']!('300030');
    turnstile.last.callback!('token-after-retry');

    await expect(check().token()).resolves.toBe('token-after-retry');
  });

  it("rejects token() when Cloudflare's script does not load", async () => {
    delete (window as unknown as { turnstile?: unknown }).turnstile;
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => {
      queueMicrotask(() => node.dispatchEvent(new Event('error')));
      return node;
    });
    const { captcha, check } = await mountCheck({ action: 'sign-up', siteKey: 'a-site-key' });

    await expect(check().token()).rejects.toBeInstanceOf(captcha.HumanCheckUnavailable);
    expect(turnstile.render).not.toHaveBeenCalled();
  });

  it('rejects after 30 seconds with neither a token nor a tick box, and not before', async () => {
    vi.useFakeTimers();
    const { captcha, check } = await mountCheck({ action: 'sign-up', siteKey: 'a-site-key' });

    const waiting = watched(check().token());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(waiting.settled).toBe('no');
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.settled).toBe('rejected');
    expect(waiting.error).toBeInstanceOf(captcha.HumanCheckUnavailable);
  });

  it('waits without limit while Cloudflare shows its tick box', async () => {
    vi.useFakeTimers();
    const { check } = await mountCheck({ action: 'sign-up', siteKey: 'a-site-key' });

    const waiting = watched(check().token());
    turnstile.last['before-interactive-callback']!();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(waiting.settled).toBe('no');

    turnstile.last['after-interactive-callback']!();
    turnstile.last.callback!('ticked-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting).toMatchObject({ settled: 'resolved', value: 'ticked-token' });
  });

  it('keeps room above the button only while Cloudflare has drawn into its box', async () => {
    const { wrapper } = await mountCheck({ action: 'sign-up', siteKey: 'a-site-key' });
    const box = wrapper.get('[data-testid="human-check"]');
    expect(resized).toHaveLength(1);
    expect(box.classes()).not.toContain('human-check--drawn');

    height = 65;
    resized[0]!();
    await flushPromises();
    expect(box.classes()).toContain('human-check--drawn');

    height = 0;
    resized[0]!();
    await flushPromises();
    expect(box.classes()).not.toContain('human-check--drawn');
  });

  it('removes its widget on unmount', async () => {
    await mountCheck({ action: 'sign-up', siteKey: 'a-site-key' });

    wrapper!.unmount();
    wrapper = null;

    expect(turnstile.remove).toHaveBeenCalledWith('widget-1');
  });

  it('with no site key renders nothing, loads nothing and gives the placeholder at once', async () => {
    delete (window as unknown as { turnstile?: unknown }).turnstile;
    const appended = vi.spyOn(document.head, 'appendChild');
    const { check, wrapper } = await mountCheck({ action: 'sign-up', siteKey: '' });

    expect(wrapper.find('[data-testid="human-check"]').exists()).toBe(false);
    await expect(check().token()).resolves.toBe('e2e-test-captcha-token');
    check().reset();
    expect(appended).not.toHaveBeenCalled();
  });
});

describe('withHumanCheck', () => {
  const required = {
    isAxiosError: true,
    response: { status: 403, data: { msg: "Confirm you're a person, then try again." } },
  };
  required.response.data = { ...required.response.data, captcha: 'required' } as never;

  /** A check that hands out numbered tokens and counts its resets. */
  function numberedCheck() {
    let next = 1;
    let held: string | null = null;
    const check = {
      resets: 0,
      token: async () => (held ??= `token-${next++}`),
      reset: () => {
        check.resets += 1;
        held = null;
      },
    };
    return check;
  }

  it('sends the token, resets after the answer and gives the answer back', async () => {
    const { captcha } = await freshModules();
    const check = numberedCheck();
    const send = vi.fn(async (token: string) => `sent with ${token}`);

    await expect(captcha.withHumanCheck(check, send)).resolves.toBe('sent with token-1');
    expect(send.mock.calls).toEqual([['token-1']]);
    expect(check.resets).toBe(1);
  });

  it("sends once more with a new token after a 'captcha: required' answer", async () => {
    const { captcha } = await freshModules();
    const check = numberedCheck();
    const send = vi.fn().mockRejectedValueOnce(required).mockResolvedValueOnce('signed up');

    await expect(captcha.withHumanCheck(check, send)).resolves.toBe('signed up');
    expect(send.mock.calls).toEqual([['token-1'], ['token-2']]);
    expect(check.resets).toBe(2);
  });

  it('refuses with its own sentence when the retry is answered the same', async () => {
    const { captcha } = await freshModules();
    const { refusalSentence } = await import('@/utils/useSubmit');
    const check = numberedCheck();
    const send = vi.fn().mockRejectedValue(required);

    const error = await captcha.withHumanCheck(check, send).catch((e: unknown) => e);
    expect(refusalSentence(error)).toBe(NOT_CONFIRMED);
    expect(send).toHaveBeenCalledTimes(2);
    expect(check.resets).toBe(2);
  });

  it('hands any other refusal on as it came, with no retry', async () => {
    const { captcha } = await freshModules();
    const check = numberedCheck();
    const tooMany = { isAxiosError: true, response: { status: 429, data: { msg: 'Wait.' } } };
    const send = vi.fn().mockRejectedValue(tooMany);

    await expect(captcha.withHumanCheck(check, send)).rejects.toBe(tooMany);
    expect(send).toHaveBeenCalledTimes(1);
    expect(check.resets).toBe(1);
  });

  it("says the check didn't load, sending nothing, when its token cannot be had", async () => {
    const { captcha } = await freshModules();
    const { refusalSentence } = await import('@/utils/useSubmit');
    const send = vi.fn();
    const check = {
      token: () => Promise.reject(new captcha.HumanCheckUnavailable()),
      reset: vi.fn(),
    };

    const error = await captcha.withHumanCheck(check, send).catch((e: unknown) => e);
    expect(refusalSentence(error)).toBe(DIDNT_LOAD);
    expect(send).not.toHaveBeenCalled();
  });
});
