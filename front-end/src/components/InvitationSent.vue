<script setup lang="ts">
/**
 * What an invite row says of the invitation it last sent (T538, ADR 0047), under Manage market's
 * "Invite someone" and Manage organization's "Invite admin" and "Invite member": "Invitation sent to
 * <address>." in the success ink, or, when the invitation was made but its email could not be sent,
 * a line saying so in the warning ink, since something was not done.
 *
 * Its region is always drawn, so a screen reader hears each line as it lands in it; while it says
 * nothing it takes back the form's gap above it.
 */
import EmailAddress from '@/components/EmailAddress.vue';
import { notEmailedLine, sentLine, type InviteSaid } from '@/utils/invitations';

defineProps<{
  /** The invitation the row last sent, or `null` before one or once the row closed. */
  sent: InviteSaid | null;
  /** The row's prefix: `<testid>-said`, `-sent`, `-not-emailed`. */
  testid: string;
}>();
</script>

<template>
  <div class="invite-said" aria-live="polite" :data-testid="`${testid}-said`">
    <p v-if="sent?.emailed" class="invite-sent" :data-testid="`${testid}-sent`">
      <EmailAddress :words="sentLine(sent.address)" />
    </p>
    <p v-else-if="sent" class="invite-not-emailed" :data-testid="`${testid}-not-emailed`">
      <EmailAddress :words="notEmailedLine(sent.address)" />
    </p>
  </div>
</template>

<style scoped>
/* Drawn while it says nothing: it then takes no gap of the form it stands in. */
.invite-said:empty {
  margin-top: calc(-1 * var(--space-2));
}

.invite-sent,
.invite-not-emailed {
  margin: 0;
  font-size: var(--text-xs);
}

.invite-sent {
  color: var(--mm-text-green);
}

/* A warning, never a success: the yellow ink that reaches AA on the dialog's white (4.52:1). */
.invite-not-emailed {
  color: var(--mm-text-yellow);
}
</style>
