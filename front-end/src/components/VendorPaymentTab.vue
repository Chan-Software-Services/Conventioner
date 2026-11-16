<script setup lang="ts">
/**
 * The drawer's Payment tab (E44/F01/S01): what one vendor owes for each table-day, the payments
 * recorded, and how the two compare, with both totals at its head.
 *
 * A line per table-day: its seat and what is owed for it, which the pricing calculates and which
 * follows the seat while nobody has set it by hand. A freed table keeps its line, still owed, and
 * says it was freed and when, so every number says where it came from (Daniel, T92 Q26). The
 * organizers alone read any of this, never the vendor (Q20.2).
 *
 * Each control is offered on the table's row for it (E44/F01/S02): "Record payment" an Editor's;
 * a line's "..." menu (change the amount owed, or use the calculated price again), "Record refund"
 * and an entry's "..." menu (edit or remove it) an Admin's. Each confirms in a dialog first.
 *
 * Each dialog's write belongs to its opening (T411): held while it writes, and an answer that lands
 * after its opening has gone is shown in the account behind the dialog (`refreshed`), never by
 * closing what is open now.
 *
 * The account is one keyed read (T421, `useServerRead`), keyed by market and vendor: moving the
 * drawer to another vendor drops what was shown in the same tick and says "Loading…" until theirs
 * lands, and a read of the last vendor that answers late lands nowhere. A move also closes any
 * dialog open on the last vendor, and each dialog is keyed by the account, so an entry dialog
 * opened on Ana is gone with her and nothing it answers later is heard; a write's answer is taken
 * only into the account it was opened on (`adopt`), so a confirmation of Ana's answering on Ben's
 * tab changes nothing there.
 */
import { computed, inject, onScopeDispose, ref, watch } from 'vue';
import AppDialog from '@/components/AppDialog.vue';
import ChangeOwedDialog from '@/components/ChangeOwedDialog.vue';
import RecordPaymentDialog from '@/components/RecordPaymentDialog.vue';
import RowMenu from '@/components/RowMenu.vue';
import { useDialogSubmit } from '@/utils/useDialogSubmit';
import { useServerRead } from '@/utils/useServerRead';
import { getFormattedTimestamp } from '@/utils/utils';
import { dateLabel } from '@/utils/vendorDetails';
import {
  PAYMENT_WRITTEN,
  accountAsItStands,
  balanceChip,
  balanceText,
  entryChange,
  entryText,
  lineSource,
  loadAccount,
  money,
  removePayment,
  useCalculatedPrice,
  type Payment,
  type PaymentLine,
  type VendorAccount,
} from '@/utils/payments';

const props = defineProps<{
  marketId: string;
  email: string;
  /** Whether this person may record a payment: the table's "Record a payment" row. */
  canRecord: boolean;
  /** "Change the amount owed": each line's menu. */
  canChangeOwed?: boolean;
  /** "Adjust the amount paid": "Record refund" and each entry's menu. */
  canAdjustPaid?: boolean;
}>();

const emit = defineEmits<{
  /** A write changed their account: a screen that shows it, the Payments page, reads it again,
   * since one vendor's change moves the market's totals too. */
  changed: [];
}>();

/** Whose account the tab is open on: the market, and the vendor's address. */
type AccountKey = readonly [marketId: string, email: string];

const accountRead = useServerRead<AccountKey, VendorAccount>(
  () => (props.marketId && props.email ? [props.marketId, props.email] : null),
  ([marketId, email]) => loadAccount(marketId, email),
  { failure: 'Their payments could not be loaded.' },
);
const { phase, sentence, key: openOn } = accountRead;
/** The account as read for the vendor open now, or as a write on it answered. */
const account = accountRead.data;
/** The account the tab is open on, as one name: each dialog is keyed by it. */
const accountName = computed(() => openOn.value?.join('\n') ?? '');

