<script setup lang="ts">
/**
 * Fixing the form without leaving the import (E20/F03/S01).
 *
 * The wizard used to print manual steps - "turn it off in the form builder, then import again" -
 * and the organizer lost their upload on the way. A Google Form market's first import runs while
 * it is a draft (E38/F04/S01), where its form is writable, so this writes the form through the one
 * form writer, and the wizard keeps the file, the mapping and the cursor meanwhile.
 *
 * It covers BOTH of the wizard's dead ends, because the source itself calls them the same shape:
 * a column with nowhere to go needs a custom field, and a question the form never asked needs
 * that question turned off. Either way the answer is an edit to the form.
 *
 * It mirrors the one refusal an organizer can cause - a form that asks nothing, which keeps the
 * market from entering Review - so it is immediate; the server is the authority on the rest, and
 * its answer is the one shown.
 *
 * Its save belongs to its opening on this market (T411): nothing closes it while it saves, and a
 * save answered after it was closed and opened again leaves the new opening alone.
 */
import { computed, ref, watch } from 'vue';
import AppDialog from '@/components/AppDialog.vue';
import { api, isMarketChanged } from '@/utils/api';
import { useDialogSubmit } from '@/utils/useDialogSubmit';
import {
  SECTION_RANKING_KEY,
  SECTION_RANKING_LABEL,
  TABLE_TYPE_RANKING_KEY,
  TABLE_TYPE_RANKING_LABEL,
  REQUEST_KEY,
  REQUEST_LABEL,
  UNASKABLE_ESSENTIAL_KEYS,
  askedEssentialAnswers,
  planDerivedAskedKeys,
} from '@/utils/essentialFields';
import { fieldKeyError } from '@/utils/applicationForm';
import type { ApplicationForm, EssentialFormOptions, FormField } from '@/assets/types/datatypes';

const props = defineProps<{
  open: boolean;
  marketId: string;
  /** The form as stored, which is what this dialog edits a copy of. */
  applicationForm: ApplicationForm | null;
  /**
   * The revision of that form, as the form read answered it: the save sends it, so one made from
   * a copy older than the stored form is refused rather than replacing it (ADR 0024).
   */
  formRevision: number | null;
  essentialOptions: EssentialFormOptions;
  /** Prefilled when the dialog was opened from a column with nowhere to go. */
  suggestedFieldLabel?: string;
  /** Prefilled when it was opened from a question the form never asked. */
  suggestedUnasked?: string;
}>();

/**
 * `changed` is the save refused because the form changed since it was read: the import reads it
 * again, and the dialog stays open on the sentence with the form as it now stands.
 */
const emit = defineEmits<{ close: []; amended: [form: ApplicationForm]; changed: [] }>();

const newFieldLabel = ref('');
const newFieldKey = ref('');
const unasked = ref<string[]>([]);
const keyTouched = ref(false);
/** Said beside the form's own refusals, in the body, where it has always been. */
const submission = useDialogSubmit({
  opening: () => (props.open ? props.marketId : null),
  failure: 'Could not save the form.',
  says: 'self',
});
const { sentence: errorMessage } = submission;

/** A label becomes a key until the organizer names one - the form builder's own rule. */
watch(newFieldLabel, (label) => {
  if (keyTouched.value) return;
  newFieldKey.value = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
});

/** The questions turned off: the form's, and the one the import suggested turning off. */
function seedUnasked() {
  unasked.value = [...(props.applicationForm?.unaskedEssentials ?? [])];
  if (props.suggestedUnasked && !unasked.value.includes(props.suggestedUnasked)) {
    unasked.value.push(props.suggestedUnasked);
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    newFieldLabel.value = props.suggestedFieldLabel ?? '';
    keyTouched.value = false;
    seedUnasked();
  },
  { immediate: true },
);

/**
 * The form read again after a save refused as the market changed (ADR 0024): the questions turned
 * off follow it, as the questions do, so the next Save never sends the refused copy's list with the
 * new revision over a colleague's change. The question being added is kept.
 */
watch(
  () => props.formRevision,
  () => {
    if (props.open) seedUnasked();
  },
);

