<script setup lang="ts">
/**
 * Manage organization: the dialog that used to vanish on you (E20/F01/S02).
 *
 * Adding an admin, adding a member and removing a user each succeeded and then emitted
 * `manageClose` - and the PARENT treated close as its refresh signal, so closing was the only
 * thing that re-read the data. Adding two people meant reopening the dialog between them.
 *
 * Closing never means saved, and saving never closes. That needs the two halves separated: this
 * dialog refreshes its own view of the organization, and the list behind it learns about the
 * change through `changed`, an event of its own. `handleRename` in this same file already worked
 * this way and was the model.
 *
 * It refreshes through the user's own organization LIST rather than `GET /organizations/<id>`:
 * the list endpoint is scoped to what the caller belongs to and returns the enriched shape this
 * dialog renders (each admin and member with their id and address, and the caller's role), which
 * the single-organization read does not.
 *
 * Three closes are correct and stay: deleting the organization, the explicit close control, and
 * dismissal by Escape or the backdrop - the last two now owned by `AppDialog`.
 *
 * Its owner makes an admin a member, or a member an admin, from their row (T283), each asking
 * first, as Remove does.
 *
 * A member opens it too, to read the organization's History (E40/F02/S01) and the default
 * permissions its new markets copy (E39/F02/S01); the people and the controls an owner or an admin
 * manages are theirs alone.
 *
 * An owner invites an admin or a member, and an admin a member (T538, ADR 0047): "Invite admin" and
 * "Invite member" send an invitation, answered alike for every address, and the person joins Admins
 * or Members only once they accept it. The invitations waiting are listed under "Invited", for the
 * owner and the admins, with Withdraw where the reader may invite to that place; a member makes no
 * read of them. They are a keyed read of their own (`useServerRead`), keyed by the organization
 * Manage organization is open on.
 *
 * Each write belongs to the opening it was sent from (T411): its handle (`useDialogSubmit`) is keyed
 * by the organization Manage organization is open on, or by what its confirmation was opened with,
 * and handed to the dialog that sent it, so the shell holds that dialog while it writes and a second
 * press sends nothing. An answer that lands after Manage organization was closed, or opened on
 * another organization, leaves the dialog the person is in alone, and so does a re-read of the
 * organization it had been open on; the list behind is still told of a change that landed.
 */
import { nextTick, ref, watch, type Ref } from 'vue';
import {
  type Organization,
  type OrganizationPerson,
  type OrganizationRoleType,
  type PermissionTableRow,
  type SentInvitation,
} from '@/assets/types/datatypes';
import { api, getApiErrorMessage, getApiErrorStatus, isOrganizationChanged } from '@/utils/api';
import {
  fetchOrganizations,
  organizationPlaceChange,
  organizationRemoval,
  type OrganizationPlace,
} from '@/utils/organizations';
import {
  fetchOrganizationInvitations,
  inviteToOrganization,
  saidOf,
  withdrawOrganizationInvitation,
  type InviteSaid,
} from '@/utils/invitations';
import { useInvitationsWaiting } from '@/utils/useInvitationsWaiting';
import { useDialogSubmit } from '@/utils/useDialogSubmit';
import type { LateAnswer } from '@/utils/useSubmit';
import AppDialog from '@/components/AppDialog.vue';
import DeleteOrgDialog from '@/components/DeleteOrgDialog.vue';
import EmailAddress from '@/components/EmailAddress.vue';
import HistorySection from '@/components/HistorySection.vue';
import InvitationSent from '@/components/InvitationSent.vue';
import InvitationsWaiting from '@/components/InvitationsWaiting.vue';
import ListFrame from '@/components/ListFrame.vue';
import OrganizationHistory from '@/components/OrganizationHistory.vue';
import OrganizationPermissions from '@/components/OrganizationPermissions.vue';

const props = defineProps<{
  manageOpen: boolean;
  org: Organization | null;
}>();

const emit = defineEmits<{
  manageClose: [];
  /** Something about this organization changed. Distinct from close, which means only closed. */
  changed: [];
}>();