/** The open dialog, if any: one at a time. */
type Open =
  | { kind: 'payment' | 'refund' }
  | { kind: 'edit'; entry: Payment }
  | { kind: 'owed'; line: PaymentLine }
  | { kind: 'calculated'; line: PaymentLine }
  | { kind: 'remove'; entry: Payment };
const open = ref<Open | null>(null);
/** A confirmation refused with the account as it stands behind it: what it asks no longer reads
 * as stored, so it confirms nothing more until it is opened again, as its refusal says. */
const confirmSpent = ref(false);

function show(dialog: Open): void {
  confirmSpent.value = false;
  open.value = dialog;
}

// A move to another vendor or market closes what was open on the last one: a reset of what the
// tab shows, never a read.
let moves = 0;
watch(
  openOn,
  () => {
    moves += 1;
    open.value = null;
    confirmSpent.value = false;
  },
  { flush: 'sync' },
);

let gone = false;
onScopeDispose(() => (gone = true));
const paymentWritten = inject(PAYMENT_WRITTEN, null);
/**
 * A dialog's write, as it is sent. Answered on the account it was made on, the dialog says so
 * itself (`saved`, `refreshed`). Answered once the tab moved to another vendor or market, the
 * dialog is gone with the account it was keyed by: the answer is taken into nothing here, and
 * Payments is told to read its totals again. Answered once the tab itself is gone, the page that
 * showed it is told instead. A refused or failed write tells nothing more than the dialog did.
 */
function sending(write: Promise<VendorAccount>): void {
  const sentAt = moves;
  write.then(
    () => {
      if (gone) paymentWritten?.();
      else if (moves !== sentAt) emit('changed');
    },
    () => undefined,
  );
}

/** A write's answer, taken into the account it was made on: nothing on another vendor's tab. */
function saved(on: AccountKey | null, updated: VendorAccount): void {
  if (on) accountRead.adopt(on, () => updated);
  open.value = null;
  emit('changed');
}

/** A refusal that answered the account as it stands (a press already recorded, or an edit or a
 * removal of an entry changed meanwhile): shown behind the dialog, which stays open with its
 * refusal, since another write moved it; taken only into the account it was made on. */
function refreshed(on: AccountKey | null, updated: VendorAccount): void {
  if (on) accountRead.adopt(on, () => updated);
  emit('changed');
}

const entryDialog = computed(() => {
  const dialog = open.value;
  if (dialog?.kind === 'payment' || dialog?.kind === 'refund')
    return { mode: dialog.kind, entry: null };
  if (dialog?.kind === 'edit') return { mode: 'edit' as const, entry: dialog.entry };
  return null;
});
const owedLine = computed(() => (open.value?.kind === 'owed' ? open.value.line : null));
const confirming = computed(() =>
  open.value?.kind === 'calculated' || open.value?.kind === 'remove' ? open.value : null,
);
/** The confirmation's write, keyed to the confirmation it was opened as. */
const confirmSubmission = useDialogSubmit({
  opening: () => confirming.value,
  failure: 'That change could not be saved.',
});
const { sending: confirmSending } = confirmSubmission;

/** The confirmation of the two changes that ask nothing but yes. */
const confirmText = computed(() => {
  const dialog = confirming.value;
  if (!dialog || !account.value) return null;
  if (dialog.kind === 'calculated') {
    const price = dialog.line.priceCents;
    return {
      title: 'Use the calculated price',
      body: `${dateLabel(dialog.line.date)} will owe ${
        price == null ? 'no price' : money(price, account.value)
      }, as the pricing calculates, instead of ${money(dialog.line.owedCents ?? 0, account.value)}.`,
      confirm: 'Use the calculated price',
    };
  }
  const what = dialog.entry.kind === 'refund' ? 'refund' : 'payment';
  return {
    title: `Remove this ${what}`,
    body: `The ${money(Math.abs(dialog.entry.cents), account.value)} ${what} comes off what they paid. It stays listed as removed, with who removed it and when.`,
    confirm: `Remove ${what}`,
  };
});

