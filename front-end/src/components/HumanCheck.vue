<script setup lang="ts">
/**
 * The human check (T539): Cloudflare Turnstile's widget, the only code that renders it.
 *
 * Managed mode, shown only when Cloudflare needs the person to tick a box (`interaction-only`), and
 * making its token as it renders, so a form's submit rarely waits. A form holds one, directly above
 * its primary button, and sends its token through `withHumanCheck` (`@/utils/captcha`), which
 * calls `token()` and `reset()`.
 *
 * - `token()` resolves with the widget's unspent token, or waits for the next one: without limit
 *   while Cloudflare shows its tick box, else up to 30 seconds. It rejects with
 *   `HumanCheckUnavailable` when the script does not load, when the widget errs or does not run in
 *   this browser, or when those 30 seconds pass.
 * - `reset()` spends the held token and asks the widget for a new one; a form resets after each
 *   answer that used a token.
 *
 * With no site key (a local development build) it renders nothing, loads nothing, and `token()`
 * resolves the placeholder the local back end accepts.
 */
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
import {
  HUMAN_CHECK_SITE_KEY,
  HumanCheckUnavailable,
  loadHumanCheck,
  PLACEHOLDER_TOKEN,
  type HumanCheckHandle,
  type Turnstile,
} from '@/utils/captcha';

const props = defineProps<{
  /** The action the server requires the token to carry: `sign-up`, `sign-in`, `vendor-sign-in`. */
  action: string;
  /** The widget's site key; the build's when left out. The component library passes Cloudflare's test keys. */
  siteKey?: string;
}>();

/** How long `token()` waits for a token while no tick box shows. */
const TOKEN_TIMEOUT_MS = 30_000;
/** From this width the widget stretches to the form's (`flexible`); under it, it is `compact`. */
const FLEXIBLE_FROM_PX = 300;

const siteKey = props.siteKey ?? HUMAN_CHECK_SITE_KEY;
const box = useTemplateRef<HTMLDivElement>('box');
/** Cloudflare is showing its tick box, so a token waits for the person without limit. */
let asking = false;
/** Cloudflare has drawn into the box (its tick box, its success or its error), so it keeps room. */
const drawn = ref(false);
let resizes: ResizeObserver | null = null;

let turnstile: Turnstile | null = null;
let widgetId: string | undefined;
let unmounted = false;
/** The token the widget made and no request has spent yet. */
let held: string | null = null;
/** Why no token will come until the widget recovers, or for good when the script failed. */
let failed: { lasting: boolean } | null = null;

interface Waiter {
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}
const waiters = new Set<Waiter>();

function startTimer(waiter: Waiter) {
  waiter.timer = setTimeout(() => {
    waiters.delete(waiter);
    waiter.reject(new HumanCheckUnavailable());
  }, TOKEN_TIMEOUT_MS);
}

function stopTimer(waiter: Waiter) {
  if (waiter.timer !== null) clearTimeout(waiter.timer);
  waiter.timer = null;
}

function fail(lasting: boolean) {
  failed = { lasting };
  for (const waiter of waiters) {
    stopTimer(waiter);
    waiter.reject(new HumanCheckUnavailable());
  }
  waiters.clear();
}

function gave(token: string) {
  held = token;
  if (!failed?.lasting) failed = null;
  for (const waiter of waiters) {
    stopTimer(waiter);
    waiter.resolve(token);
  }
  waiters.clear();
}

function token(): Promise<string> {
  if (!siteKey) return Promise.resolve(PLACEHOLDER_TOKEN);
  if (held !== null) return Promise.resolve(held);
  if (failed || unmounted) return Promise.reject(new HumanCheckUnavailable());
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, timer: null };
    waiters.add(waiter);
    if (!asking) startTimer(waiter);
  });
}

function reset() {
  held = null;
  if (!failed?.lasting) failed = null;
  if (turnstile && widgetId !== undefined) turnstile.reset(widgetId);
}

defineExpose<HumanCheckHandle>({ token, reset });

onMounted(async () => {
  if (!siteKey || !box.value) return;
  resizes = new ResizeObserver(() => {
    drawn.value = (box.value?.getBoundingClientRect().height ?? 0) > 0;
  });
  resizes.observe(box.value);
  try {
    turnstile = await loadHumanCheck();
  } catch {
    fail(true);
    return;
  }
  if (unmounted || !box.value) return;
  widgetId = turnstile.render(box.value, {
    sitekey: siteKey,
    action: props.action,
    appearance: 'interaction-only',
    size: box.value.getBoundingClientRect().width >= FLEXIBLE_FROM_PX ? 'flexible' : 'compact',
    'refresh-expired': 'auto',
    retry: 'auto',
    execution: 'render',
    theme: 'light',
    language: 'auto',
    callback: gave,
    'error-callback': () => fail(false),
    'expired-callback': () => {
      held = null;
    },
    'unsupported-callback': () => fail(true),
    'before-interactive-callback': () => {
      asking = true;
      for (const waiter of waiters) stopTimer(waiter);
    },
    'after-interactive-callback': () => {
      asking = false;
      for (const waiter of waiters) if (waiter.timer === null) startTimer(waiter);
    },
  });
});

onBeforeUnmount(() => {
  unmounted = true;
  resizes?.disconnect();
  if (turnstile && widgetId !== undefined) turnstile.remove(widgetId);
  fail(true);
});
</script>

<template>
  <div
    v-if="siteKey"
    ref="box"
    class="human-check"
    :class="{ 'human-check--drawn': drawn }"
    data-testid="human-check"
  />
</template>

<style scoped>
/* The form's full width, and no room of its own until Cloudflare draws its box into it. */
.human-check {
  width: 100%;
}

.human-check--drawn {
  margin-bottom: var(--space-3);
}
</style>