const orgData = ref<Organization | null>(null);
const errorMessage = ref('');
const renameValue = ref('');
const showAddAdminForm = ref(false);
const showAddMemberForm = ref(false);
const newAdminEmail = ref('');
const newMemberEmail = ref('');
const addAdminErrorLine = ref<HTMLElement | null>(null);
const addMemberErrorLine = ref<HTMLElement | null>(null);
/** What each invite row says of the invitation it last sent, until the next is sent or the row closes. */
const adminInviteSent = ref<InviteSaid | null>(null);
const memberInviteSent = ref<InviteSaid | null>(null);
const deleteConfirming = ref(false);
/** Counts the changes this dialog has made, so its History reads them as they land. */
const changesMade = ref(0);
/**
 * The person a Remove is asking about, until it is confirmed or cancelled (E38/F15/S01), and the
 * words the confirmation says, taken when it opens: the re-read after a confirm counts the
 * organization without them, and the closing confirmation must not say that.
 */
const removing = ref<{
  userId: string;
  place: 'admins' | 'members';
  title: string;
  loses: string;
} | null>(null);
/**
 * The person a "Make member" or "Make admin" is asking about (T283), until it is confirmed or
 * cancelled, with the words taken when it opens, as Remove's are.
 */
const placing = ref<{
  userId: string;
  from: OrganizationPlace;
  to: OrganizationPlace;
  title: string;
  text: string;
  confirmLabel: string;
} | null>(null);
const adminsList = ref<HTMLElement | null>(null);
const membersList = ref<HTMLElement | null>(null);
/** What finds in Admins and in Members, for as long as the dialog is open: never in the address. */
const adminWords = ref('');
const memberWords = ref('');

const ADMIN = { one: 'admin', many: 'admins' };
const MEMBER = { one: 'member', many: 'members' };
const findsPerson = (person: OrganizationPerson, words: string) =>
  person.email.toLowerCase().includes(words.toLowerCase());
const keyOfPerson = (person: OrganizationPerson) => person.userId;

/** The organization Manage organization is open on, or nothing while it is closed. */
const openOn = () => (props.manageOpen ? (props.org?.id ?? null) : null);
/** What a confirmation over Manage organization is open on: nothing once it closes. */
const over =
  <T,>(asked: () => T) =>
  () =>
    props.manageOpen ? asked() : null;

/**
 * Invite admin's, Invite member's and Rename's writes, each said beside its row; Manage
 * organization holds while any one sends.
 */
const addAdmin = useDialogSubmit({
  opening: openOn,
  failure: 'The invitation was not sent.',
  says: 'self',
});
const addMember = useDialogSubmit({
  opening: openOn,
  failure: 'The invitation was not sent.',
  says: 'self',
});
const rename = useDialogSubmit({
  opening: openOn,
  failure: 'The name was not changed.',
  says: 'self',
});
const { sentence: addAdminSentence } = addAdmin;
const { sentence: addMemberSentence } = addMember;
const { sentence: renameSentence } = rename;
/** Each confirmation's write, keyed by what it was opened on; the shell says its refusal. */
const removal = useDialogSubmit({
  opening: over(() => removing.value),
  failure: 'The person was not removed.',
});
const placeChange = useDialogSubmit({
  opening: over(() => placing.value),
  failure: 'Their place was not changed.',
});
/**
 * The invitations waiting on the organization, read for its owner and its admins, as the server
 * serves them only to them; keyed by the organization Manage organization is open on, so an answer
 * for the one it was open on never lands in another opening. A member makes no read.
 */
const invitations = useInvitationsWaiting({
  key: () => (props.manageOpen && canManage() ? (orgData.value?.id ?? null) : null),
  fetch: fetchOrganizationInvitations,
  withdraw: withdrawOrganizationInvitation,
  ended: (isCurrent) => refreshOrg('Could not re-read the organization', isCurrent),
});
watch(
  () => [props.manageOpen, props.org] as const,
  ([open, org]) => {
    if (open && org) {
      orgData.value = org;
      renameValue.value = org.name;
      showAddAdminForm.value = false;
      showAddMemberForm.value = false;
      adminInviteSent.value = null;
      memberInviteSent.value = null;
      deleteConfirming.value = false;
      removing.value = null;
      placing.value = null;
      invitations.reset();
      adminWords.value = '';
      memberWords.value = '';
      errorMessage.value = '';
    } else {
      orgData.value = null;
    }
  },
  { immediate: true },
);

