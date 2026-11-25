<script setup lang="ts">
/**
 * The vendor page's sign-in (ADR 0022): an email address, then the six-digit code sent to it.
 *
 * Every address is sent a code, applied or not, so the words are the same for every address and
 * true for each. A right code signs the vendor in through the store, and the page, which watches
 * that, draws their own sections in place of this one.
 *
 * A code takes five tries (T191 F22): a wrong one clears the field and keeps it focused for
 * another; once the code no longer works - its tries used, or its ten minutes up - the field and
 * "Sign in" go, and "Send a new code", after its wait, is the step's one action.
 *
 * "Remember me on this device" (ADR 0022) sits under the code, unticked until ticked, and only
 * while the market has a date left (`rememberUntil`); it says the date it would last until.
 *
 * Its requests go one at a time through one submit scoped by the step (T277 ticket 08): it moves
 * on, and says a refusal, from its own request's answer, never from the store's shared `error`,
 * which another reader may write while the request is out; and "Use a different email" waits for
 * the answer, so a late one never lands on the email step.
 *
 * Both steps hold one human check (T539), mounted with the sign-in, directly above the step's
 * primary button: Send code and Sign in each send its token, the check is reset after every
 * answer, and a request the server answers by asking for the check is sent once more with a new
 * token. A check that cannot load says so in the error line, and the step stays as it was.
 */
import { computed, nextTick, onUnmounted, ref, useTemplateRef } from 'vue';
import CodeInput from '@/components/CodeInput.vue';
import HumanCheck from '@/components/HumanCheck.vue';
import { useApplicationStore, type CodeAnswer } from '@/stores/application';
import type { CodeState } from '@/utils/applicantApi';
import { withHumanCheck, type HumanCheckHandle } from '@/utils/captcha';
import { Refusal, useSubmit } from '@/utils/useSubmit';
import { getShortDate } from '@/utils/utils';

const props = defineProps<{ marketSlug: string }>();

const store = useApplicationStore();

const RESEND_COOLDOWN_SECONDS = 60;

const email = ref('');
const code = ref('');
const step = ref<'email' | 'code'>('email');
const validationError = ref<string | null>(null);
const { sending: submitting, sentence: refusal, submit } = useSubmit({ scope: () => step.value });
/** A request sent from here: from then on the sign-in says only its own answers. */
const sent = ref(false);
/**
 * Why the vendor is asked to sign in, until they send a request: the store's sentence for a sign-in
 * that ended under them ("Your session has expired..."), which brought them here.
 */
const arrivedWith = computed(() => (sent.value ? null : store.error));
const displayedError = computed(() => validationError.value || refusal.value || arrivedWith.value);

/**
 * A refused request's answer, thrown so the submit says its sentence; it carries where the code
 * stands too, for Sign in to act on.
 */
class CodeRefused extends Refusal {
  constructor(readonly answer: Extract<CodeAnswer, { ok: false }>) {
    super(answer.sentence);
  }
}

const signInCheck = useTemplateRef<HumanCheckHandle>('signInCheck');

/**
 * One of the store's code requests, sent from here with the human check's token, its refusal
 * thrown for the submit to say; asked for the check, it is sent once more with a new token.
 */
async function sendFromHere(request: (captchaToken: string) => Promise<CodeAnswer>): Promise<void> {
  validationError.value = null;
  sent.value = true;
  await withHumanCheck(
    signInCheck.value!,
    async (captchaToken) => {
      const answer = await request(captchaToken);
      if (!answer.ok) throw new CodeRefused(answer);
    },
    (error) => error instanceof CodeRefused && error.answer.humanCheckRequired,
  );
}

const codeInput = ref<InstanceType<typeof CodeInput> | null>(null);
const remember = ref(false);
/** The date Remember me would last until, or null when the page offers none. */
const rememberUntil = computed(() => {
  const until = store.page?.rememberUntil;
  return until ? getShortDate(until) : null;
});
/** Where the last refused code stands, from that refusal's answer; null until one is refused. */
const codeState = ref<CodeState | null>(null);
/** The code can no longer pass: only a new one is offered. */
const spent = computed(() => codeState.value === 'spent');

const requestedEmail = ref('');
const cooldownRemaining = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | undefined;

const cooldownApplies = computed(
  () => cooldownRemaining.value > 0 && requestedEmail.value === email.value.trim().toLowerCase(),
);