/** Only the rankings and the request may be turned off, and only what this market's plan offers. */
const UNASKABLE_LABELS: Record<string, string> = {
  [SECTION_RANKING_KEY]: SECTION_RANKING_LABEL,
  [TABLE_TYPE_RANKING_KEY]: TABLE_TYPE_RANKING_LABEL,
  [REQUEST_KEY]: REQUEST_LABEL,
};

/** What the essential questions currently ask, ignoring what is already turned off. */
const askedNow = computed(() =>
  askedEssentialAnswers({ ...props.essentialOptions, unasked: [] }).map((answer) => answer.key),
);

const togglable = computed(() =>
  UNASKABLE_ESSENTIAL_KEYS.filter((key) => askedNow.value.includes(key)).map((key) => ({
    key,
    label: UNASKABLE_LABELS[key] ?? key,
  })),
);

const existingFields = computed(() => props.applicationForm?.fields ?? []);

const keyError = computed(() => {
  if (!newFieldLabel.value.trim()) return '';
  const key = newFieldKey.value.trim();
  // The builder's own check, so this never offers a key the save refuses:
  // a column headed "Submitted at" slugs to the import's own `submitted_at` (E38/F02).
  const refusal = fieldKeyError(key);
  if (refusal) return refusal;
  if (existingFields.value.some((field) => field.key === key)) {
    return 'This market already asks a question with that key.';
  }
  return '';
});

/** The form this dialog would save. */
const proposed = computed<ApplicationForm>(() => {
  const fields: FormField[] = [...existingFields.value];
  const label = newFieldLabel.value.trim();
  if (label && !keyError.value) {
    fields.push({
      key: newFieldKey.value.trim(),
      label,
      type: 'text',
      required: false,
      options: [],
      order: fields.length,
    } as FormField);
  }
  return {
    ...(props.applicationForm ?? { fields: [] }),
    fields,
    unaskedEssentials: [...unasked.value],
  };
});

/**
 * The one refusal an organizer can cause from here, mirrored so it is immediate.
 *
 * A form is its custom fields PLUS the essential questions the plan asks, so turning every
 * essential question off while adding no field leaves a market that could not enter Review: the
 * move refuses a form that asks nothing (`FormHasFieldsGuard`).
 *
 * It counts what the server counts, the questions the plan offers something for: the names and the
 * business name are asked on every form and the request applies for nothing, so counting them
 * would make this never true - and what it holds is the last thing stopping a market collecting
 * applications it cannot place.
 */
function asksNothing(fields: readonly FormField[], unaskedKeys: readonly string[]): boolean {
  return (
    fields.length === 0 &&
    planDerivedAskedKeys({ ...props.essentialOptions, unasked: [...unaskedKeys] }).length === 0
  );
}

const wouldAskNothing = computed(() => asksNothing(proposed.value.fields, unasked.value));

/**
 * The form as stored asks nothing already: a plan with no dates, no tiers and fewer than two
 * sections, or one whose questions were turned off before. The sentence then says what is true
 * before any change, and Save takes a change that leaves it so, as the server does: only the move
 * into Review refuses such a form, and such a save leaves the import no worse than it found it.
 */
const alreadyAsksNothing = computed(() =>
  asksNothing(existingFields.value, props.applicationForm?.unaskedEssentials ?? []),
);

/**
 * The questions the plan offers that would clear it, by the dialog's own names: with any of them
 * asked, the form asks something. The sentence shows only on a plan offering no dates and no
 * tiers, whose questions cannot be turned off, so there these are the rankings alone.
 */
const remedyLabels = computed(() =>
  planDerivedAskedKeys({ ...props.essentialOptions, unasked: [] }).map(
    (key) => UNASKABLE_LABELS[key] ?? key,
  ),
);

