<script setup lang="ts" generic="Role extends string">
/**
 * "Invited": the invitations waiting on a market or an organization (T538, ADR 0047), as Manage
 * market and Manage organization list them, and the confirmation each row's Withdraw opens.
 *
 * Nobody in it has access until they accept, so it is a list of its own, after the people who have
 * it: a `ListFrame` of the invitations, each its address, "Invited as Editor, until 8 December,
 * 16:44", and Withdraw where `mayWithdraw` lets the reader withdraw it. Its read and its send are
 * `useInvitationsWaiting`'s, handed in as `waiting`; it draws nothing while none waits and the read
 * has not failed. Where it stands is its dialog's: Manage market draws it inside "Users with access",
 * Manage organization in a section of its own, which stays mounted while it is empty, so a
 * withdrawal that empties it still closes its confirmation.
 *
 * Withdraw asks first, in a confirmation teleported to the body, a sibling of the dialog it opens
 * from, as every dialog opened from a component inside a dialog is
 * (`docs/implementation/conventions/dialogs.md`). Its write is a `useDialogSubmit` handle keyed by
 * the invitation it was opened on, so an answer never lands in another opening.
 */
import { nextTick, ref, watch } from 'vue';
import type { Invitation, SentInvitation } from '@/assets/types/datatypes';
import AppDialog from '@/components/AppDialog.vue';
import EmailAddress from '@/components/EmailAddress.vue';
import ListFrame from '@/components/ListFrame.vue';
import ReadFailed from '@/components/ReadFailed.vue';
import { invitedAs } from '@/utils/invitations';
import { useDialogSubmit } from '@/utils/useDialogSubmit';
import { INVITATIONS_READ_FAILED, type InvitationsWaiting } from '@/utils/useInvitationsWaiting';

const props = defineProps<{
  waiting: InvitationsWaiting<Role>;
  /** How a row names its role: a market's capitalized, an organization's place in lower case. */
  kind: Invitation['kind'];
  /** Whether the reader may withdraw it: whoever may give its role or invite to its place. */
  mayWithdraw: (invitation: SentInvitation<Role>) => boolean;
  /** Whether the dialog it is listed in is open: the confirmation opens only over it. */
  open: boolean;
  /** The dialog's prefix: `<testid>-invited`, `-invited-row`, `-withdraw`, … */
  testid: string;
  /** Where focus goes once a withdrawal leaves no invitation, and so no list, to go to. */
  focusWhenNoneLeft?: HTMLElement | null;
}>();

const emit = defineEmits<{
  /** An invitation was withdrawn, or had already ended: the dialog's History reads it. */
  withdrawn: [];
}>();

// The handle's parts, each a ref the template unwraps; the handle is the dialog's for its life.
const { key, rows, failed, words, retry } = props.waiting;

const INVITATION = { one: 'invitation', many: 'invitations' };
const finds = (invitation: SentInvitation<Role>, typed: string) =>
  invitation.email.includes(typed.toLowerCase());
const keyOf = (invitation: SentInvitation<Role>) => invitation.id;

const list = ref<HTMLElement | null>(null);

/**
 * The invitation a Withdraw is asking about, until it is confirmed or cancelled, with the words its
 * confirmation says, taken when it opens, as Remove's are.
 */
const withdrawing = ref<{ id: string; email: string } | null>(null);
const withdrawal = useDialogSubmit({
  opening: () => (props.open ? withdrawing.value : null),
  failure: 'The invitation was not withdrawn.',
});
// Each opening, and each target the dialog is open on, starts with no confirmation asking.
watch([() => props.open, key], () => (withdrawing.value = null));

/** Withdraw asks first: a mistyped address must not be able to join, nor a typed one lose it by a slip. */
function ask(invitation: SentInvitation<Role>) {
  withdrawing.value = { id: invitation.id, email: invitation.email };
}

/** Cancel, Escape and the backdrop change nothing; the shell gives focus back to the row's Withdraw. */
function cancel() {
  withdrawing.value = null;
}

/**
 * Confirmed: the invitation is withdrawn and the invitations re-read, both inside the write, so the
 * confirmation holds until the list no longer shows it, its Withdraw unable to send again; a refusal
 * stays in the confirmation. The Withdraw that opened it is gone with its invitation, so focus goes
 * to the list, or, once none is left, where the dialog says, after the confirmation has closed and
 * the page behind it is no longer inert.
 */
