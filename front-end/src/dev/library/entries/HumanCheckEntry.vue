<script setup lang="ts">
/**
 * The human check (T539): `HumanCheck`, Cloudflare Turnstile's widget, drawn above a form's button
 * as organizer sign-up and the vendor's sign-in hold it, with Cloudflare's published test site
 * keys: one that passes unseen and one that always asks for the tick. Each form is drawn at a
 * desk's sign-in width and at a 320-pixel phone's, where the widget is compact. Its button sends
 * nothing: it asks the check for a token, through `withHumanCheck` as a form does, and reads out
 * what it got.
 *
 * The sentences a person sees of the check, each said in the sign-in's line as a form says it.
 */
import { reactive } from 'vue';
import HumanCheck from '@/components/HumanCheck.vue';
import SignInMessage from '@/components/SignInMessage.vue';
import {
  HUMAN_CHECK_DIDNT_LOAD,
  HUMAN_CHECK_NOT_CONFIRMED,
  withHumanCheck,
  type HumanCheckHandle,
} from '@/utils/captcha';
import { refusalSentence } from '@/utils/useSubmit';
import LibraryPanel from '../parts/LibraryPanel.vue';
import LibrarySection from '../parts/LibrarySection.vue';
import ReadOut from '../parts/ReadOut.vue';

/** Cloudflare's test site keys (developers.cloudflare.com/turnstile/troubleshooting/testing/). */
const PASSES_UNSEEN = '1x00000000000000000000AA';
const ASKS_FOR_THE_TICK = '3x00000000000000000000FF';

/** Each demo form: its key, its width, and what its button last got. */
const FORMS = [
  { id: 'unseen-desk', label: 'Passes unseen, at a desk', siteKey: PASSES_UNSEEN, phone: false },
  { id: 'unseen-phone', label: 'Passes unseen, on a phone', siteKey: PASSES_UNSEEN, phone: true },
  {
    id: 'tick-desk',
    label: 'Asks for the tick, at a desk',
    siteKey: ASKS_FOR_THE_TICK,
    phone: false,
  },
  {
    id: 'tick-phone',
    label: 'Asks for the tick, on a phone',
    siteKey: ASKS_FOR_THE_TICK,
    phone: true,
  },
] as const;
type FormId = (typeof FORMS)[number]['id'];

/** Each form's check, as its template ref sets it. */
const checks: Partial<Record<FormId, HumanCheckHandle>> = {};
function holdCheck(id: FormId, check: unknown) {
  if (check) checks[id] = check as HumanCheckHandle;
  else delete checks[id];
}

const got = reactive<Record<FormId, string | null>>({
  'unseen-desk': null,
  'unseen-phone': null,
  'tick-desk': null,
  'tick-phone': null,
});

async function ask(id: FormId) {
  got[id] = 'waiting for a token';
  try {
    const token = await withHumanCheck(checks[id]!, async (token) => token);
    got[id] = `a token, ${token}`;
  } catch (error) {
    got[id] = refusalSentence(error) ?? 'an error';
  }
}

const SENTENCES = [
  { label: "The check didn't load", text: HUMAN_CHECK_DIDNT_LOAD, testid: 'didnt-load' },
  { label: 'The server asked twice', text: HUMAN_CHECK_NOT_CONFIRMED, testid: 'not-confirmed' },
];
</script>

<template>
  <LibrarySection
    title="Above a form's button"
    about="Organizer sign-up and the vendor's sign-in: managed, shown only when Cloudflare asks for the tick, flexible from 300px wide and compact under it"
  >
    <LibraryPanel
      v-for="form in FORMS"
      :key="form.id"
      :label="form.label"
      :class="{ 'human-check-wide': !form.phone }"
    >
      <form
        class="human-check-form"
        :class="{ 'human-check-form--phone': form.phone }"
        :data-testid="`library-human-check-${form.id}`"
        @submit.prevent="ask(form.id)"
      >
        <HumanCheck
          :ref="(check) => holdCheck(form.id, check)"
          action="sign-up"
          :site-key="form.siteKey"
        />
        <button type="submit" class="btn btn--primary human-check-form__button">
          Create account
        </button>
        <ReadOut class="human-check-form__read-out" label="Got" :value="got[form.id]" />
      </form>
    </LibraryPanel>
  </LibrarySection>

  <LibrarySection
    title="What a person is told"
    about="In the form's line, the sign-in's own: when the check could not load, and when the server asked for it again after the one automatic retry"
  >
    <LibraryPanel v-for="sentence in SENTENCES" :key="sentence.testid" :label="sentence.label">
      <div class="human-check-form human-check-form--phone">
        <SignInMessage
          :notice="{ tone: 'error', text: sentence.text }"
          :testid-prefix="`library-human-check-${sentence.testid}`"
        />
      </div>
    </LibraryPanel>
  </LibrarySection>
</template>

<style scoped>
/* A desk's form is wider than a grid's column, so its panel spans the section's grid. */
.human-check-wide {
  grid-column: 1 / -1;
}

/* A sign-in form's column, as the form draws it: a desk's sign-in card holds 536px, a 320-pixel
   phone's 224px, and the check sits directly on the button, keeping its own room once drawn. */
.human-check-form {
  display: flex;
  flex-direction: column;
  width: min(100%, 536px);
}

.human-check-form--phone {
  width: min(100%, 224px);
}

.human-check-form__button {
  width: 100%;
}

.human-check-form__read-out {
  margin-top: var(--space-2);
}
</style>