function canManage(): boolean {
  const role = orgData.value?.userRole;
  return role === 'owner' || role === 'admin';
}

function isOwner(): boolean {
  return orgData.value?.userRole === 'owner';
}

/**
 * Whoever may invite to an invitation's place may withdraw it, as the server asks: the owner every
 * one, an admin a member's.
 */
const mayWithdraw = (invitation: SentInvitation<OrganizationPlace>) =>
  isOwner() || invitation.role === 'member';

/**
 * Re-read this organization so the dialog shows what it just did.
 *
 * A membership change answers with a message and no document, so there is nothing to merge; and
 * guessing the new membership locally would be a second copy of the server's rules about who may
 * hold which role.
 *
 * Run inside a write, with its submission's `isCurrent`: once the opening the write was sent from
 * has gone (Manage organization closed, or opened on another organization), nothing is read, and a
 * read that lands after it writes nothing.
 */
async function refreshOrg(failed: string, isCurrent: () => boolean): Promise<void> {
  const id = orgData.value?.id;
  if (!id || !isCurrent()) return;
  try {
    const mine = await fetchOrganizations();
    if (!isCurrent()) return;
    const found = mine.find((candidate) => candidate.id === id);
    if (found) orgData.value = found;
  } catch (err) {
    if (!isCurrent()) return;
    errorMessage.value = getApiErrorMessage(err, failed);
  }
}

/** Saved, inside the write: the organization read again, so the hold lasts until it shows. */
const readAfterSaving = (isCurrent: () => boolean) =>
  refreshOrg('Saved, but could not re-read the organization', isCurrent);

/**
 * A change landed: its History reads it while the opening it was sent from lasts (`current`), and
 * the list behind is told either way. Neither of those is closing.
 */
function changeLanded(current: boolean): void {
  if (current) changesMade.value++;
  emit('changed');
}

/** A write that landed after Manage organization moved on: the list behind still reads it. */
function lateAnswer(answer: LateAnswer<unknown>): void {
  if (answer.ok) emit('changed');
}

/**
 * A change that met someone else's change to the same people (the server's 409
 * `organization_changed`) stored nothing, and its sentence asks the person to check the people as
 * they are now: so the organization is read again behind the sentence, as after a save, and the
 * list behind and the History read the change that did land. Inside the write, before its refusal
 * is said.
 */
async function readAgainIfChanged(err: unknown, isCurrent: () => boolean): Promise<void> {
  if (!isOrganizationChanged(err)) return;
  await refreshOrg('Could not re-read the organization', isCurrent);
  changeLanded(isCurrent());
}

/**
 * "Invite admin" and "Invite member" open the row they invite from, and the row carries its own
 * Cancel, as Manage market's "Invite someone" does: the opening button used to turn into a Cancel of
 * its own, left above the row it cancelled (bug 43, fixed there first).
 */
const addAdminButton = ref<HTMLButtonElement | null>(null);
const addAdminInput = ref<HTMLInputElement | null>(null);
const addMemberButton = ref<HTMLButtonElement | null>(null);
const addMemberInput = ref<HTMLInputElement | null>(null);

/**
 * Opening a row takes away the button that opened it, and closing one its Cancel, so focus goes
 * where the person is next: the field, and then the button again. Left alone it fell to `<body>`.
 */
async function openAddAdmin() {
  // A refusal that landed after the row was cancelled is not this row's.
  addAdmin.edit();
  showAddAdminForm.value = true;
  await nextTick();
  addAdminInput.value?.focus();
}

/**
 * Cancelling clears what was typed and any error: reopening should not hand back a rejected
 * address as though it were still being considered.
 */
async function closeAddAdmin() {
  showAddAdminForm.value = false;
  newAdminEmail.value = '';
  adminInviteSent.value = null;
  addAdmin.edit();
  await nextTick();
  addAdminButton.value?.focus();
}

async function openAddMember() {
  addMember.edit();
  showAddMemberForm.value = true;
  await nextTick();
  addMemberInput.value?.focus();
}

