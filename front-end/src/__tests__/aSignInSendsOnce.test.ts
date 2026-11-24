// @vitest-environment happy-dom
/**
 * A sign-in sends once, and its answer belongs to its form (T277 ticket 08, report 4.8).
 *
 * Send code pressed twice sent two requests, and the server's one-code wait answered the second
 * with a refusal that replaced "code sent" while a good code sat in the inbox; an answer that
 * landed after the person moved to another way in showed on the screen they moved to. On a
 * market's vendor page the sign-in moved to the code step by reading the store's shared error,
 * which another reader may have written meanwhile, and "Use a different email" went while a code
 * was being checked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';

const post = vi.fn();
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, post: (...a: unknown[]) => post(...a) } };
});

import LoginView from '@/views/LoginView.vue';
import VendorSignIn from '@/components/vendorPage/VendorSignIn.vue';
import { useApplicationStore, type CodeAnswer } from '@/stores/application';

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tooSoon = {
  isAxiosError: true,
  response: { status: 429, data: { msg: 'Please wait before asking for another code.' } },
};
const codeSent = { status: 200, data: { msg: 'A sign-in code has been sent to your email.' } };
const signedIn = { status: 200, data: { user_data: { email: 'organizer@example.com' } } };

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  post.mockReset();
  localStorage.clear();
});

async function atLogin() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', component: LoginView },
      { path: '/markets', component: { template: '<div />' } },
    ],
  });
  await router.push('/login');
  wrapper = mount(LoginView, { global: { plugins: [router] }, attachTo: document.body });
  return { w: wrapper, router };
}

async function atTheCodeForm() {
  const at = await atLogin();
  await at.w.get('[data-testid="login-tab-otp"]').trigger('click');
  await at.w.get('[data-testid="login-otp-email-input"]').setValue('organizer@example.com');
  return at;
}

/** A sign-in form's line is always in the page, hidden while it has nothing to say. */
function shown(w: VueWrapper, testid: string): boolean {
  const found = w.find(`[data-testid="${testid}"]`);
  return found.exists() && (found.element as HTMLElement).style.display !== 'none';
}

function button(w: VueWrapper, testid: string) {
  const found = w.get(`[data-testid="${testid}"]`);
  return { text: found.text(), disabled: (found.element as HTMLButtonElement).disabled };
}

describe('Send code on the organizer sign-in', () => {
  it('sends one request for two presses, and keeps "code sent" on the code step', async () => {
    const { w } = await atTheCodeForm();
    const first = held<unknown>();
    post.mockReturnValueOnce(first.promise).mockRejectedValueOnce(tooSoon);

    await w.get('[data-testid="login-otp-form"]').trigger('submit');
    await w.get('[data-testid="login-otp-form"]').trigger('submit');
    first.resolve(codeSent);
    await flushPromises();

    expect(post).toHaveBeenCalledTimes(1);
    expect(w.get('[data-testid="login-otp-success-message"]').text()).toBe(
      'A sign-in code has been sent to your email.',
    );
    expect(shown(w, 'login-otp-error-message')).toBe(false);
  });

  it('says "Sending…" and is disabled while its request is out', async () => {
    const { w } = await atTheCodeForm();
    const first = held<unknown>();
    post.mockReturnValueOnce(first.promise);

    await w.get('[data-testid="login-otp-form"]').trigger('submit');

    expect(button(w, 'login-otp-submit-button')).toEqual({ text: 'Sending…', disabled: true });

    first.resolve(codeSent);
    await flushPromises();

    expect(button(w, 'login-otp-submit-button')).toEqual({ text: 'Sign in', disabled: false });
  });

  it('drops the answer once the person moved to another way in, even after coming back', async () => {
    const { w } = await atTheCodeForm();
    const first = held<unknown>();
    post.mockReturnValueOnce(first.promise);

    await w.get('[data-testid="login-otp-form"]').trigger('submit');
    await w.get('[data-testid="login-tab-login"]').trigger('click');
    await w.get('[data-testid="login-tab-otp"]').trigger('click');
    first.resolve(codeSent);
    await flushPromises();

    expect(w.find('[data-testid="login-otp-code-input"]').exists()).toBe(false);
    expect(shown(w, 'login-otp-success-message')).toBe(false);
  });

  it('drops a refusal once the person chose "Use a different email"', async () => {
    const { w } = await atTheCodeForm();
    post.mockResolvedValueOnce(codeSent);
    await w.get('[data-testid="login-otp-form"]').trigger('submit');
    await flushPromises();
    await w.get('[data-testid="login-otp-code-input"]').setValue('123456');
    const check = held<unknown>();
    post.mockReturnValueOnce(check.promise);

    await w.get('[data-testid="login-otp-form"]').trigger('submit');
    expect(button(w, 'login-otp-submit-button')).toEqual({ text: 'Signing in…', disabled: true });
    await w.get('[data-testid="login-otp-different-email-button"]').trigger('click');
    check.reject({
      isAxiosError: true,
      response: { status: 401, data: { msg: 'Invalid or expired code' } },
    });
    await flushPromises();

    expect(w.find('[data-testid="login-otp-code-input"]').exists()).toBe(false);
    expect(shown(w, 'login-otp-error-message')).toBe(false);
    expect(button(w, 'login-otp-submit-button')).toEqual({ text: 'Send code', disabled: false });
  });
});

