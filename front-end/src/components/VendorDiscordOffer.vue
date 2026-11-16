<script setup lang="ts">
/**
 * The vendor drawer's Discord section (E46/F01/S05): what the last "Check Discord" asks of the
 * organizer about this vendor.
 *
 * A vendor not found is offered the members whose name looks like the username on file, each as
 * "Possible match: <name> @<username>" with "Confirm…" and "Not them". Confirming opens a dialog
 * with what the vendor wrote and the member's username, and saves that username as an update of
 * their answer, the ordinary one (E41/F01/S01): who, when, and their own answer kept beside it, so
 * the next check matches them. Nothing is applied without that confirmation (Daniel, T92 Q19).
 * "Not them" declines the member, who is never offered to this vendor again, and the vendor stays
 * "Not found".
 *
 * A vendor whose username was updated after the check is told to check again, since the state was
 * read for the answer before.
 *
 * The confirmation belongs to the vendor it was opened for (T411): the drawer keeps this section
 * across a change of vendor, so the change closes it, and an update saved after that is handed on
 * as `refreshed`, never as the `confirmed` that closes what is open now. Nothing closes it while it
 * saves.
 */
import { computed, ref, watch } from 'vue';
import type { Application, DiscordPossibleMatch, Market } from '@/assets/types/datatypes';
import AnswerValue from '@/components/AnswerValue.vue';
import AppDialog from '@/components/AppDialog.vue';
import { getApiErrorMessage } from '@/utils/api';
import { theirAnswer, updateVendorInfo } from '@/utils/answerUpdates';
import { declineMatch, discordAsks, matchNames, type DiscordVendor } from '@/utils/discordCheck';
import { useMarketStore } from '@/stores/market';
import { useDialogSubmit } from '@/utils/useDialogSubmit';

const props = defineProps<{
  market: Market | null | undefined;
  application: Application | null;
  vendor: DiscordVendor | null;
  /** Whether this person may answer an offer: the row "Update a vendor's info", and the row for an
   *  answer a price reads where a price group reads the username question. */
  canAnswer: boolean;
}>();
/** The update saved, with the application as the organizer now reads it. */
const emit = defineEmits<{
  confirmed: [application: Application];
  /** An update saved after its confirmation had gone: the application as saved. */
  refreshed: [application: Application];
}>();

const question = computed(() => props.market?.discord?.usernameQuestion ?? '');
const serverName = computed(() => props.market?.discord?.guildName || 'the Discord server');
/** The answer the check read, as the organizer reads it now. */
const answer = computed(() => {
  const value = props.application?.formData?.[question.value];
  return typeof value === 'string' ? value : '';
});
const theyWrote = computed(() => {
  const value = props.application ? theirAnswer(props.application, question.value) : '';
  return typeof value === 'string' ? value : '';
});

/** How many more members looked alike than the check kept, past its cap of five. */
const moreMatches = computed(() => props.vendor?.moreMatches ?? 0);
/** One member alike, or how many: several say the match is not one person's for certain. The
 *  count keeps to its noun, so a line never ends on the number alone. */
const alikeSentence = computed(() => {
  const alike = (props.vendor?.matches.length ?? 0) + moreMatches.value;
  return alike === 1
    ? 'A member whose name looks like it may be them.'
    : `${alike}\u00a0members whose names look like it may be them.`;
});

const confirming = ref<DiscordPossibleMatch | null>(null);
const submission = useDialogSubmit({
  opening: () => confirming.value,
  failure: 'The update could not be saved. Try again.',
});
const { sending } = submission;
const declining = ref(false);
const declineError = ref('');
/** Neither answer is offered while one is out. */
const answering = computed(() => sending.value || declining.value);

// Another vendor in the drawer: the confirmation was this one's, so it goes (at once, so no answer
// can land between the change and the close).
watch(
  () => props.application?.id,
  () => (confirming.value = null),
  { flush: 'sync' },
);

function confirm(match: DiscordPossibleMatch): void {
  confirming.value = match;
}

async function save(): Promise<void> {
  const match = confirming.value;
  const application = props.application;
  const marketId = props.market?.id;
  if (!match || !application || !marketId) return;
  await submission.submit(
    () => updateVendorInfo(marketId, application.id, { [question.value]: match.username }),
    {
      done: (saved) => {
        confirming.value = null;
        emit('confirmed', saved);
      },
      late: (answer) => {
        if (answer.ok) emit('refreshed', answer.answer);
      },
    },
  );
}