async function confirm(): Promise<void> {
  const dialog = confirming.value;
  const on = openOn.value;
  if (!dialog || !on || confirmSpent.value) return;
  const [marketId, email] = on;
  await confirmSubmission.submit(
    () =>
      dialog.kind === 'calculated'
        ? useCalculatedPrice(marketId, email, dialog.line.date)
        : removePayment(marketId, dialog.entry.id),
    {
      done: (updated) => saved(on, updated),
      refused: (err) => {
        const standing = accountAsItStands(err);
        if (standing) {
          refreshed(on, standing);
          confirmSpent.value = true;
        }
      },
      // An earlier confirmation's answer: the account it was made on takes it, and what is open
      // now stays.
      late: (answer) => {
        const standing = answer.ok ? answer.answer : accountAsItStands(answer.error);
        if (standing) refreshed(on, standing);
      },
    },
  );
}

function lineItems(line: PaymentLine) {
  return [
    { id: 'owed', label: 'Change the amount owed' },
    ...(line.owedSetBy ? [{ id: 'calculated', label: 'Use the calculated price' }] : []),
  ];
}

function onLineMenu(line: PaymentLine, id: string): void {
  show(id === 'calculated' ? { kind: 'calculated', line } : { kind: 'owed', line });
}

const ENTRY_ITEMS = [
  { id: 'edit', label: 'Edit' },
  { id: 'remove', label: 'Remove', destructive: true },
];

function onEntryMenu(entry: Payment, id: string): void {
  show(id === 'remove' ? { kind: 'remove', entry } : { kind: 'edit', entry });
}

/** The served state, for the chip's `data-state`: `none` where the server reads no balance state. */
const state = computed(() => account.value?.balanceState ?? 'none');

/** What a line owes, as it reads: its amount, or that the market gives the seat no price. */
function owedText(cents: number | null): string {
  return cents == null || !account.value ? 'No price' : money(cents, account.value);
}

/** Whether a line shows its calculated price struck beside an amount set by hand. */
function struckPrice(line: PaymentLine): boolean {
  return !!line.owedSetBy && line.priceCents != null && line.priceCents !== line.owedCents;
}
</script>