/** The sentence, worded for whether the change leaves it so or it was so already. */
const asksNothingSentence = computed(() => {
  const questions = remedyLabels.value.join(' or ');
  if (!alreadyAsksNothing.value) {
    return (
      'That would leave the form asking nothing about what this market offers, so it could not ' +
      `enter Review. Keep asking ${questions}, or add a question.`
    );
  }
  if (!questions) {
    return (
      'The form asks nothing about what this market offers, so it cannot enter Review until you ' +
      'add a question.'
    );
  }
  return (
    'The form asks nothing about what this market offers, so it cannot enter Review. ' +
    `Ask ${questions} again, or add a question.`
  );
});

const changesNothing = computed(
  () =>
    proposed.value.fields.length === existingFields.value.length &&
    unasked.value.length === (props.applicationForm?.unaskedEssentials ?? []).length,
);

/**
 * A change that makes a form asking something ask nothing is held back: the server would take
 * it, but the import would then refuse every row (`NO_FORM_ERROR`), a dead end this stops short
 * of. A form that asked nothing already may still save a change, as the server takes it.
 */
const cannotSave = computed(
  () =>
    Boolean(keyError.value) ||
    (wouldAskNothing.value && !alreadyAsksNothing.value) ||
    changesNothing.value,
);

async function save() {
  if (cannotSave.value) return;
  const proposal = proposed.value;
  await submission.submit(
    async () => {
      const { data } = await api.put(`/markets/${props.marketId}/application-form`, {
        ...proposal,
        formRevision: props.formRevision,
      });
      return (data?.application_form ?? proposal) as ApplicationForm;
    },
    {
      done: (form) => {
        emit('amended', form);
        emit('close');
      },
      refused: (err) => {
        if (isMarketChanged(err)) emit('changed');
      },
    },
  );
}
</script>

<template>
  <AppDialog
    :open="open"
    title="Fix the form"
    testid="amend-form"
    size="wide"
    scroll="body"
    anchored
    confirm-label="Save and carry on"
    :confirm-disabled="cannotSave"
    :submission="submission"
    @close="emit('close')"
    @submit="save"
  >
    <p class="amend-lede">
      Your upload and your mapping stay exactly as they are. This saves the market's questions, as
      Market Setup would.
    </p>

    <section v-if="togglable.length" class="amend-section">
      <h3>Questions this market asks</h3>
      <p class="amend-help">
        Turn one off and every applicant is treated equally on it. These are preferences, not
        constraints, so a market can stop asking them.
      </p>
      <label
        v-for="question in togglable"
        :key="question.key"
        class="amend-toggle"
        :data-testid="`amend-form-unask-${question.key}`"
      >
        <input v-model="unasked" type="checkbox" :value="question.key" />
        <span>Stop asking {{ question.label }}</span>
      </label>
    </section>

    <section class="amend-section">
      <h3>Add a question</h3>
      <p class="amend-help">For a column with nowhere to go. Leave it blank to add nothing.</p>
      <label class="amend-field">
        <span class="field-label">Question</span>
        <input
          v-model="newFieldLabel"
          type="text"
          class="field"
          placeholder="e.g. What do you sell?"
          data-testid="amend-form-label-input"
        />
      </label>
      <label v-if="newFieldLabel.trim()" class="amend-field">
        <span class="field-label">Answer key</span>
        <input
          v-model="newFieldKey"
          type="text"
          class="field"
          data-testid="amend-form-key-input"
          @input="keyTouched = true"
        />
        <p v-if="keyError" class="amend-error" data-testid="amend-form-key-error">{{ keyError }}</p>
      </label>
    </section>

    <!-- A refusal reads red; where Save takes the change it is a warning, which reads yellow. -->
    <p
      v-if="wouldAskNothing"
      :class="alreadyAsksNothing ? 'amend-warning' : 'amend-error'"
      data-testid="amend-form-asks-nothing"
    >
      {{ asksNothingSentence }}
    </p>

    <p v-if="errorMessage" class="amend-error" data-testid="amend-form-error">
      {{ errorMessage }}
    </p>
  </AppDialog>
</template>

<style scoped>
.amend-lede {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.amend-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.amend-section h3 {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--mm-black);
}

.amend-help {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

.amend-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.amend-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.amend-error {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-red);
}

.amend-warning {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-text-yellow);
}
</style>
