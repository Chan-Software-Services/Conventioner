<script setup lang="ts">
/**
 * The vendor's check-in, on their own page (ADR 0022).
 *
 * On a market day their seat today is on top with "Check in", and their other days below; once
 * checked in it says when, with "Undo" for a mis-tap. A check-in takes the market's door code: the
 * QR code at the entrance opens this page with it, and the page checks them in for today, after
 * signing them in when it has to; a vendor whose camera will not read it types the code here.
 * Checked in, they check out the same way, with the door code and an "Undo" of its own (T496); a
 * code scanned then is put in the check-out field and sends nothing, since a second scan by
 * accident must never end their day.
 * All of it stands behind the market's self check-in switch: while it is off the card shows the
 * day, the table and what the record has, and says an organizer checks them in or out at the door.
 * Once the market has ended the section is the record: each seat, and when they came and left.
 *
 * "Today" is the vendor's own calendar day, read again whenever the page comes back into view: a
 * phone left open at a door overnight must not keep marking yesterday.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useApplicationStore } from '@/stores/application';
import { calendarToday } from '@/utils/marketGuide';
import { seatLine } from '@/utils/applicantOutcome';
import { getFormattedDate, getTimestampTime } from '@/utils/utils';
import {
  atTheDoorLine,
  cameAndLeft,
  checkInSection,
  onlyOrganizersCheckIn,
  scannedCodeRefusal,
  type CheckInSection,
} from '@/utils/vendorPage';
import { isWholeDoorCode } from '@/utils/doorCode';
import type { ApplicantSeat } from '@/assets/types/datatypes';
import { tableInWords } from '@/utils/placementChange';

const props = defineProps<{ marketSlug: string }>();

const store = useApplicationStore();

const today = ref(calendarToday());
function readToday() {
  today.value = calendarToday();
}

const section = computed<CheckInSection>(() =>
  store.page
    ? checkInSection(store.page, store.application, today.value)
    : { mode: 'none', today: null, others: [] },
);

/** Vendors check themselves in and out here: the market's switch, read with the page. */
const selfCheckIn = computed(() => Boolean(store.page?.selfCheckIn));

/** What today's card says in place of its controls while the switch is off. */
const atTheDoor = computed(() =>
  !selfCheckIn.value && section.value.today ? atTheDoorLine(section.value.today) : null,
);

const typed = ref('');
/** The door code for a check-out: typed, or put here by a scan and sent only by "Check out". */
const typedOut = ref('');
/** The one write that is out, which names its own button while it is. */
const doing = ref<'in' | 'undo-in' | 'out' | 'undo-out' | null>(null);
const busy = computed(() => doing.value !== null);
const error = ref<string | null>(null);
/** What a scanned code came to when it checked nobody in: said once, above the section. */
const notice = ref<string | null>(null);

const typedIsWhole = computed(() => isWholeDoorCode(typed.value));
const typedOutIsWhole = computed(() => isWholeDoorCode(typedOut.value));

async function checkIn(code: string, scanned: boolean) {
  const seat = section.value.today;
  if (!seat) return;
  doing.value = 'in';
  error.value = null;
  const vendor = store.applicantEmail;
  const result = await store.checkIn(seat.date, code);
  doing.value = null;
  if (result.ok) {
    typed.value = '';
    return;
  }
  // A sign-in that ran out takes the page back to the sign-in; a scanned code waits through it,
  // for this vendor's next sign-in and no one else's.
  if (result.signedOut && scanned) store.holdDoorCode(props.marketSlug, code, vendor);
  error.value = result.message;
}

async function checkInTyped() {
  readToday();
  if (!typedIsWhole.value || busy.value) return;
  await checkIn(typed.value, false);
}

async function checkOut() {
  readToday();
  const seat = section.value.today;
  if (!seat || !typedOutIsWhole.value || busy.value) return;
  doing.value = 'out';
  error.value = null;
  const result = await store.checkOut(seat.date, typedOut.value);
  doing.value = null;
  if (result.ok) typedOut.value = '';
  else error.value = result.message;
}

async function undo(what: 'undo-in' | 'undo-out') {
  const seat = section.value.today;
  if (!seat) return;
  doing.value = what;
  error.value = null;
  const result = await (what === 'undo-in'
    ? store.undoCheckIn(seat.date)
    : store.undoCheckOut(seat.date));
  doing.value = null;
  if (!result.ok) error.value = result.message;
}