<template>
  <section class="payment-tab" data-testid="payment-tab">
    <p v-if="phase === 'loading'" class="payment-note">Loading…</p>
    <p v-else-if="phase === 'failed'" class="payment-note">{{ sentence }}</p>

    <template v-else-if="account">
      <div class="payment-totals">
        <dl class="payment-figures">
          <div class="payment-figure">
            <dt>Owed</dt>
            <dd data-testid="payment-owed">{{ money(account.owedCents, account) }}</dd>
          </div>
          <div class="payment-figure">
            <dt>Paid</dt>
            <dd data-testid="payment-paid">{{ money(account.paidCents, account) }}</dd>
          </div>
        </dl>
        <span
          class="chip"
          :class="balanceChip(account.balanceState)"
          :data-state="state"
          data-testid="payment-balance"
        >
          {{ balanceText(account) }}
        </span>
      </div>

      <div class="payment-group">
        <h3 class="payment-heading">Table-days</h3>
        <p v-if="account.lines.length === 0" class="payment-note">
          No table yet, so nothing is owed.
        </p>
        <ul v-else class="payment-list">
          <li
            v-for="line in account.lines"
            :key="line.date"
            class="payment-line"
            :data-date="line.date"
            data-testid="payment-line"
          >
            <div class="payment-line-main">
              <span class="payment-line-date">{{ dateLabel(line.date) }}</span>
              <span class="payment-line-seat" data-testid="payment-line-source"
                >{{ lineSource(line).text
                }}<template v-if="lineSource(line).freedOn"
                  >{{ ' '
                  }}<span class="payment-entry-when">{{ lineSource(line).freedOn }}</span></template
                ></span
              >
              <span v-if="line.owedSetBy" class="payment-line-seat" data-testid="payment-line-set">
                <!-- A free's deduction is told apart from a hand-set amount: seating the day again
                     takes it back, where an amount set by hand holds. -->
                {{ line.owedByFree ? 'Removed when the table was freed, by' : 'Set by' }}
                {{ line.owedSetBy }},
                <span class="payment-entry-when">{{
                  getFormattedTimestamp(line.owedSetAt) || line.owedSetAt
                }}</span>
              </span>
            </div>
            <span class="payment-amounts">
              <s
                v-if="struckPrice(line)"
                class="payment-struck"
                data-testid="payment-line-price"
                :aria-label="`Calculated ${owedText(line.priceCents)}`"
                >{{ owedText(line.priceCents) }}</s
              >
              <span class="payment-amount" data-testid="payment-line-owed">
                {{ owedText(line.owedCents) }}
              </span>
            </span>
            <RowMenu
              v-if="canChangeOwed"
              :label="`Change what ${dateLabel(line.date)} owes`"
              :items="lineItems(line)"
              testid="payment-line-menu"
              @select="onLineMenu(line, $event)"
            />
          </li>
        </ul>
      </div>

      <div class="payment-group">
        <div class="payment-group-head">
          <h3 class="payment-heading">Payments</h3>
          <div class="payment-actions">
            <button
              v-if="canAdjustPaid"
              type="button"
              class="btn btn--secondary btn--compact"
              data-testid="payment-refund"
              @click="show({ kind: 'refund' })"
            >
              Record refund
            </button>
            <button
              v-if="canRecord"
              type="button"
              class="btn btn--secondary btn--compact"
              data-testid="payment-record"
              @click="show({ kind: 'payment' })"
            >
              Record payment
            </button>
          </div>
        </div>
        <p v-if="account.payments.length === 0" class="payment-note">No payments recorded.</p>
        <ul v-else class="payment-list">
          <li
            v-for="payment in account.payments"
            :key="payment.id"
            class="payment-entry"
            :class="{ 'payment-entry--removed': payment.removedAt }"
            :data-kind="payment.kind"
            data-testid="payment-entry"
          >
            <div class="payment-line-main">
              <span class="payment-entry-what"
                >{{ entryText(payment).text }}{{ ' '
                }}<span class="payment-entry-when">{{ entryText(payment).day }}</span></span
              >
              <span v-if="payment.note" class="payment-entry-note">{{ payment.note }}</span>
              <span class="payment-entry-who" data-testid="payment-entry-who">
                Recorded by {{ payment.recordedBy }},
                <span class="payment-entry-when">{{
                  getFormattedTimestamp(payment.recordedAt) || payment.recordedAt
                }}</span>
              </span>
              <span
                v-if="entryChange(payment)"
                class="payment-entry-who"
                data-testid="payment-entry-change"
              >
                {{ entryChange(payment)?.verb }} by {{ entryChange(payment)?.by }},
                <span class="payment-entry-when">{{
                  getFormattedTimestamp(entryChange(payment)?.at) || entryChange(payment)?.at
                }}</span>
              </span>
            </div>
            <span class="payment-amounts">
              <component
                :is="payment.removedAt ? 's' : 'span'"
                class="payment-amount"
                data-testid="payment-entry-amount"
                >{{ money(payment.cents, account) }}</component
              >
            </span>
            <RowMenu
              v-if="canAdjustPaid && !payment.removedAt"
              :label="`Change the ${money(Math.abs(payment.cents), account)} ${payment.kind}`"
              :items="ENTRY_ITEMS"
              testid="payment-entry-menu"
              @select="onEntryMenu(payment, $event)"
            />
            <!-- A removed entry offers nothing, and its amount still lines up with the rest. -->
            <span v-else-if="canAdjustPaid" class="payment-menu-room" aria-hidden="true" />
          </li>
        </ul>
      </div>
    </template>

    <!-- To the body, so each is a sibling of the drawer and centred on the window: the drawer's panel
         carries a transform, which makes it the box a fixed dialog inside it centres on (dialogs: a
         dialog opened from inside a modal teleports). -->
    <Teleport to="body">
      <!-- Keyed by the account, so a dialog opened on one vendor is gone with them, and nothing it
           answers after the move is heard on the next vendor's tab. -->
      <RecordPaymentDialog
        :key="`record ${accountName}`"
        :open="!!entryDialog"
        :marketId="marketId"
        :email="email"
        :currency="account?.currency"
        :mode="entryDialog?.mode"
        :entry="entryDialog?.entry"
        @close="open = null"
        @saved="saved(openOn, $event)"
        @refreshed="refreshed(openOn, $event)"
        @sending="sending"
      />
      <ChangeOwedDialog
        :key="`owed ${accountName}`"
        :open="!!owedLine"
        :marketId="marketId"
        :email="email"
        :line="owedLine"
        :currency="account?.currency ?? null"
        @close="open = null"
        @saved="saved(openOn, $event)"
        @refreshed="refreshed(openOn, $event)"
        @sending="sending"
      />
      <AppDialog
        :open="!!confirmText"
        :title="confirmText?.title ?? ''"
        testid="payment-confirm"
        :confirm-label="confirmSending ? 'Saving…' : confirmText?.confirm"
        :confirm-disabled="confirmSpent"
        :destructive="confirming?.kind === 'remove'"
        :submission="confirmSubmission"
        @close="open = null"
        @submit="confirm"
      >
        <p class="payment-confirm-body" data-testid="payment-confirm-body">
          {{ confirmText?.body }}
        </p>
      </AppDialog>
    </Teleport>
  </section>