function startCooldown() {
  cooldownRemaining.value = RESEND_COOLDOWN_SECONDS;
  clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    cooldownRemaining.value -= 1;
    if (cooldownRemaining.value <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = undefined;
    }
  }, 1000);
}

onUnmounted(() => clearInterval(cooldownTimer));

async function requestCode() {
  if (!email.value.trim()) {
    validationError.value = 'Email address is required.';
    return;
  }
  if (cooldownApplies.value) {
    return;
  }
  const address = email.value.trim().toLowerCase();
  await submit(() => sendFromHere((token) => store.requestCode(props.marketSlug, address, token)), {
    done: async () => {
      codeState.value = null;
      requestedEmail.value = address;
      startCooldown();
      code.value = '';
      step.value = 'code';
      await nextTick();
      codeInput.value?.focus();
    },
  });
}

async function verifyCode() {
  if (!code.value.trim()) {
    validationError.value = 'Verification code is required.';
    return;
  }
  const typed = code.value.trim();
  const keep = Boolean(rememberUntil.value) && remember.value;
  // A right code signs the vendor in through the store, and the page draws their sections.
  await submit(
    () =>
      sendFromHere((token) =>
        store.verifyCode(props.marketSlug, email.value.trim().toLowerCase(), typed, keep, token),
      ),
    {
      refused: (err) => {
        if (!(err instanceof CodeRefused)) return;
        codeState.value = err.answer.codeState;
        if (codeState.value === 'retry') {
          code.value = '';
          void nextTick(() => codeInput.value?.focus());
        }
      },
    },
  );
}

function goBack() {
  step.value = 'email';
  code.value = '';
  validationError.value = null;
  codeState.value = null;
}
</script>

<template>
  <section class="sign-in" data-testid="vendor-sign-in">
    <h2 class="sign-in-title">Sign in</h2>

    <div
      v-if="displayedError"
      class="sign-in-error"
      role="alert"
      data-testid="vendor-sign-in-error"
    >
      {{ displayedError }}
    </div>

    <!--
      A native form, not a key handler (E20/F01/S03). Enter then runs the same handler as the
      button and inherits its guard - including the cooldown, which a `@keyup.enter` bypassed.
      One form for both steps, so the human check above the primary button stays mounted, and
      keeps its token, from one step to the next.
    -->
    <form
      class="sign-in-step"
      :data-testid="step === 'email' ? 'vendor-sign-in-email-step' : 'vendor-sign-in-code-step'"
      @submit.prevent="step === 'email' ? requestCode() : verifyCode()"
    >
      <template v-if="step === 'email'">
        <p class="sign-in-instruction">
          Enter your email address. We'll send you a code to sign in with.
        </p>
        <div class="sign-in-field">
          <label class="field-label" for="vendor-sign-in-email">Email</label>
          <input
            id="vendor-sign-in-email"
            v-model="email"
            class="field"
            type="email"
            autocomplete="email"
            placeholder="you@example.com"
            data-testid="vendor-sign-in-email-input"
          />
        </div>
      </template>
      <template v-else>
        <!-- The same words for every address, and true for every address: each is sent a code. -->
        <p
          class="sign-in-instruction sign-in-instruction--centred"
          data-testid="vendor-sign-in-code-instruction"
        >
          We've sent a code to {{ requestedEmail }}. Only the newest one works.
        </p>
        <template v-if="!spent">
          <div class="sign-in-field">
            <label class="field-label" for="vendor-sign-in-code">Sign-in code</label>
            <CodeInput
              id="vendor-sign-in-code"
              ref="codeInput"
              v-model="code"
              data-testid="vendor-sign-in-code-input"
            />
          </div>
          <div v-if="rememberUntil">
            <label class="remember-me">
              <input
                v-model="remember"
                type="checkbox"
                aria-describedby="vendor-sign-in-remember-me-help"
                data-testid="vendor-sign-in-remember-me"
              />
              <!-- "until <date>" wraps as one phrase on a narrow phone, never leaving the year alone. -->
              <span>
                Remember me on this device
                <span class="remember-me-until">until {{ rememberUntil }}</span>
              </span>
            </label>
            <p id="vendor-sign-in-remember-me-help" class="remember-me-help">
              Leave it unticked on a shared device.
            </p>
          </div>
        </template>
      </template>
      <div class="sign-in-actions">
        <HumanCheck ref="signInCheck" action="vendor-sign-in" />
        <button
          v-if="step === 'email'"
          type="submit"
          class="btn btn--primary"
          :disabled="submitting || !email.trim() || cooldownApplies"
          data-testid="vendor-sign-in-request-btn"
        >
          <template v-if="cooldownApplies"
            >Code already sent - retry in {{ cooldownRemaining }}s</template
          >
          <template v-else>{{ submitting ? 'Sending…' : 'Send code' }}</template>
        </button>
        <button
          v-else-if="!spent"
          type="submit"
          class="btn btn--primary"
          :disabled="submitting || code.trim().length !== 6"
          data-testid="vendor-sign-in-verify-btn"
        >
          {{ submitting ? 'Signing in…' : 'Sign in' }}
        </button>
        <!-- `type="button"`: inside a form, a button with no type submits it. -->
        <button
          v-else
          type="button"
          class="btn btn--primary"
          :disabled="submitting || cooldownRemaining > 0"
          data-testid="vendor-sign-in-send-new-code-btn"
          @click="requestCode"
        >
          {{
            cooldownRemaining > 0 ? `Send a new code in ${cooldownRemaining}s` : 'Send a new code'
          }}
        </button>
      </div>
      <div v-if="step === 'code'" class="sign-in-alt">
        <button
          type="button"
          class="sign-in-link-btn"
          :disabled="submitting"
          data-testid="vendor-sign-in-back-btn"
          @click="goBack"
        >
          Use a different email
        </button>
        <template v-if="!spent">
          <span class="sign-in-sep" aria-hidden="true">|</span>
          <button
            type="button"
            class="sign-in-link-btn"
            :disabled="submitting || cooldownRemaining > 0"
            data-testid="vendor-sign-in-resend-btn"
            @click="requestCode"
          >
            {{ cooldownRemaining > 0 ? `Resend code in ${cooldownRemaining}s` : 'Resend code' }}
          </button>
        </template>
      </div>
    </form>
  </section>
