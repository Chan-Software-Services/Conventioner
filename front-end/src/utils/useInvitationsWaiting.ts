/**
 * The invitations waiting on a market or an organization, as the people who sent them read them
 * (T538, ADR 0047): Manage market's and Manage organization's "Invited", read and withdrawn by the
 * same rules, drawn by `InvitationsWaiting.vue`, which holds the confirmation and its handle.
 *
 * The read is keyed (`useServerRead`) by what the dialog is open on, so an answer for the one it
 * was open on never lands in another opening; a key of `null` reads nothing, for a reader the
 * server would not show them to.
 */
import { computed, ref } from 'vue';
import type { SentInvitation } from '@/assets/types/datatypes';
import { getApiErrorStatus } from '@/utils/api';
import { useServerRead } from '@/utils/useServerRead';

export interface InvitationsWaitingOptions<Role extends string> {
  /** What they are read on, or `null` for no read: the dialog closed, or a reader who may not see them. */
  key: () => string | null;
  fetch: (key: string) => Promise<SentInvitation<Role>[]>;
  withdraw: (key: string, id: string) => Promise<void>;
}

/** Said in the section's place when the read failed, with "Try again". */
export const INVITATIONS_READ_FAILED = 'Could not read the invitations.';

export function useInvitationsWaiting<Role extends string>(
  options: InvitationsWaitingOptions<Role>,
) {
  const read = useServerRead<string, SentInvitation<Role>[]>(options.key, options.fetch, {
    failure: INVITATIONS_READ_FAILED,
  });
  const rows = computed(() => read.data.value ?? []);
  const failed = computed(
    () => read.phase.value === 'failed' || read.phase.value === 'refresh_failed',
  );
  /** What finds in "Invited", for as long as the dialog is open. */
  const words = ref('');

  /**
   * Reads the invitations again after a write sent in this opening, an invitation or a withdrawal:
   * once the dialog has moved on, nothing is read.
   */
  async function reread(isCurrent: () => boolean) {
    if (isCurrent()) await read.reread();
  }

  /** "Try again" after a failed read. */
  function retry() {
    void read.reread();
  }

  /** A new opening of the dialog: nothing finding in the list. */
  function reset() {
    words.value = '';
  }

  /**
   * Withdraws the invitation `id` on `key`, then reads the invitations again, inside the write that
   * `isCurrent` belongs to. A 404 is an invitation already accepted, declined, ended or withdrawn:
   * nobody can accept it any more, which is what was asked, so it is done. A 409 is one sent again
   * meanwhile, to another role or place: it is thrown for the confirmation to say, with the list
   * behind it read again, so what was sent again is in sight before it is withdrawn.
   */
  async function withdraw(key: string, id: string, isCurrent: () => boolean) {
    try {
      await options.withdraw(key, id);
    } catch (err) {
      if (getApiErrorStatus(err) !== 404) {
        if (getApiErrorStatus(err) === 409) await reread(isCurrent);
        throw err;
      }
    }
    await reread(isCurrent);
  }

  return { key: read.key, rows, failed, words, reread, retry, reset, withdraw };
}

export type InvitationsWaiting<Role extends string> = ReturnType<
  typeof useInvitationsWaiting<Role>
>;