/** As `closeAddAdmin`, for the member row. */
async function closeAddMember() {
  showAddMemberForm.value = false;
  newMemberEmail.value = '';
  memberInviteSent.value = null;
  addMember.edit();
  await nextTick();
  addMemberButton.value?.focus();
}

/** The default table a change answered, shown at once; its History reads the change. */
function defaultsChanged(table: PermissionTableRow[]) {
  if (orgData.value) orgData.value = { ...orgData.value, defaultPermissionTable: table };
  changesMade.value++;
  emit('changed');
}

/**
 * The name is written inside the write, and shown here once it lands. A refusal is said under the
 * field.
 */
async function handleRename() {
  const org = orgData.value;
  const name = renameValue.value.trim();
  if (!org || name === org.name) return;
  await rename.submit(() => api.put(`/organizations/${encodeURIComponent(org.id)}`, { name }), {
    done: () => {
      if (orgData.value) orgData.value = { ...orgData.value, name };
      changeLanded(true);
    },
    late: lateAnswer,
  });
}

/** A refusal stands under its form, which a short window's body can hold at its very foot. */
function showsRefusal(sentence: Ref<string>, line: Ref<HTMLElement | null>) {
  watch(
    sentence,
    (said) => {
      if (said) line.value?.scrollIntoView?.({ block: 'nearest' });
    },
    { flush: 'post' },
  );
}
showsRefusal(addAdminSentence, addAdminErrorLine);
showsRefusal(addMemberSentence, addMemberErrorLine);

/**
 * Invites someone to `place` and reads the invitations again, both inside the write, so a second
 * press sends nothing until "Invited" lists them. The answer is the same for every address, and
 * nobody is under Admins or Members until they accept. The form stays open with an empty field:
 * inviting two people in a row is the case this story is named after. A refusal is said under the
 * form in the server's words, the typed address kept exactly where it was.
 */
async function invite(place: OrganizationPlace) {
  const inviting = place === 'admin' ? addAdmin : addMember;
  const field = place === 'admin' ? newAdminEmail : newMemberEmail;
  const said = place === 'admin' ? adminInviteSent : memberInviteSent;
  const email = field.value.trim();
  const org = orgData.value;
  if (!org || !email) return;
  said.value = null;
  await inviting.submit(
    async (isCurrent) => {
      const sent = await inviteToOrganization(org.id, email, place);
      await invitations.reread(isCurrent);
      return saidOf(sent, email);
    },
    {
      done: (sent) => {
        field.value = '';
        said.value = sent;
        // The invitation is in the organization's History.
        changesMade.value++;
      },
    },
  );
}

const handleAddAdmin = () => invite('admin');
const handleAddMember = () => invite('member');

/**
 * Remove asks first (E38/F15/S01): it took someone's access to every market of the organization in
 * one click, from a filled red button on every row.
 */
function askToRemove(userId: string, email: string, place: 'admins' | 'members') {
  if (!orgData.value) return;
  removing.value = { userId, place, ...organizationRemoval(orgData.value, userId, email) };
}

/** Cancel, Escape and the backdrop change nothing; the shell gives focus back to the row's Remove. */
function cancelRemove() {
  removing.value = null;
}

/**
 * Confirmed: removed, and the list re-read in place with Manage organization still open. The row,
 * and with it the Remove that opened the confirmation, is gone, so focus goes to the list it was in.
 * A 404 is someone another admin removed first: what was asked for is true, so it is read as done.
 * Any other refusal stays in the confirmation, which said what was about to happen; one that met
 * another change to the same people is read again behind it.
 */
async function handleRemoveUser() {
  const target = removing.value;
  const org = orgData.value;
  if (!org || !target) return;
  await removal.submit(
    async (isCurrent) => {
      try {
        await api.delete(
          `/organizations/${encodeURIComponent(org.id)}/users/${encodeURIComponent(target.userId)}`,
        );
      } catch (err) {
        if (getApiErrorStatus(err) !== 404) {
          await readAgainIfChanged(err, isCurrent);
          throw err;
        }
      }
      // Held until the confirmation closes: during the re-read its Remove would send a second
      // removal.
      await readAfterSaving(isCurrent);
    },
    {
      done: async () => {
        changeLanded(true);
        removing.value = null;
        // Once the confirmation has closed and the page behind it is no longer inert.
        await nextTick();
        (target.place === 'admins' ? adminsList : membersList).value?.focus();
      },
      late: lateAnswer,
    },
  );
}