</template>

<style scoped>
/* A fixed column, so it does not change width as its steps change words. */
.sign-in {
  width: 100%;
  max-width: 420px;
  margin: 0 auto;
}

.sign-in-title {
  font-family: 'Merge One';
  font-size: var(--text-lg);
  color: var(--mm-black);
  text-align: center;
  margin: 0 0 var(--space-4);
}

.sign-in-error {
  background: var(--mm-chip-destructive);
  border: 1px solid var(--mm-red);
  border-radius: var(--radius-control);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
  font-size: var(--text-sm);
  color: var(--mm-text-red-on-tint);
}

.sign-in-step {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* The step's primary button, with the human check directly above it: the check takes no room until
   Cloudflare draws into it, and the button keeps the step's full width. */
.sign-in-actions {
  display: flex;
  flex-direction: column;
}

/* A field and its label, held together rather than spaced like the step's other parts. */
.sign-in-field {
  display: flex;
  flex-direction: column;
}

.sign-in-instruction {
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
  margin: 0;
  line-height: 1.5;
}

/* The code step has one alignment: its line centred, as the title over it and the links under it
   are; the label stays left over its full-width field, as every label does (T191 F21). */
.sign-in-instruction--centred {
  text-align: center;
}

/* The choice and its label are one target, at least `--target-min` tall (44px on a phone), and
   only as wide as its words, so a tap beside it does not tick it; as at the organizer's sign-in. */
.remember-me {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--target-min);
  font-size: var(--text-sm);
  color: var(--mm-black);
  cursor: pointer;
}

.remember-me-until {
  white-space: nowrap;
}

/* What the choice is for, said under it in the hint's size. */
.remember-me-help {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

.sign-in-alt {
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  gap: var(--space-2);
}

/* Each a target of its own (`--target-min`, 44px on a phone), sitting on its text. */
.sign-in-link-btn {
  --focus-border-offset: var(--focus-border-width);
  min-height: var(--target-min);
  background: none;
  border: none;
  color: var(--mm-text-muted);
  cursor: pointer;
  font-size: var(--text-xs);
  text-decoration: underline;
  padding: 0;
}

/* Still read in full while it waits: it says when the code can be sent again, which a 50% fade
   left below AA. Not underlined, so it does not read as something to press yet. */
.sign-in-link-btn:disabled {
  text-decoration: none;
  cursor: not-allowed;
}

.sign-in-sep {
  color: var(--mm-text-muted);
}
</style>