describe('the other sign-in forms', () => {
  it('signs in by password once for two presses, saying "Signing in…" meanwhile', async () => {
    const { w, router } = await atLogin();
    await w.get('[data-testid="login-email-input"]').setValue('organizer@example.com');
    await w.get('[data-testid="login-password-input"]').setValue('a-password');
    const answer = held<unknown>();
    post.mockReturnValueOnce(answer.promise);

    await w.get('[data-testid="login-form"]').trigger('submit');
    await w.get('[data-testid="login-form"]').trigger('submit');

    expect(button(w, 'login-submit-button')).toEqual({ text: 'Signing in…', disabled: true });

    answer.resolve(signedIn);
    await flushPromises();

    expect(post).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.path).toBe('/markets');
  });

  it('drops a sign-in that lands after the person moved to another way in', async () => {
    const { w, router } = await atLogin();
    await w.get('[data-testid="login-email-input"]').setValue('organizer@example.com');
    await w.get('[data-testid="login-password-input"]').setValue('a-password');
    const answer = held<unknown>();
    post.mockReturnValueOnce(answer.promise);

    await w.get('[data-testid="login-form"]').trigger('submit');
    await w.get('[data-testid="login-tab-otp"]').trigger('click');
    answer.resolve(signedIn);
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/login');
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('says "Creating account…" while a registration is out', async () => {
    const { w } = await atLogin();
    await w.get('[data-testid="login-tab-register"]').trigger('click');
    await w.get('[data-testid="login-register-email-input"]').setValue('new@example.com');
    await w.get('[data-testid="login-register-password-input"]').setValue('a-long-password');
    await w
      .get('[data-testid="login-register-password-confirm-input"]')
      .setValue('a-long-password');
    const answer = held<unknown>();
    post.mockReturnValueOnce(answer.promise);

    await w.get('[data-testid="login-register-form"]').trigger('submit');
    await flushPromises();
    await w.get('[data-testid="login-register-form"]').trigger('submit');

    expect(button(w, 'login-register-submit-button')).toEqual({
      text: 'Creating account…',
      disabled: true,
    });

    answer.resolve({ status: 201, data: { msg: 'Check your email.' } });
    await flushPromises();

    expect(post).toHaveBeenCalledTimes(1);
    expect(w.get('[data-testid="login-register-success-message"]').text()).toBe(
      'Check your email.',
    );
  });
});

describe('the vendor sign-in reads its own answer', () => {
  function signInWith() {
    wrapper = mount(VendorSignIn, { props: { marketSlug: 'spring' }, attachTo: document.body });
    return wrapper;
  }

  it("moves to the code step on its own answer, whatever the store's error says meanwhile", async () => {
    setActivePinia(createPinia());
    const store = useApplicationStore();
    const sent = held<void>();
    vi.spyOn(store, 'requestCode').mockImplementation(async (): Promise<CodeAnswer> => {
      await sent.promise;
      // Another reader of the shared error writes it while this request is out.
      store.error = 'Your answers could not be saved.';
      return { ok: true };
    });
    const w = signInWith();
    await w.get('[data-testid="vendor-sign-in-email-input"]').setValue('ana@example.com');
    await w.get('[data-testid="vendor-sign-in-email-step"]').trigger('submit');
    sent.resolve();
    await flushPromises();

    expect(w.find('[data-testid="vendor-sign-in-code-step"]').exists()).toBe(true);
    expect(w.find('[data-testid="vendor-sign-in-error"]').exists()).toBe(false);
  });

  it('says its own refusal, and stays on the email step', async () => {
    setActivePinia(createPinia());
    const store = useApplicationStore();
    vi.spyOn(store, 'requestCode').mockResolvedValue({
      ok: false,
      sentence: 'Too many codes asked for. Please try again later.',
      codeState: null,
    });
    const w = signInWith();
    await w.get('[data-testid="vendor-sign-in-email-input"]').setValue('ana@example.com');
    await w.get('[data-testid="vendor-sign-in-email-step"]').trigger('submit');
    await flushPromises();

    expect(w.find('[data-testid="vendor-sign-in-email-step"]').exists()).toBe(true);
    expect(w.get('[data-testid="vendor-sign-in-error"]').text()).toBe(
      'Too many codes asked for. Please try again later.',
    );
    expect(store.error).toBeNull();
  });

  it('refuses "Use a different email" while a code is being checked', async () => {
    setActivePinia(createPinia());
    const store = useApplicationStore();
    const checked = held<CodeAnswer>();
    vi.spyOn(store, 'verifyCode').mockReturnValue(checked.promise);
    vi.spyOn(store, 'requestCode').mockResolvedValue({ ok: true });
    const w = signInWith();
    await w.get('[data-testid="vendor-sign-in-email-input"]').setValue('ana@example.com');
    await w.get('[data-testid="vendor-sign-in-email-step"]').trigger('submit');
    await flushPromises();
    await w.get('[data-testid="vendor-sign-in-code-input"]').setValue('123456');
    await w.get('[data-testid="vendor-sign-in-code-step"]').trigger('submit');

    const back = w.get('[data-testid="vendor-sign-in-back-btn"]');
    expect((back.element as HTMLButtonElement).disabled).toBe(true);
    await back.trigger('click');
    checked.resolve({ ok: false, sentence: 'That code is not right.', codeState: 'retry' });
    await flushPromises();

    expect(w.find('[data-testid="vendor-sign-in-code-step"]').exists()).toBe(true);
    expect(w.get('[data-testid="vendor-sign-in-error"]').text()).toBe('That code is not right.');
    expect((back.element as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('sign-up asks the human check (T539)', () => {
  const PLACEHOLDER = 'e2e-test-captcha-token';
  const required = {
    isAxiosError: true,
    response: {
      status: 403,
      data: { msg: "Confirm you're a person, then try again.", captcha: 'required' },
    },
  };
  const created = { status: 201, data: { msg: 'Check your email.' } };

  async function fillSignUp(w: VueWrapper) {
    await w.get('[data-testid="login-tab-register"]').trigger('click');
    await w.get('[data-testid="login-register-email-input"]').setValue('new@example.com');
    await w.get('[data-testid="login-register-password-input"]').setValue('a-long-password');
    await w
      .get('[data-testid="login-register-password-confirm-input"]')
      .setValue('a-long-password');
  }

  const sentTokens = () =>
    post.mock.calls.map((call) => (call[1] as { captcha_token?: string }).captcha_token);

  it("sends the widget's token as captcha_token, and resets the check after the answer", async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'a-site-key');
    vi.resetModules();
    let callback: (token: string) => void = () => {};
    const turnstile = {
      render: vi.fn((_box: HTMLElement, options: { callback: (token: string) => void }) => {
        callback = options.callback;
        return 'widget-1';
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    window.turnstile = turnstile;
    try {
      const { default: FreshLoginView } = await import('@/views/LoginView.vue');
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/login', component: FreshLoginView }],
      });
      await router.push('/login');
      wrapper = mount(FreshLoginView, { global: { plugins: [router] }, attachTo: document.body });
      await fillSignUp(wrapper);
      await flushPromises();

      expect(turnstile.render).toHaveBeenCalledTimes(1);
      expect(turnstile.render.mock.calls[0]![1]).toMatchObject({ action: 'sign-up' });
      // The check sits directly above the form's button.
      const check = wrapper.get('[data-testid="human-check"]').element;
      expect(check.nextElementSibling?.getAttribute('data-testid')).toBe(
        'login-register-submit-button',
      );

      callback('a-widget-token');
      post.mockResolvedValueOnce(created);
      await wrapper.get('[data-testid="login-register-form"]').trigger('submit');
      await flushPromises();

      expect(sentTokens()).toEqual(['a-widget-token']);
      expect(turnstile.reset).toHaveBeenCalledWith('widget-1');
    } finally {
      delete window.turnstile;
      vi.unstubAllEnvs();
    }
  });

  it('with no site key sends the placeholder token, and loads no script', async () => {
    const { w } = await atLogin();
    await fillSignUp(w);
    expect(w.find('[data-testid="human-check"]').exists()).toBe(false);
    post.mockResolvedValueOnce(created);

    await w.get('[data-testid="login-register-form"]').trigger('submit');
    await flushPromises();

    expect(sentTokens()).toEqual([PLACEHOLDER]);
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
  });

  it("sends once more after a 'captcha: required' answer, and signs up", async () => {
    const { w } = await atLogin();
    await fillSignUp(w);
    post.mockRejectedValueOnce(required).mockResolvedValueOnce(created);

    await w.get('[data-testid="login-register-form"]').trigger('submit');
    await flushPromises();

    expect(sentTokens()).toEqual([PLACEHOLDER, PLACEHOLDER]);
    expect(w.get('[data-testid="login-register-success-message"]').text()).toBe(
      'Check your email.',
    );
    expect(shown(w, 'login-register-error-message')).toBe(false);
  });

  it("says it couldn't confirm a person when the retry is answered the same", async () => {
    const { w } = await atLogin();
    await fillSignUp(w);
    post.mockRejectedValue(required);

    await w.get('[data-testid="login-register-form"]').trigger('submit');
    await flushPromises();

    expect(post).toHaveBeenCalledTimes(2);
    expect(w.get('[data-testid="login-register-error-message"]').text()).toBe(
      "We couldn't confirm you're a person. Try again.",
    );
  });

  it("says the check didn't load, and sends nothing, when the check cannot give a token", async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'a-site-key');
    vi.resetModules();
    window.turnstile = {
      render: (_box: HTMLElement, options: { 'unsupported-callback': () => void }) => {
        queueMicrotask(options['unsupported-callback']);
        return 'widget-1';
      },
      reset: vi.fn(),
      remove: vi.fn(),
    } as never;
    try {
      const { default: FreshLoginView } = await import('@/views/LoginView.vue');
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/login', component: FreshLoginView }],
      });
      await router.push('/login');
      wrapper = mount(FreshLoginView, { global: { plugins: [router] }, attachTo: document.body });
      await fillSignUp(wrapper);
      await flushPromises();

      await wrapper.get('[data-testid="login-register-form"]').trigger('submit');
      await flushPromises();

      expect(post).not.toHaveBeenCalled();
      expect(wrapper.get('[data-testid="login-register-error-message"]').text()).toBe(
        "The check that you're a person didn't load. Check your connection, then reload the page.",
      );
    } finally {
      delete window.turnstile;
      vi.unstubAllEnvs();
    }
  });
});