</template>

<style scoped>
.payment-tab {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.payment-note {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

/* The two totals, and how they compare: what an organizer opens the tab to read. */
.payment-totals {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3) var(--space-4);
}

.payment-figures {
  display: flex;
  gap: var(--space-6);
  margin: 0;
}

.payment-figure dt {
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

.payment-figure dd {
  margin: 0;
  font-family: 'Merge One', sans-serif;
  font-size: var(--text-lg);
  color: var(--mm-black);
}

.payment-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* The heading, with "Record payment" at its end, as the Submission's carries "Update info". */
.payment-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.payment-heading {
  margin: 0;
  font-family: 'Merge One', sans-serif;
  font-size: var(--text-sm);
  color: var(--mm-green);
}

.payment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.payment-line,
.payment-entry {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--mm-border);
}

.payment-line:last-child,
.payment-entry:last-child {
  border-bottom: none;
}

.payment-line-main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-hairline);
  min-width: 0;
}

.payment-line-date,
.payment-entry-what {
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.payment-line-seat,
.payment-entry-who {
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
  overflow-wrap: anywhere;
}

/* "Oct 30, 2026 at 3:27 PM" holds together: "PM" alone on a line reads as a stray word. */
.payment-entry-when {
  white-space: nowrap;
}

.payment-entry-note {
  font-size: var(--text-sm);
  color: var(--mm-black);
  overflow-wrap: anywhere;
}

.payment-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

/* A line's amount, and beside it the calculated price struck when someone set it by hand. */
.payment-amounts {
  flex-shrink: 0;
  margin-left: auto;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.payment-menu-room {
  flex-shrink: 0;
  width: var(--target-min);
}

.payment-struck {
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

.payment-entry--removed .payment-entry-what,
.payment-entry--removed .payment-entry-note,
.payment-entry--removed .payment-amount {
  color: var(--mm-text-muted);
}

.payment-confirm-body {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.payment-amount {
  flex-shrink: 0;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
  color: var(--mm-black);
}
</style>