/** A door code scanned at the entrance, used once, for today. */
async function useScannedCode() {
  // Signed out (a sign-in that ran out mid-check-in), the code waits for the vendor's next sign-in.
  if (!store.isAuthenticatedFor(props.marketSlug)) return;
  const code = store.takeDoorCode(props.marketSlug);
  if (!code || !store.page) return;
  // The page drops a code scanned while the switch is off, and says so; none is sent from here.
  if (onlyOrganizersCheckIn(store.page)) return;
  readToday();
  notice.value = scannedCodeRefusal(store.page, store.application, today.value);
  if (notice.value) return;
  const seat = section.value.today;
  // Checked out, they are done for the day and the code is dropped; checked in, it waits in the
  // check-out field for their own tap.
  if (seat?.checkedOutAt) return;
  if (seat?.checkedInAt) {
    typedOut.value = code;
    return;
  }
  await checkIn(code, true);
}

watch(
  () => store.heldDoorCode,
  () => void useScannedCode(),
);

function onVisible() {
  if (document.visibilityState === 'visible') readToday();
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisible);
  void useScannedCode();
});
onUnmounted(() => document.removeEventListener('visibilitychange', onVisible));

function dayOf(seat: ApplicantSeat): string {
  return getFormattedDate(seat.date) ?? seat.date;
}

function tableOf(seat: ApplicantSeat): string {
  return [tableInWords(seat.tableCode, seat.tableChoice), seat.location].filter(Boolean).join(', ');
}

/** When they came and left that day, as the other days say it in brackets. */
function whenOf(seat: ApplicantSeat): string | null {
  return cameAndLeft(seat, getTimestampTime);
}

/** The same as the record's own line, which opens with a capital. */
function recordOf(seat: ApplicantSeat): string {
  const said = whenOf(seat);
  return said ? said.charAt(0).toUpperCase() + said.slice(1) : 'Not checked in';
}
</script>

