<script setup lang="ts">
/**
 * Sign out everywhere (T311), opened from the account menu and the phone's sheet: it asks first,
 * since one stray press would sign out the laptop at the door mid-market, then ends every sign-in
 * of the account on the server, this browser's with it (`signOutEverywhere`).
 *
 * Destructive, so it opens on Cancel. Nothing closes it while the request is in flight, so a failure
 * is read here: the person is still signed in, and so is every other device. Done, or answered 401
 * (a session already over, which ends as any request's 401 does), it closes, and the page moves to
 * sign in.
 */
import { useRouter } from 'vue-router';
import AppDialog from '@/components/AppDialog.vue';
import { signOutEverywhere } from '@/utils/sessionEnded';
import { useDialogSubmit } from '@/utils/useDialogSubmit';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const FAILED = 'Could not sign out everywhere. Try again.';

const router = useRouter();
const submission = useDialogSubmit({ opening: () => props.open, failure: FAILED });
const { sending } = submission;

/** `signOutEverywhere` answers rather than throws: a failure is this dialog's refusal. */
async function confirm() {
  await submission.submit(
    async () => {
      if ((await signOutEverywhere(router)) === 'failed') throw new Error(FAILED);
    },
    { done: () => emit('close'), refused: () => FAILED },
  );
}
</script>

<template>
  <AppDialog
    :open="open"
    title="Sign out everywhere?"
    testid="sign-out-everywhere"
    destructive
    :confirm-label="sending ? 'Signing out…' : 'Sign out everywhere'"
    :submission="submission"
    @close="emit('close')"
    @submit="confirm"
  >
    <p class="sign-out-everywhere-text">
      This signs out every device and browser, including this one.
    </p>
  </AppDialog>
</template>

<style scoped>
.sign-out-everywhere-text {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
  /* At a desk the sentence fits one line. On a phone, balance splits it into two even lines rather
     than leaving a short last one. */
  text-wrap: balance;
}
</style>
