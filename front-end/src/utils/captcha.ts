/**
 * The human check (T539): Cloudflare Turnstile, the app's one check that a person, not a script,
 * is asking ([ADR 0045](../../../docs/adr/0045-turnstile-is-the-one-human-check.md)).
 *
 * This module loads Cloudflare's script, once a page, and holds the words a person sees of the
 * check, each in one place. `HumanCheck.vue` is the only code that renders the widget; a form
 * holds one and sends its token through `withHumanCheck`, or, when it shows the check only once
 * the server asks for it, through `withHumanCheckWhenAsked`.
 */
import { Refusal } from '@/utils/useSubmit';

/** The options `turnstile.render` takes, as far as this app sets them. */
export interface HumanCheckRenderOptions {
  sitekey: string;
  action: string;
  appearance: 'interaction-only';
  size: 'flexible' | 'compact';
  'refresh-expired': 'auto';
  retry: 'auto';
  execution: 'render';
  theme: 'light';
  language: 'auto';
  callback: (token: string) => void;
  'error-callback': (code: string) => void;
  'expired-callback': () => void;
  'unsupported-callback': () => void;
  'before-interactive-callback': () => void;
  'after-interactive-callback': () => void;
}

/** Cloudflare's `window.turnstile`, the part of it this app calls. */
export interface Turnstile {
  render: (container: HTMLElement, options: HumanCheckRenderOptions) => string | undefined;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

/** Cloudflare's script, rendering only where `HumanCheck` asks it to. */
export const HUMAN_CHECK_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** How long the script may take to load before the check is said not to have loaded. */
export const HUMAN_CHECK_LOAD_TIMEOUT_MS = 15_000;

/** The build's site key; empty in a local development build (see `vite.config.ts`). */
export const HUMAN_CHECK_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? '';

/**
 * The token a build with no site key sends. Only a back end running with `DISABLE_CAPTCHA`
 * accepts it; `vite build` refuses a bundle with no site key unless it is a local development one.
 */
export const PLACEHOLDER_TOKEN = 'e2e-test-captcha-token';

/** Said when the check could not load: Cloudflare's script, or its widget, failed. */
export const HUMAN_CHECK_DIDNT_LOAD =
  "The check that you're a person didn't load. Check your connection, then reload the page.";

/** Said when the server asked for the check twice for one submit, the automatic retry included. */
export const HUMAN_CHECK_NOT_CONFIRMED = "We couldn't confirm you're a person. Try again.";

/**
 * The check could not give a token: its script did not load, or Cloudflare's widget erred or does
 * not run in this browser. A form's submit says its sentence as it says any refusal of its own.
 */
export class HumanCheckUnavailable extends Refusal {
  constructor() {
    super(HUMAN_CHECK_DIDNT_LOAD);
    this.name = 'HumanCheckUnavailable';
  }
}

/** The page's one load of Cloudflare's script, while it is loading or once it has. */
let loading: Promise<Turnstile> | null = null;

/**
 * Load Cloudflare's script once a page, and resolve with `window.turnstile`.
 *
 * Rejects with `HumanCheckUnavailable` on the script's error, on a load that gives no `turnstile`,
 * or after 15 seconds with neither; a rejected load is forgotten, so the next check tries again.
 */
export function loadHumanCheck(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;

  const script = document.createElement('script');
  script.src = HUMAN_CHECK_SCRIPT_URL;
  script.async = true;
  const load = new Promise<Turnstile>((resolve, reject) => {
    const timer = setTimeout(fail, HUMAN_CHECK_LOAD_TIMEOUT_MS);
    function fail() {
      clearTimeout(timer);
      script.remove();
      if (loading === load) loading = null;
      reject(new HumanCheckUnavailable());
    }
    script.addEventListener('load', () => {
      if (!window.turnstile) return fail();
      clearTimeout(timer);
      resolve(window.turnstile);
    });
    script.addEventListener('error', fail);
  });
  loading = load;
  document.head.appendChild(script);
  return load;
}

/** What a form holds of its `HumanCheck`. */
export interface HumanCheckHandle {
  token: () => Promise<string>;
  reset: () => void;
}

/** An answer of the server's asking for the human check: a 403 with `captcha: required`. */
export function isHumanCheckRequired(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { captcha?: unknown } } })
    ?.response;
  return response?.status === 403 && response.data?.captcha === 'required';
}

/**
 * Send a request with the check's token, and once more with a new token when the server asks for
 * the check, within the same submit.
 *
 * The check is reset after every answer, since a token is spent once sent. A second "required"
 * refuses with `HUMAN_CHECK_NOT_CONFIRMED`; a check that cannot give a token refuses with
 * `HUMAN_CHECK_DIDNT_LOAD`, sending nothing.
 *
 * `required` tells what `send` throws when the server asked for the check: the server's own 403
 * unless `send` turns its answers into errors of its own, as the vendor's sign-in does.
 */
export async function withHumanCheck<T>(
  check: HumanCheckHandle,
  send: (token: string) => Promise<T>,
  required: (error: unknown) => boolean = isHumanCheckRequired,
  sends = 2,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const token = await check.token();
    try {
      return await send(token);
    } catch (error) {
      if (!required(error)) throw error;
      if (attempt === sends) throw new Refusal(HUMAN_CHECK_NOT_CONFIRMED);
    } finally {
      check.reset();
    }
  }
}

/**
 * Send a request of a form that puts its check on the page only once the server asks for it, as
 * the organizer's sign-ins do, so an everyday sign-in loads no script of Cloudflare's.
 *
 * With no check on the page (`held` is null) the request goes with no token. When the server asks
 * for the check, `ask` puts it on the page and resolves with it, and the request is sent once more
 * with its token, within the same submit; a second "required" refuses with
 * `HUMAN_CHECK_NOT_CONFIRMED`. Once the check is on the page, every request goes through
 * `withHumanCheck`.
 */
export async function withHumanCheckWhenAsked<T>(
  held: HumanCheckHandle | null,
  ask: () => Promise<HumanCheckHandle>,
  send: (token?: string) => Promise<T>,
): Promise<T> {
  if (held) return withHumanCheck(held, send);
  try {
    return await send();
  } catch (error) {
    if (!isHumanCheckRequired(error)) throw error;
  }
  return withHumanCheck(await ask(), send, isHumanCheckRequired, 1);
}
