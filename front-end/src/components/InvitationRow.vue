<script setup lang="ts">
/**
 * One invitation on the Invitations page (T538, ADR 0047), answered in place: Accept and Decline,
 * held while either is out, then what came of it, where the buttons were.
 *
 * The row keeps its place once answered, until the page is left or read again, and the focus moves
 * to what it says, since the button pressed is gone. An invitation that has ended, or that they
 * are already in, says the server's words and has nothing left to press; any other refusal (a
 * server fault, no connection) is said under the buttons, which stay to answer again.
 *
 * The Invitations page's alone, not a reusable component.
 */
import { computed, nextTick, ref } from 'vue';
import type { Invitation } from '@/assets/types/datatypes';
import { getApiErrorMessage, getApiErrorStatus } from '@/utils/api';
import EmailAddress from '@/components/EmailAddress.vue';
import {
  acceptInvitation,
  acceptedLink,
  acceptedSentence,
  declineInvitation,
  declinedSentence,
  endsOn,
  invitationSentence,
  type Accepted,
} from '@/utils/invitations';
import { useSubmit } from '@/utils/useSubmit';

const props = defineProps<{ invitation: Invitation }>();

type Outcome =
  | { kind: 'accepted'; accepted: Accepted }
  | { kind: 'declined' }
  | { kind: 'ended'; sentence: string };

const answer = useSubmit({ failure: 'Your answer was not sent.' });
const outcome = ref<Outcome | null>(null);
const outcomeLine = ref<HTMLElement>();

/** An answer that ends the invitation: it has ended, or they are already in what it offers. */
function endsIt(error: unknown): boolean {
  const status = getApiErrorStatus(error);
  return status === 404 || status === 400;
}

async function settle(next: Outcome) {
  outcome.value = next;
  await nextTick();
  outcomeLine.value?.focus();
}

function send(write: () => Promise<Outcome>) {
  void answer.submit(write, {
    done: settle,
    refused: (error) => {
      if (!endsIt(error)) return;
      const sentence = getApiErrorMessage(error, 'This invitation has ended.');
      void settle({ kind: 'ended', sentence });
      return sentence;
    },
  });
}

function accept() {
  send(async () => ({ kind: 'accepted', accepted: await acceptInvitation(props.invitation.id) }));
}

function decline() {
  send(async () => {
    await declineInvitation(props.invitation.id);
    return { kind: 'declined' };
  });
}

const outcomeWords = computed(() => {
  const now = outcome.value;
  if (!now) return '';
  if (now.kind === 'accepted') return acceptedSentence(now.accepted);
  if (now.kind === 'declined') return declinedSentence(props.invitation);
  return now.sentence;
});
const link = computed(() =>
  outcome.value?.kind === 'accepted' ? acceptedLink(outcome.value.accepted) : null,
);
</script>

<template>
  <li class="invitation-row" data-testid="invitation-row">
    <p class="invitation-sentence" data-testid="invitation-sentence">
      <EmailAddress :words="invitationSentence(invitation)" />
    </p>
    <p class="invitation-until" data-testid="invitation-until">Until {{ endsOn(invitation) }}.</p>
    <template v-if="outcome">
      <p
        ref="outcomeLine"
        class="invitation-outcome"
        :class="{ 'invitation-outcome--ended': outcome.kind === 'ended' }"
        tabindex="-1"
        data-testid="invitation-outcome"
      >
        {{ outcomeWords }}
      </p>
      <RouterLink
        v-if="link"
        :to="link.to"
        class="link-alone invitation-open"
        data-testid="invitation-open"
      >
        {{ link.words }}
      </RouterLink>
    </template>
    <template v-else>
      <div class="invitation-actions">
        <button
          type="button"
          class="btn btn--primary"
          :disabled="answer.sending.value"
          data-testid="invitation-accept"
          @click="accept"
        >
          Accept
        </button>
        <button
          type="button"
          class="btn btn--secondary"
          :disabled="answer.sending.value"
          data-testid="invitation-decline"
          @click="decline"
        >
          Decline
        </button>
      </div>
      <p
        v-if="answer.sentence.value"
        class="invitation-refused"
        role="alert"
        data-testid="invitation-refused"
      >
        {{ answer.sentence.value }}
      </p>
    </template>
  </li>
</template>

<style scoped>
.invitation-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-6);
  border: 1.5px solid var(--mm-border);
  border-radius: var(--radius-card);
  background: white;
  box-shadow: var(--shadow-card);
}

@media (width <= 640px) {
  .invitation-row {
    padding: var(--space-4);
  }
}

.invitation-row p {
  margin: 0;
}

.invitation-sentence {
  font-size: var(--text-md);
  color: var(--mm-black);
}

.invitation-until {
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

.invitation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.invitation-outcome {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--mm-black);
}

/* An ended invitation reads as a refusal does, in the Vendors row's red. */
.invitation-outcome--ended,
.invitation-refused {
  color: var(--mm-red);
  font-weight: 400;
}

.invitation-refused {
  font-size: var(--text-sm);
}
</style>
