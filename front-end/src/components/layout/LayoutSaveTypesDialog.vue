<script setup lang="ts">
/**
 * "Save these types" (T257): the market's table types saved under a name, for "Use saved types"
 * in another market. The card saves them through the `submission` it hands here (T411), which
 * holds the dialog while it sends and says its refusal.
 */
import { computed, ref, watch } from 'vue';
import AppDialog from '@/components/AppDialog.vue';
import type { DialogSubmission } from '@/utils/useDialogSubmit';
import { plural } from '@/utils/utils';

const props = defineProps<{
  open: boolean;
  /** How many types are saved. */
  count: number;
  /** The card's write of the saved types, which holds the dialog while it sends. */
  submission: DialogSubmission;
}>();

const emit = defineEmits<{ close: []; save: [name: string] }>();

const sending = computed(() => props.submission.sending.value);

const name = ref('');
const tried = ref(false);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    name.value = '';
    tried.value = false;
  },
);

const nameError = computed(() =>
  tried.value && !name.value.trim() ? 'Name the saved types, such as the venue.' : '',
);

function save() {
  tried.value = true;
  if (sending.value || !name.value.trim()) return;
  emit('save', name.value.trim());
}
</script>

<template>
  <AppDialog
    :open="open"
    title="Save these types"
    testid="layout-save-types"
    :confirm-label="sending ? 'Saving…' : 'Save'"
    :submission="submission"
    @close="emit('close')"
    @submit="save"
  >
    <div class="save-fields">
      <p class="save-note">
        The market's {{ plural(count, 'table type', 'table types') }}, to use in another market.
      </p>
      <label class="save-field">
        <span class="field-label">Name</span>
        <input
          v-model="name"
          class="field"
          type="text"
          autocomplete="off"
          maxlength="100"
          :disabled="sending"
          :aria-invalid="!!nameError"
          :aria-describedby="nameError ? 'layout-save-types-name-error' : undefined"
          data-testid="layout-save-types-name"
        />
        <span
          v-if="nameError"
          id="layout-save-types-name-error"
          class="save-error"
          data-testid="layout-save-types-name-error"
          >{{ nameError }}</span
        >
      </label>
    </div>
  </AppDialog>
</template>

<style scoped>
.save-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.save-note {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.save-field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.save-error {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--mm-red);
}
</style>