/**
 * "Make member" and "Make admin" ask first (T283): each changes what the person may do on every
 * market of the organization, so one slip must not do it.
 */
function askToChangePlace(userId: string, email: string, from: OrganizationPlace) {
  if (!orgData.value) return;
  const to: OrganizationPlace = from === 'admin' ? 'member' : 'admin';
  placing.value = { userId, from, to, ...organizationPlaceChange(orgData.value, email, to) };
}

/** Cancel, Escape and the backdrop change nothing; the shell gives focus back to the row's button. */
function cancelPlaceChange() {
  placing.value = null;
}

/**
 * Confirmed: the place changed, and the organization re-read in place. The row, and with it the
 * button that opened the confirmation, has moved to the other list, so focus goes to that list. A
 * 404 is someone removed meanwhile, read as done as Remove reads it, with focus on the list their
 * row left. Any other refusal stays in the confirmation; one that met another change to the same
 * people is read again behind it.
 */
async function handlePlaceChange() {
  const target = placing.value;
  const org = orgData.value;
  if (!org || !target) return;
  await placeChange.submit(
    async (isCurrent): Promise<OrganizationPlace> => {
      let landedIn: OrganizationPlace = target.to;
      try {
        await api.put(
          `/organizations/${encodeURIComponent(org.id)}/users/${encodeURIComponent(target.userId)}`,
          { place: target.to },
        );
      } catch (err) {
        if (getApiErrorStatus(err) !== 404) {
          await readAgainIfChanged(err, isCurrent);
          throw err;
        }
        landedIn = target.from;
      }
      // Held until the confirmation closes: during the re-read its confirm would send a second
      // change.
      await readAfterSaving(isCurrent);
      return landedIn;
    },
    {
      done: async (landedIn) => {
        changeLanded(true);
        placing.value = null;
        // Once the confirmation has closed and the page behind it is no longer inert.
        await nextTick();
        (landedIn === 'admin' ? adminsList : membersList).value?.focus();
      },
      late: lateAnswer,
    },
  );
}

function canRemoveUser(userId: string, role: OrganizationRoleType): boolean {
  if (role === 'owner') return false;
  if (!isOwner()) return role === 'member';
  return true;
}

/**
 * One of the three correct closes: the thing being managed no longer exists.
 *
 * The confirmation is its own dialog now (E20/F04/S01), because what it has to say is not a
 * sentence: deleting an organization destroys its drafts and archived markets, and an archived
 * market is still publicly served and holds the record of a market that ran. "Are you sure? This
 * cannot be undone." was true and useless.
 */
function handleDeleted() {
  emit('changed');
  emit('manageClose');
}
</script>