async function withdraw() {
  const target = withdrawing.value;
  const on = key.value;
  if (!on || !target) return;
  await withdrawal.submit((isCurrent) => props.waiting.withdraw(on, target.id, isCurrent), {
    done: async () => {
      withdrawing.value = null;
      emit('withdrawn');
      await nextTick();
      (list.value ?? props.focusWhenNoneLeft)?.focus();
    },
  });
}
</script>

<template>
  <ReadFailed
    v-if="failed"
    :name="`${testid}-invited`"
    :message="INVITATIONS_READ_FAILED"
    @retry="retry"
  />
  <template v-if="rows.length">
    <h3
      :id="`${testid}-invited-heading`"
      class="invited-heading"
      :data-testid="`${testid}-invited-heading`"
    >
      Invited
    </h3>
    <div
      ref="list"
      class="invited-list"
      role="group"
      :aria-labelledby="`${testid}-invited-heading`"
      tabindex="-1"
      :data-testid="`${testid}-invited`"
    >
      <ListFrame
        v-model:words="words"
        :items="rows"
        :finds="finds"
        :itemKey="keyOf"
        :noun="INVITATION"
        findLabel="Find in invited"
        :testid="`${testid}-invited-list`"
      >
        <template #row="{ item: invitation }">
          <div class="invited-card" :data-testid="`${testid}-invited-row`">
            <!-- The address and its line stacked, so a long address keeps the card's width. -->
            <div class="invited-who">
              <span class="invited-email"><EmailAddress :words="invitation.email" /></span>
              <span class="invited-as" :data-testid="`${testid}-invited-as`">
                {{ invitedAs(kind, invitation) }}
              </span>
            </div>
            <button
              v-if="mayWithdraw(invitation)"
              type="button"
              class="btn btn--secondary btn--destructive"
              :data-testid="`${testid}-invited-withdraw`"
              @click="ask(invitation)"
            >
              Withdraw<span class="visually-hidden"> {{ invitation.email }}</span>
            </button>
          </div>
        </template>
      </ListFrame>
    </div>
  </template>

  <Teleport to="body">
    <!-- Destructive, as Remove's is, and opened on Cancel: the address it names can no longer join
         by it, and only a new invitation, a new email, undoes it. -->
    <AppDialog
      :open="open && !!withdrawing"
      :title="`Withdraw the invitation to ${withdrawing?.email ?? ''}?`"
      :testid="`${testid}-withdraw`"
      destructive
      confirm-label="Withdraw"
      :submission="withdrawal"
      @close="cancel"
      @submit="withdraw"
    >
      <p class="confirm-text" :data-testid="`${testid}-withdraw-consequence`">
        They can no longer accept it.
      </p>
    </AppDialog>
  </Teleport>
</template>

<style scoped>
/* As each section's heading of the dialog it stands in. */
.invited-heading {
  margin: 0 0 var(--space-3);
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--mm-black);
}

.invited-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

/* The frame's rows here are cards, each with its border, so they keep the room between them. */
.invited-list :deep(.list-frame__rows) {
  gap: var(--space-2);
}

/* A row as the people's rows above it are drawn: a card on the dialog's beige. */
.invited-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
  background: var(--mm-beige);
}

/* An invitation's address over its role and when it ends, beside its Withdraw, with the address's
   floor; on a phone it takes the card's width, with Withdraw beneath, as a person's row does. */
.invited-who {
  flex: 1;
  min-width: min(100%, 12rem);
  display: flex;
  flex-direction: column;
  gap: var(--space-hairline);
}

/* In the stack, the address takes its line's width and no more: its floor and its phone basis are
   the stack's. */
.invited-email {
  flex: none;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
  overflow-wrap: anywhere;
}

@media (width <= 640px) {
  .invited-who {
    flex-basis: 100%;
  }
}

/* An invitation's role and when it ends, in the muted ink that reaches AA on the card's beige. */
.invited-as {
  font-size: var(--text-xs);
  color: var(--mm-text-muted-on-beige);
}

.confirm-text {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
}
</style>