async function decline(match: DiscordPossibleMatch): Promise<void> {
  if (!props.application || !props.market?.id || answering.value) return;
  declining.value = true;
  declineError.value = '';
  try {
    await declineMatch(props.market.id, props.application.id, match.username);
  } catch (err) {
    declineError.value = getApiErrorMessage(err, 'That could not be saved. Try again.');
  } finally {
    declining.value = false;
  }
  // What was declined is the market's, so the market is read again (one market, from the server),
  // after a refusal too: another person may have answered the offer meanwhile.
  void useMarketStore().refresh();
}
</script>

<template>
  <div v-if="discordAsks(vendor)" class="discord-offer" data-testid="vendors-detail-discord">
    <p v-if="vendor?.shown === 'check_again'" class="discord-offer-lead">
      Their username was updated after the last check. Check Discord again to see whether they are
      in the server.
    </p>
    <template v-else>
      <p class="discord-offer-lead">
        No member of {{ serverName }} has the username “<AnswerValue :value="answer" />”.
        {{ alikeSentence }}
      </p>
      <ul class="discord-matches">
        <li
          v-for="match in vendor?.matches ?? []"
          :key="match.username"
          class="discord-match"
          data-testid="vendors-detail-discord-match"
        >
          <span class="discord-match-who"
            >Possible match: <strong>{{ matchNames(match).join(' · ') || match.username }}</strong>
            <span class="discord-match-username"> @{{ match.username }}</span></span
          >
          <span v-if="canAnswer" class="discord-match-actions">
            <button
              type="button"
              class="btn btn--secondary btn--compact"
              :disabled="answering"
              data-testid="vendors-detail-discord-confirm"
              @click="confirm(match)"
            >
              Confirm…<span class="visually-hidden"> @{{ match.username }}</span>
            </button>
            <button
              type="button"
              class="btn btn--secondary btn--compact"
              :disabled="answering"
              data-testid="vendors-detail-discord-decline"
              @click="decline(match)"
            >
              Not them<span class="visually-hidden">: @{{ match.username }}</span>
            </button>
          </span>
        </li>
      </ul>
      <p v-if="moreMatches" class="discord-offer-more" data-testid="vendors-detail-discord-more">
        And {{ moreMatches }} more not shown.
      </p>
      <p
        v-if="declineError"
        class="discord-offer-error"
        role="alert"
        data-testid="vendors-detail-discord-error"
      >
        {{ declineError }}
      </p>
    </template>

    <!-- To the body, so it is a sibling of the drawer and centred on the window, not on the drawer
         (dialogs: a dialog opened from inside a modal teleports). -->
    <Teleport to="body">
      <AppDialog
        :open="!!confirming"
        title="Use this Discord username?"
        testid="discord-match-confirm"
        :confirm-label="sending ? 'Saving…' : 'Save update'"
        :submission="submission"
        @close="confirming = null"
        @submit="save"
      >
        <p class="discord-offer-note">
          Their answer reads as this member’s username wherever it shows, so the next Check Discord
          finds them. What the vendor wrote is kept.
        </p>
        <dl class="discord-confirm-grid">
          <dt>They wrote</dt>
          <dd>
            <AnswerValue v-if="theyWrote" :value="theyWrote" />
            <template v-else>No answer</template>
          </dd>
          <template v-if="answer !== theyWrote">
            <dt>Reads now</dt>
            <dd><AnswerValue :value="answer" /></dd>
          </template>
          <dt>Update to</dt>
          <dd>
            <strong>{{ confirming?.username }}</strong>
            <span v-if="confirming && matchNames(confirming).length" class="discord-match-username">
              ({{ matchNames(confirming).join(' · ') }} in {{ serverName }})</span
            >
          </dd>
        </dl>
      </AppDialog>
    </Teleport>
  </div>
</template>

<style scoped>
.discord-offer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.discord-offer-lead,
.discord-offer-more,
.discord-offer-note {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
  overflow-wrap: anywhere;
}

.discord-matches {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* Who the member is, then the two answers, wrapping under the name on a narrow drawer. */
.discord-match {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  background: var(--mm-beige);
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.discord-match-who {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* Its leading space is in the span: the template drops the line break between it and the name. */
.discord-match-username {
  color: var(--mm-text-muted);
}

/* `--mm-text-muted` is under AA on the beige card; this is its ink for that ground (contrast.test.ts). */
.discord-match .discord-match-username {
  color: var(--mm-text-muted-on-beige);
}

.discord-match-actions {
  display: flex;
  gap: var(--space-2);
}

.discord-offer-error {
  margin: 0;
  color: var(--mm-red);
  font-size: var(--text-sm);
}

.discord-confirm-grid {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.discord-confirm-grid dt {
  font-family: 'Merge One', sans-serif;
  font-size: var(--text-xs);
  opacity: 0.75;
  padding-top: var(--space-hairline);
}

.discord-confirm-grid dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