<template>
  <AppDialog
    :open="manageOpen"
    title="Manage organization"
    testid="manage-org"
    size="wide"
    scroll="body"
    :error="errorMessage"
    :submission="[addAdmin, addMember, rename]"
    @close="emit('manageClose')"
  >
    <template v-if="orgData">
      <p class="org-name">{{ orgData.name }}</p>

      <div class="content">
        <section class="section">
          <h3>Owner</h3>
          <div class="user-card">
            <span class="user-email"
              ><EmailAddress :words="orgData.ownerEmail || 'Unknown'"
            /></span>
            <span class="role-badge role-owner">Owner</span>
          </div>
        </section>

        <section v-if="canManage()" class="section">
          <h3 id="manage-org-admins-heading">Admins</h3>
          <div
            ref="adminsList"
            class="users-list"
            role="group"
            aria-labelledby="manage-org-admins-heading"
            tabindex="-1"
            data-testid="manage-org-admins"
          >
            <ListFrame
              v-model:words="adminWords"
              :items="orgData.adminPeople"
              :finds="findsPerson"
              :itemKey="keyOfPerson"
              :noun="ADMIN"
              findLabel="Find in admins"
              testid="manage-org-admin-list"
            >
              <template #row="{ item: admin }">
                <div class="user-card">
                  <span class="user-email" data-testid="manage-org-admin-email"
                    ><EmailAddress :words="admin.email"
                  /></span>
                  <span class="role-badge role-admin">Admin</span>
                  <!-- Never what the dialog opens on: one stray Enter would ask to change the first
                       admin's place. -->
                  <button
                    v-if="isOwner()"
                    type="button"
                    class="btn btn--secondary"
                    data-testid="manage-org-make-member-button"
                    data-dialog-not-first
                    @click="askToChangePlace(admin.userId, admin.email, 'admin')"
                  >
                    Make member<span class="visually-hidden"> {{ admin.email }}</span>
                  </button>
                  <button
                    v-if="isOwner() && canRemoveUser(admin.userId, 'admin')"
                    type="button"
                    class="btn btn--secondary btn--destructive"
                    data-testid="manage-org-remove-user-button"
                    @click="askToRemove(admin.userId, admin.email, 'admins')"
                  >
                    Remove<span class="visually-hidden"> {{ admin.email }}</span>
                  </button>
                </div>
              </template>
              <template #empty>
                <p v-show="!showAddAdminForm">No admins</p>
              </template>
            </ListFrame>
          </div>
          <!-- Opens the row it invites from, which carries its own Cancel, as Manage market's
               "Invite someone". -->
          <button
            v-if="isOwner() && !showAddAdminForm"
            type="button"
            class="btn btn--secondary"
            ref="addAdminButton"
            data-testid="manage-org-add-admin-button"
            @click="openAddAdmin"
          >
            Invite admin
          </button>
          <!-- Its own form, so Enter in the field sends the invitation through the very same handler. -->
          <form v-if="showAddAdminForm" class="add-user-form" @submit.prevent="handleAddAdmin">
            <div class="add-org-row">
              <input
                ref="addAdminInput"
                id="manage-org-add-admin-email"
                v-model="newAdminEmail"
                name="admin-email"
                type="email"
                autocomplete="off"
                placeholder="Email address"
                aria-label="Email of the admin to invite"
                class="field"
                data-testid="manage-org-add-admin-input"
              />
              <button
                type="submit"
                class="btn btn--primary"
                :disabled="!newAdminEmail.trim()"
                data-testid="manage-org-add-admin-submit"
              >
                Send invitation
              </button>
              <button
                type="button"
                class="btn btn--secondary"
                data-testid="manage-org-add-admin-cancel"
                @click="closeAddAdmin"
              >
                Cancel
              </button>
            </div>
            <p class="form-hint" data-testid="manage-org-add-admin-hint">
              They get an email, and join once they accept it signed in with this address.
            </p>
            <p
              v-if="addAdminSentence"
              ref="addAdminErrorLine"
              class="form-error"
              data-testid="manage-org-add-admin-error"
            >
              {{ addAdminSentence }}
            </p>
            <InvitationSent :sent="adminInviteSent" testid="manage-org-add-admin" />
          </form>
        </section>

        <section v-if="canManage()" class="section">
          <h3 id="manage-org-members-heading">Members</h3>
          <div
            ref="membersList"
            class="users-list"
            role="group"
            aria-labelledby="manage-org-members-heading"
            tabindex="-1"
            data-testid="manage-org-members"
          >
            <ListFrame
              v-model:words="memberWords"
              :items="orgData.memberPeople"
              :finds="findsPerson"
              :itemKey="keyOfPerson"
              :noun="MEMBER"
              findLabel="Find in members"
              testid="manage-org-member-list"
            >
              <template #row="{ item: member }">
                <div class="user-card">
                  <span class="user-email" data-testid="manage-org-member-email"
                    ><EmailAddress :words="member.email"
                  /></span>
                  <span class="role-badge role-member">Member</span>
                  <button
                    v-if="isOwner()"
                    type="button"
                    class="btn btn--secondary"
                    data-testid="manage-org-make-admin-button"
                    data-dialog-not-first
                    @click="askToChangePlace(member.userId, member.email, 'member')"
                  >
                    Make admin<span class="visually-hidden"> {{ member.email }}</span>
                  </button>
                  <button
                    v-if="canRemoveUser(member.userId, 'member')"
                    type="button"
                    class="btn btn--secondary btn--destructive"
                    data-testid="manage-org-remove-member-button"
                    @click="askToRemove(member.userId, member.email, 'members')"
                  >
                    Remove<span class="visually-hidden"> {{ member.email }}</span>
                  </button>
                </div>
              </template>
              <template #empty>
                <p v-show="!showAddMemberForm">No members</p>
              </template>
            </ListFrame>
          </div>
          <button
            v-if="!showAddMemberForm"
            type="button"
            class="btn btn--secondary"
            ref="addMemberButton"
            data-testid="manage-org-add-member-button"
            @click="openAddMember"
          >
            Invite member
          </button>
          <form v-if="showAddMemberForm" class="add-user-form" @submit.prevent="handleAddMember">
            <div class="add-org-row">
              <input
                ref="addMemberInput"
                id="manage-org-add-member-email"
                v-model="newMemberEmail"
                name="member-email"
                type="email"
                autocomplete="off"
                placeholder="Email address"
                aria-label="Email of the member to invite"
                class="field"
                data-testid="manage-org-add-member-input"
              />
              <button
                type="submit"
                class="btn btn--primary"
                :disabled="!newMemberEmail.trim()"
                data-testid="manage-org-add-member-submit"
              >
                Send invitation
              </button>
              <button
                type="button"
                class="btn btn--secondary"
                data-testid="manage-org-add-member-cancel"
                @click="closeAddMember"
              >
                Cancel
              </button>
            </div>
            <p class="form-hint" data-testid="manage-org-add-member-hint">
              They get an email, and join once they accept it signed in with this address.
            </p>
            <p
              v-if="addMemberSentence"
              ref="addMemberErrorLine"
              class="form-error"
              data-testid="manage-org-add-member-error"
            >
              {{ addMemberSentence }}
            </p>
            <InvitationSent :sent="memberInviteSent" testid="manage-org-add-member" />
          </form>
        </section>

        <!-- The invitations waiting, for the owner and the admins: nobody in them is in the
             organization until they accept, so they are their own list, after the people who are. -->
        <!-- Hidden rather than taken away while nothing waits: withdrawing the last invitation
             empties it while its confirmation is still closing. -->
        <section
          v-if="canManage()"
          v-show="invitations.failed.value || invitations.rows.value.length"
          class="section"
        >
          <InvitationsWaiting
            :waiting="invitations"
            kind="organization"
            :mayWithdraw="mayWithdraw"
            :open="manageOpen"
            testid="manage-org"
            :focusWhenNoneLeft="membersList"
            @withdrawn="changesMade++"
          />
        </section>

        <!-- The table its new markets copy (E39/F02/S01): a line here and the rows in a dialog of
             their own; its owner and admins change it, its members read it. -->
        <OrganizationPermissions :key="orgData.id" :org="orgData" @changed="defaultsChanged" />

        <!-- The organization's own changes, newest first (E40/F02/S01), opened as Manage market's
             History opens; its owner, its admins and its members read it. -->
        <HistorySection :key="orgData.id" testid="manage-org-history">
          <OrganizationHistory :org-id="orgData.id" :changes-made="changesMade" />
        </HistorySection>

        <!-- Renaming is the owner's alone, as the server holds it. -->
        <section v-if="isOwner()" class="section">
          <h3>Rename organization</h3>
          <form class="rename-row" @submit.prevent="handleRename">
            <input
              id="manage-org-rename"
              v-model="renameValue"
              name="organization-name"
              class="field"
              aria-label="Organization name"
              data-testid="manage-org-rename-input"
            />
            <button
              type="submit"
              class="btn btn--primary"
              :disabled="!renameValue.trim() || renameValue.trim() === orgData.name"
              data-testid="manage-org-rename-save-button"
            >
              Save
            </button>
          </form>
          <p v-if="renameSentence" class="form-error" data-testid="manage-org-rename-error">
            {{ renameSentence }}
          </p>
        </section>

        <section v-if="isOwner()" class="section danger-section">
          <h3>Delete organization</h3>
          <button
            type="button"
            class="btn btn--destructive"
            data-testid="manage-org-delete-button"
            @click="deleteConfirming = true"
          >
            Delete organization
          </button>
        </section>
      </div>
    </template>
  </AppDialog>

  <!-- The product's destructive dialog, opened on Cancel: it names the person and what they lose. -->
  <AppDialog
    :open="manageOpen && !!removing"
    :title="removing?.title ?? ''"
    testid="manage-org-remove"
    destructive
    confirm-label="Remove"
    :submission="removal"
    @close="cancelRemove"
    @submit="handleRemoveUser"
  >
    <p class="confirm-text" data-testid="manage-org-remove-consequence">{{ removing?.loses }}</p>
  </AppDialog>

  <!-- Not destructive, since another change undoes it, as a market role change's is not (T211). -->
  <AppDialog
    :open="manageOpen && !!placing"
    :title="placing?.title ?? ''"
    testid="manage-org-place-change"
    :confirm-label="placing?.confirmLabel ?? ''"
    :submission="placeChange"
    @close="cancelPlaceChange"
    @submit="handlePlaceChange"
  >
    <p class="confirm-text" data-testid="manage-org-place-change-text">{{ placing?.text }}</p>
  </AppDialog>

  <DeleteOrgDialog
    v-if="orgData"
    :open="deleteConfirming"
    :org-id="orgData.id"
    :org-name="orgData.name"
    @close="deleteConfirming = false"
    @deleted="handleDeleted()"
  />