<template>
  <p v-if="notice" class="check-in-notice" role="status" data-testid="vendor-check-in-notice">
    {{ notice }}
  </p>

  <section
    v-if="section.mode === 'door'"
    class="check-in"
    aria-labelledby="vendor-check-in-title"
    data-testid="vendor-check-in"
  >
    <h2 id="vendor-check-in-title" class="check-in-title">Check-in</h2>

    <article v-if="section.today" class="seat seat--today" data-testid="vendor-check-in-today">
      <p class="seat-day"><span class="chip chip--informational">Today</span></p>
      <p class="seat-date">{{ dayOf(section.today) }}</p>
      <p class="seat-table">{{ tableOf(section.today) }}</p>

      <div v-if="section.today.checkedInAt" class="seat-done">
        <span class="chip chip--positive" data-testid="vendor-check-in-done">
          Checked in at {{ getTimestampTime(section.today.checkedInAt) }}
        </span>
        <span
          v-if="section.today.checkedOutAt"
          class="chip chip--informational"
          data-testid="vendor-check-out-done"
        >
          Checked out at {{ getTimestampTime(section.today.checkedOutAt) }}
        </span>
        <!-- One Undo, of the latest thing: a check-out is undone before its check-in may be. -->
        <template v-if="selfCheckIn">
          <button
            v-if="section.today.checkedOutAt"
            type="button"
            class="btn btn--secondary"
            :disabled="busy"
            data-testid="vendor-check-out-undo-btn"
            @click="undo('undo-out')"
          >
            {{ doing === 'undo-out' ? 'Undoing…' : 'Undo' }}
          </button>
          <button
            v-else
            type="button"
            class="btn btn--secondary"
            :disabled="busy"
            data-testid="vendor-check-in-undo-btn"
            @click="undo('undo-in')"
          >
            {{ doing === 'undo-in' ? 'Undoing…' : 'Undo' }}
          </button>
        </template>
      </div>

      <template v-if="!selfCheckIn">
        <p v-if="atTheDoor" class="seat-at-door" data-testid="vendor-check-in-at-door">
          {{ atTheDoor }}
        </p>
      </template>

      <template v-else-if="!section.today.checkedInAt">
        <p v-if="doing === 'in' && !typed" class="seat-busy" data-testid="vendor-check-in-busy">
          Checking you in…
        </p>

        <form
          v-else
          class="seat-form"
          data-testid="vendor-check-in-form"
          @submit.prevent="checkInTyped"
        >
          <div class="seat-field">
            <label class="field-label" for="vendor-check-in-code">Door code</label>
            <input
              id="vendor-check-in-code"
              v-model="typed"
              class="field"
              type="text"
              inputmode="text"
              autocapitalize="characters"
              autocomplete="off"
              spellcheck="false"
              maxlength="9"
              placeholder="K7M 4QP"
              aria-describedby="vendor-check-in-code-help"
              data-testid="vendor-check-in-code-input"
            />
            <p id="vendor-check-in-code-help" class="seat-help">
              Type the code under the QR code at the door.
            </p>
          </div>
          <button
            type="submit"
            class="btn btn--primary"
            :disabled="busy || !typedIsWhole"
            data-testid="vendor-check-in-btn"
          >
            {{ doing === 'in' ? 'Checking in…' : 'Check in' }}
          </button>
        </form>
      </template>

      <form
        v-else-if="!section.today.checkedOutAt"
        class="seat-form"
        data-testid="vendor-check-out-form"
        @submit.prevent="checkOut"
      >
        <div class="seat-field">
          <label class="field-label" for="vendor-check-out-code">Door code</label>
          <input
            id="vendor-check-out-code"
            v-model="typedOut"
            class="field"
            type="text"
            inputmode="text"
            autocapitalize="characters"
            autocomplete="off"
            spellcheck="false"
            maxlength="9"
            placeholder="K7M 4QP"
            aria-describedby="vendor-check-out-code-help"
            data-testid="vendor-check-out-code-input"
          />
          <p id="vendor-check-out-code-help" class="seat-help">
            Type the code under the QR code at the door.
          </p>
        </div>
        <button
          type="submit"
          class="btn btn--primary"
          :disabled="busy || !typedOutIsWhole"
          data-testid="vendor-check-out-btn"
        >
          {{ doing === 'out' ? 'Checking out…' : 'Check out' }}
        </button>
      </form>

      <p v-if="error" class="seat-error" role="alert" data-testid="vendor-check-in-error">
        {{ error }}
      </p>
    </article>

    <ul v-if="section.others.length" class="seat-list" data-testid="vendor-check-in-other-days">
      <li v-for="seat in section.others" :key="seat.date">
        {{ seatLine(seat) }}
        <span v-if="whenOf(seat)" class="seat-when">({{ whenOf(seat) }})</span>
      </li>
    </ul>
  </section>

  <section
    v-else-if="section.mode === 'record'"
    class="check-in"
    aria-labelledby="vendor-check-in-record-title"
    data-testid="vendor-check-in-record"
  >
    <h2 id="vendor-check-in-record-title" class="check-in-title">Where you sat</h2>
    <p class="check-in-ended">This market has ended.</p>
    <ul class="seat-list">
      <li
        v-for="seat in section.others"
        :key="seat.date"
        class="seat-record"
        data-testid="vendor-check-in-record-seat"
      >
        {{ seatLine(seat) }}
        <span class="seat-when">{{ recordOf(seat) }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.check-in {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.check-in-title {
  font-family: 'Merge One';
  font-size: var(--text-lg);
  color: var(--mm-black);
  margin: 0;
}

/* Today's seat is the one a vendor at the door acts on, so it is the one in a card. */
.seat {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-6);
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
  background: white;
}

.seat p {
  margin: 0;
}

.seat-date {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--mm-black);
}

.seat-table {
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.seat-done {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.seat-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.seat-field {
  display: flex;
  flex-direction: column;
}

.seat-help {
  margin: var(--space-1) 0 0;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

.check-in-ended {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

.seat-busy,
.seat-at-door {
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

.seat-error {
  font-size: var(--text-sm);
  color: var(--mm-red);
}

.seat-list {
  margin: 0;
  padding-left: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.seat-when {
  color: var(--mm-text-muted);
}

/* In the record, when they came sits on its own line under where they sat. */
.seat-record .seat-when {
  display: block;
}

/* Worded and drawn as the page's other notices. */
.check-in-notice {
  margin: 0;
  background: var(--mm-chip-informational);
  border: 1px solid var(--mm-blue);
  border-radius: var(--radius-control);
  padding: var(--space-4);
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--mm-blue);
}
</style>
