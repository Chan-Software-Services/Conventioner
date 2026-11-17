<script setup lang="ts">
/**
 * Changing what one table-day owes (E44/F01/S02, an Admin's by default): the pricing calculates it,
 * and an Admin may set it, $0 being how a fee is waived (Daniel, T92 Q26: "instead of a button to
 * waive, the admin will set amount owed to zero"). The dialog says the change before Save, which is
 * its confirmation.
 *
 * Its write belongs to its opening (T411): nothing closes it while it saves, and an answer that
 * lands after it was closed and opened again leaves the new opening alone, handing on the account
 * it carries (`refreshed`) so the account behind the dialog is true.
 *
 * `sending` hands its parent each write as it is sent: how a parent hears of a write that outlives
 * the dialog, since once the dialog is gone nothing it would say is heard.
 */
import { computed, ref, watch } from 'vue';
import AppDialog from '@/components/AppDialog.vue';
import { useDialogSubmit } from '@/utils/useDialogSubmit';
import {
  accountAsItStands,
  currencyOf,
  money,
  setAmountOwed,
  type PaymentLine,
  type VendorAccount,
} from '@/utils/payments';
import { centsFromText } from '@/utils/pricing';
import { useAmountField } from '@/utils/useAmountField';
import { dateLabel } from '@/utils/vendorDetails';

const props = defineProps<{
  open: boolean;
  marketId: string;
  email: string;
  line: PaymentLine | null;
  currency: string | null;
}>();
const emit = defineEmits<{
  close: [];
  saved: [account: VendorAccount];
  /** An earlier opening's answer: the account as it stands, with this opening left open. */
  refreshed: [account: VendorAccount];
  /** A write as it is sent, for a parent that outlives the dialog to hear how it answered. */
  sending: [write: Promise<VendorAccount>];
}>();

const amount = ref('');
const submission = useDialogSubmit({
  opening: () => props.open,
  failure: 'The amount owed could not be changed.',
});
const { sending } = submission;
const account = computed(() => ({ currency: props.currency }));

/** The amount reads as currency once left, in the account's (Canadian dollars where none is set). */
const amountField = useAmountField(amount, () => currencyOf(account.value));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    amount.value = money(props.line?.owedCents ?? 0, account.value);
  },
  { immediate: true },
);

/** The amount as cents, $0 included; null while the text is no amount. */
const cents = computed(() => centsFromText(amount.value) ?? null);
const amountError = computed(() =>
  cents.value === null ? 'Type an amount, such as 0, 35 or 35.50.' : '',
);

/** The change, said before Save: "Friday, May 8, 2099 will owe $0.00 instead of $35.00." */
const sentence = computed(() => {
  const line = props.line;
  if (!line || cents.value === null || cents.value === line.owedCents) return '';
  const was = line.owedCents == null ? 'no price' : money(line.owedCents, account.value);
  return `${dateLabel(line.date)} will owe ${money(cents.value, account.value)} instead of ${was}.`;
});
const ready = computed(() => cents.value !== null && cents.value !== props.line?.owedCents);

async function save(): Promise<void> {
  const line = props.line;
  const owed = cents.value;
  if (!ready.value || !line || owed === null) return;
  await submission.submit(
    () => {
      const write = setAmountOwed(props.marketId, props.email, line.date, owed);
      emit('sending', write);
      return write;
    },
    {
      done: (account) => emit('saved', account),
      // An earlier opening's answer: the account behind the dialog takes it, and this opening stays.
      late: (answer) => {
        const standing = answer.ok ? answer.answer : accountAsItStands(answer.error);
        if (standing) emit('refreshed', standing);
      },
    },
  );
}
</script>

<template>
  <AppDialog
    :open="open && !!line"
    title="Change the amount owed"
    testid="change-owed"
    anchored
    :confirm-label="sending ? 'Saving…' : 'Set amount owed'"
    :confirm-disabled="!ready"
    :submission="submission"
    @close="emit('close')"
    @submit="save"
  >
    <div class="change-owed-body">
      <p v-if="line" class="change-owed-note">
        The pricing calculates
        {{ line.priceCents == null ? 'no price' : money(line.priceCents, account) }} for this day.
        Set $0.00 to waive it.
      </p>
      <label class="change-owed-field">
        <span class="field-label">Amount owed{{ currency ? ` (${currency})` : '' }}</span>
        <input
          id="change-owed-amount"
          v-model="amount"
          type="text"
          inputmode="decimal"
          class="field"
          autocomplete="off"
          :aria-invalid="!!amountError"
          :aria-describedby="amountError ? 'change-owed-amount-error' : 'change-owed-sentence'"
          data-testid="change-owed-amount"
          @focus="amountField.onFocus"
          @blur="amountField.onBlur"
          @pointerdown="amountField.onPointerdown"
          @click="amountField.onClick"
        />
        <span
          v-if="amountError"
          id="change-owed-amount-error"
          class="change-owed-error"
          role="alert"
          data-testid="change-owed-amount-error"
          >{{ amountError }}</span
        >
      </label>
      <p
        v-if="sentence"
        id="change-owed-sentence"
        class="change-owed-note"
        data-testid="change-owed-sentence"
      >
        {{ sentence }}
      </p>
    </div>
  </AppDialog>
</template>

<style scoped>
.change-owed-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.change-owed-note {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.change-owed-field {
  display: flex;
  flex-direction: column;
}

.change-owed-error {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--mm-red);
}
</style>