</template>

<style scoped>
/* The scrim, window, close control and width belong to `AppDialog`; the buttons and fields to
   `primitives.css`. What is left here is this dialog's own list of people. */
.org-name {
  margin: 0;
  color: var(--mm-text-muted);
  font-size: var(--text-sm);
}

.content {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.section h3 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--mm-black);
}

.users-list {
  margin-bottom: var(--space-3);
}

/* The frame's rows here are cards, each with its border, so they keep the room between them. */
.users-list :deep(.list-frame__rows) {
  gap: var(--space-2);
}

.user-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
  background: var(--mm-beige);
}

.user-email {
  flex: 1;
  font-size: var(--text-sm);
  color: var(--mm-black);
  overflow-wrap: anywhere;
}

/* On a phone a person's address takes a line of its own, with the role and Remove beneath it, as on
   Manage market: beside them, a long address was squeezed into a column a few letters wide. */
@media (width <= 640px) {
  .user-card {
    flex-wrap: wrap;
  }

  .user-email {
    flex-basis: 100%;
  }
}

.role-badge {
  display: inline-block;
  padding: var(--space-hairline) var(--space-2);
  border-radius: var(--radius-control);
  font-weight: 400;
  font-size: var(--text-xs);
  white-space: nowrap;
}

/* Opaque chip grounds, so a badge reads the same on a dialog's beige as on white (T79). */
.role-owner {
  background: var(--mm-chip-informational);
  color: var(--mm-blue);
}

.role-admin {
  background: var(--mm-chip-positive);
  color: var(--mm-text-green);
}

.role-member {
  background: var(--mm-chip-positive);
  color: var(--mm-text-green);
}

/* Brought into view as it arrives, it rests clear of the body's edge shade, under which a red line
   at the rounded foot reads as cut off. */
.add-user-form .form-error {
  scroll-margin-bottom: var(--edge-shade-depth);
}

.add-user-form {
  margin-top: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.add-org-row,
.rename-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.form-hint {
  margin: 0;
  color: var(--mm-text-muted);
  font-size: var(--text-xs);
}

/* On a phone an invite row's email field takes the row, with Send invitation and Cancel beneath it
   at its end: beside them it was squeezed to 141px, too narrow to read the address being typed. The
   rename row stays one row. */
@media (width <= 640px) {
  .add-org-row {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .add-org-row .field {
    flex-basis: 100%;
  }
}

.form-error {
  margin: 0;
  color: var(--mm-red);
  font-size: var(--text-xs);
}

.danger-section {
  padding-top: var(--space-4);
  border-top: 1px solid var(--mm-border);
}

.confirm-text {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
}
</style>
