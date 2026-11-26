<script setup lang="ts">
/**
 * Manage market: who has access and their roles, whom it has invited, who may do what, the market's
 * history, its name, its ownership and its deletion.
 *
 * Each write belongs to the opening it was sent from (T411): its handle (`useDialogSubmit`) is keyed
 * by the market Manage market is open on, or by what its confirmation was opened with, and handed to
 * the dialog that sent it, so the shell holds that dialog while it writes and a second press sends
 * nothing. An answer that lands after Manage market was closed, or opened on another market, leaves
 * the dialog the person is in alone.
 *
 * Its own copy of the market is a keyed read (`useServerRead`, T277 ticket 11), keyed by the market
 * it is open on: a read of the market it had been open on never lands in another opening, each
 * write is sent to the address of that key, and a write's re-read overtakes every read asked before
 * it, so an older answer never puts back what the write changed. The invitations waiting on it are a
 * keyed read of their own, by the same rules (T538).
 */
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import {
  type Market,
  MarketPhase,
  MarketRole,
  type PermissionTableRow,
  type MarketInvitationRole,
  type PersonWithAccess,
  type SentInvitation,
} from '@/assets/types/datatypes';
import { api, getApiErrorMessage, getApiErrorStatus, isMarketChanged } from '@/utils/api';
import { parseMarketFromApi } from '@/utils/market';
import { useMarketStore } from '@/stores/market';
import { useDialogSubmit } from '@/utils/useDialogSubmit';
import { useServerRead } from '@/utils/useServerRead';
import AppDialog from '@/components/AppDialog.vue';
import EmailAddress from '@/components/EmailAddress.vue';
import HandOnMarketDialog from '@/components/HandOnMarketDialog.vue';
import MarketPermissions from '@/components/MarketPermissions.vue';
import HistorySection from '@/components/HistorySection.vue';
import InvitationSent from '@/components/InvitationSent.vue';
import InvitationsWaiting from '@/components/InvitationsWaiting.vue';
import ListFrame, { LIST_FIND_FROM } from '@/components/ListFrame.vue';
import MarketHistory from '@/components/MarketHistory.vue';
import {
  getRoleDisplayName,
  canManageRoles,
  getRolesForChange,
  GIVEN_ROLES,
} from '@/utils/permissions';
import { MarketAction, actionRefusal, mayTake } from '@/utils/marketActions';
import { intakeModeOf } from '@/utils/marketGuide';
import { hasVendorPage } from '@/utils/vendorPage';
import { openInsteadOfStepping } from '@/utils/openInsteadOfStepping';
import { isTheReader } from '@/utils/personChoice';
import {
  alsoWords,
  marketRemoval,
  marketRoleChange,
  roleAddingNothing,
  roleWords,
} from '@/utils/peopleWithAccess';
import {
  fetchMarketInvitations,
  inviteToMarket,
  saidOf,
  withdrawMarketInvitation,
  type InviteSaid,
} from '@/utils/invitations';
import { useInvitationsWaiting } from '@/utils/useInvitationsWaiting';

const props = defineProps<{
  manageOpen: boolean;
  market: Market | null;
}>();

const emit = defineEmits<{
  manageClose: [];
}>();

const renameValue = ref('');
const showAddUserForm = ref(false);
const newUserEmail = ref('');
const newUserRole = ref<MarketRole>(MarketRole.Editor);
const addUserErrorLine = ref<HTMLElement | null>(null);
/** What the invite row says of the invitation it last sent, until the next is sent or the row closes. */
const inviteSent = ref<InviteSaid | null>(null);
const deleteConfirming = ref(false);
/** Counts the changes this dialog has made, so its History reads them as they land. */
const changesMade = ref(0);
/** A refused change to one person's role, said beneath their row. */
const userError = ref<{ userId: string; email: string; message: string } | null>(null);
/**
 * The person a Remove is asking about, until it is confirmed or cancelled (E38/F15/S01), and the
 * words the confirmation says, taken when it opens: the re-read after a confirm may name the market
 * or its organization differently, and the closing confirmation must not.
 */
const removing = ref<{
  userId: string;
  title: string;
  loses: string;
  keeps: string;
} | null>(null);
const peopleList = ref<HTMLElement | null>(null);
/** What finds in "Users with access", for as long as the dialog is open: never in the address. */
const peopleWords = ref('');
/**
 * The role a select has chosen, until it is confirmed or cancelled (T211), with the select that
 * chose it, to put back, and the words the confirmation says, taken when it opens, as Remove's are.
 */
const roleChange = ref<
  | ({
      userId: string;
      email: string;
      held: MarketRole;
      role: MarketRole;
      select: HTMLSelectElement;
    } & ReturnType<typeof marketRoleChange>)
  | null
>(null);
/** Whether "Transfer ownership" is asking whom to, until it lands or is cancelled (T283). */
const handingOn = ref(false);

/** The market Manage market is open on, or nothing while it is closed: each change is an opening. */
const openOn = () => (props.manageOpen ? (props.market?.id ?? null) : null);

/**
 * Manage market's own read of the market it is open on, from the opening's first read to each
 * write's re-read.
 */
const read = useServerRead<string, Market>(
  openOn,
  (id) =>
    api
      .get(`/markets/${encodeURIComponent(id)}`)
      .then((response) => parseMarketFromApi(response.data.market)),
  { failure: 'The market could not be loaded.' },
);
// The rename field takes each name a read brings that differs from the last, so a re-read after
// a role change or a refused rename leaves a name being typed alone.
watch(
  () => read.data.value?.name,
  (name) => {
    if (name !== undefined) renameValue.value = name;
  },
);
/**
 * After the opening's first read failed, the opener's copy of the same market, with each change
 * to who may do what taken into it: what the dialog works on until a read lands, kept through each
 * write's re-read, so the dialog still works on a bad network as it did. Forgotten on a move.
 */
const openersCopy = shallowRef<Market | null>(null);
watch(read.key, () => (openersCopy.value = null), { flush: 'sync' });
watch(read.phase, (phase) => {
  const opener = props.market;
  if (phase === 'failed' && !openersCopy.value && opener && opener.id === read.key.value) {
    openersCopy.value = opener;
  }
});
/** The market as Manage market last read it, or the opener's copy after its first read failed. */
const marketData = computed(() => read.data.value ?? openersCopy.value);
/** Its first read is out: the dialog names the market it was opened on, and says it is loading. */
const loading = computed(() => read.phase.value === 'loading' && !marketData.value);
/** A read that failed, said by the shell: the first, or a re-read with the market kept. */
const errorMessage = computed(() =>
  read.phase.value === 'failed' || read.phase.value === 'refresh_failed' ? read.sentence.value : '',
);
/** The market's name: as last read, or the opener's until the first read lands. */
const shownName = computed(() => marketData.value?.name ?? props.market?.name ?? '');

/**
 * Reads the market again after a write sent in this opening, `isCurrent` its submission's: the read
 * overtakes any asked before it, so an older answer never lands after it. Once Manage market has
 * moved on, nothing is read.
 */
async function rereadAfterAWrite(isCurrent: () => boolean) {
  if (isCurrent()) await read.reread();
}

/** What a confirmation over Manage market is open on: nothing once Manage market closes. */
const over =
  <T,>(asked: () => T) =>
  () =>
    props.manageOpen ? asked() : null;

/**
 * Invite someone's and Rename's writes, each said beside its row; Manage market holds while either
 * sends.
 */
const addUser = useDialogSubmit({
  opening: openOn,
  failure: 'The invitation was not sent.',
  says: 'self',
});
const rename = useDialogSubmit({
  opening: openOn,
  failure: 'The name was not changed.',
  says: 'self',
});
const { sentence: addUserSentence } = addUser;
const { sentence: renameSentence } = rename;
/** Each confirmation's write, keyed by what it was opened on. */
const removal = useDialogSubmit({
  opening: over(() => removing.value),
  failure: 'The person was not removed.',
});
/** A refused role change is said beneath its row, and the confirmation closes on it. */
const roleChanging = useDialogSubmit({
  opening: over(() => roleChange.value),
  failure: 'The role was not changed.',
  says: 'self',
});
const handOn = useDialogSubmit({
  opening: over(() => (handingOn.value ? props.market?.id : null)),
  failure: 'Ownership was not transferred.',
});
const deletion = useDialogSubmit({
  opening: over(() => (deleteConfirming.value ? props.market?.id : null)),
  failure: 'The market was not deleted.',
});
// Each opening starts clean: the read itself moves with the market it is open on.
watch(
  () => [props.manageOpen, props.market] as const,
  ([open, market]) => {
    if (open && market) {
      renameValue.value = market.name;
      showAddUserForm.value = false;
      inviteSent.value = null;
      deleteConfirming.value = false;
      removing.value = null;
      peopleWords.value = '';
      roleChange.value = null;
      handingOn.value = false;
      userError.value = null;
    }
  },
  { immediate: true },
);

/** The open market, re-read when it is this one: a write here may change what it shows. */
function refreshTheOpenMarket(marketId: string | undefined) {
  const store = useMarketStore();
  if (marketId && store.marketId === marketId) void store.refresh();
}

/**
 * Everyone with access, in the order the read serves them (E38/F12/S01): the owner first, then by
 * the role that counts, then by address, so someone who just accepted an invitation takes their
 * place, never the top.
 */
const accessList = computed(() =>
  (marketData.value?.peopleWithAccess ?? []).map((person) => ({
    ...person,
    addingNothing: roleAddingNothing(person),
  })),
);

const PERSON = { one: 'person', many: 'people' };
const findsPerson = (person: PersonWithAccess, words: string) =>
  person.email.toLowerCase().includes(words.toLowerCase());
const keyOfPerson = (person: PersonWithAccess) => person.userId;

/**
 * Narrows the list to one person, so their row is in sight wherever they fall in it. A list too
 * short for a find field already draws every row, unless words are narrowing it.
 */
function findPerson(email: string) {
  if (accessList.value.length > LIST_FIND_FROM || peopleWords.value) peopleWords.value = email;
}

/** A refusal whose row the re-read took away, someone else having removed them first. */
const refusalWithNoRow = computed(() =>
  userError.value && !accessList.value.some((row) => row.userId === userError.value?.userId)
    ? userError.value
    : null,
);

/** The organization a row's role comes through, by name. */
const organizationLabel = computed(() => marketData.value?.organizationName ?? 'its organization');

/** Whether any row's role comes from the organization, which Manage organization changes. */
const anyThroughOrganization = computed(() => accessList.value.some((row) => row.fromOrganization));

/** What this caller could change the given role TO. Empty means it is not theirs to change. */
function changeableRoles(role: MarketRole): MarketRole[] {
  return getRolesForChange(marketData.value, role);
}

/**
 * The roles this person may grant, in the order they are offered. Empty for anyone neither roles
 * row lets through, a Viewer or an Editor on the built-in table, who were shown "Add user" and
 * refused with a 403 (bug 37), and who see no "Invited".
 */
const grantableRoles = computed(() =>
  GIVEN_ROLES.filter((role) => canManageRoles(marketData.value, role)),
);

/**
 * The invitations waiting on the market, read for a reader whom either roles row lets through, as
 * the server serves them only to such a reader; keyed by the market Manage market is open on, so an
 * answer for the market it was open on never lands in another opening.
 */
const invitations = useInvitationsWaiting({
  key: () => (grantableRoles.value.length ? read.key.value : null),
  fetch: fetchMarketInvitations,
  withdraw: withdrawMarketInvitation,
  ended: rereadAfterAWrite,
});
// Each opening starts with nothing finding in "Invited".
watch(
  () => [props.manageOpen, props.market] as const,
  ([open, market]) => {
    if (open && market) invitations.reset();
  },
  { immediate: true },
);
/** Whoever may give an invitation's role may withdraw it, as the server asks that role's row. */
const mayWithdraw = (invitation: SentInvitation<MarketInvitationRole>) =>
  canManageRoles(marketData.value, invitation.role);

/** Transferring a market's ownership is the table's "Transfer ownership" row, its Owner's alone (T283). */
const canHandOn = computed(() => mayTake(marketData.value, MarketAction.HandOnMarket));

/**
 * Whether anyone but the person looking has access, so there is someone to transfer ownership to:
 * only the Owner sees the section, so that person is the Owner.
 */
const anyoneToHandOnTo = computed(() =>
  accessList.value.some((person) => !isTheReader(person.email)),
);

/** Deleting a market is the table's "Delete the market" row, its owner's alone. */
const canDelete = computed(() => mayTake(marketData.value, MarketAction.DeleteMarket));

/** The market's own table's labels by row id, for the history's changes to a row. */
const rowLabels = computed(() =>
  Object.fromEntries((marketData.value?.permissionTable ?? []).map((row) => [row.id, row.label])),
);

/** The market's history is read at its own row, "Read the market's history" (E40/F01/S03). */
const canReadHistory = computed(() => mayTake(marketData.value, MarketAction.ReadHistory));

/** Why this person may not rename the market, the Market Setup row's answer, or null. */
const renameRefusal = computed(() => actionRefusal(marketData.value, MarketAction.ChangeSetup));

/**
 * The invitation is sent and the invitations read again, both inside the write, so a second press
 * sends nothing until "Invited" lists it. The answer is the same for every address, and nobody is
 * under "Users with access" until they accept. A refusal is said under the form in the server's
 * words, the address kept.
 */
async function handleAddUser() {
  const email = newUserEmail.value.trim();
  const market = marketData.value;
  const marketId = read.key.value;
  if (!market || !marketId || !email) return;
  const role = newUserRole.value;
  inviteSent.value = null;
  await addUser.submit(
    async (isCurrent) => {
      const sent = await inviteToMarket(marketId, email, role);
      await invitations.reread(isCurrent);
      return saidOf(sent, email);
    },
    {
      done: (sent) => {
        // The form stays open with an empty field: inviting two people in a row is the case
        // E20/F01/S02 is named after, and this dialog is the same shape.
        newUserEmail.value = '';
        newUserRole.value = MarketRole.Editor;
        inviteSent.value = sent;
        // A later change ends a refusal's words, as choosing a role or removing someone does.
        userError.value = null;
        changesMade.value++;
      },
    },
  );
}

// A refused invitation stands under the form, which a short window's body can hold at its foot.
watch(
  addUserSentence,
  (sentence) => {
    if (sentence) addUserErrorLine.value?.scrollIntoView?.({ block: 'nearest' });
  },
  { flush: 'post' },
);

/** Remove asks first (E38/F15/S01): it took the role in one click, from a filled red button. */
function askToRemove(person: PersonWithAccess) {
  if (!marketData.value) return;
  removing.value = {
    userId: person.userId,
    ...marketRemoval(person, marketData.value.name, organizationLabel.value),
  };
}

/** Cancel, Escape and the backdrop change nothing; the shell gives focus back to the row's Remove. */
function cancelRemove() {
  removing.value = null;
}

/**
 * Confirmed: the market role is taken, and the list re-read in place with Manage market still
 * open. The Remove that opened the confirmation is gone with the role, so focus goes to the list. A
 * 404 is a role another admin took first: what was asked for is true, so it is read as done. Any
 * other refusal stays in the confirmation, which said what was about to happen; one saying the
 * market changed under it re-reads the list too, as a role change's does.
 */
async function handleRemoveUser() {
  const target = removing.value;
  const market = marketData.value;
  const marketId = read.key.value;
  if (!market || !marketId || !target) return;
  await removal.submit(
    async (isCurrent) => {
      userError.value = null;
      try {
        await api.delete(
          `/markets/${encodeURIComponent(marketId)}/roles/${encodeURIComponent(target.userId)}`,
        );
      } catch (err) {
        if (getApiErrorStatus(err) !== 404) {
          // The market changed under the removal (ADR 0024): the list behind is re-read, the
          // confirmation kept open with the sentence.
          if (isMarketChanged(err)) await rereadAfterAWrite(isCurrent);
          throw err;
        }
      }
      // Held until the confirmation closes: during the re-read its Remove would send a second
      // removal.
      await rereadAfterAWrite(isCurrent);
    },
    {
      done: async () => {
        changesMade.value++;
        removing.value = null;
        // Once the confirmation has closed and the page behind it is no longer inert.
        await nextTick();
        peopleList.value?.focus();
      },
    },
  );
}

/**
 * A role change asks first (T211): one slip of the select changed someone's access at once. The
 * select keeps showing the choice behind the confirmation, and nothing is sent until it is confirmed.
 */
function askToChangeRole(person: PersonWithAccess, select: HTMLSelectElement) {
  const role = select.value as MarketRole;
  if (!marketData.value || role === person.role) return;
  userError.value = null;
  // Safari focuses no select on a click, and the shell gives focus back to what held it on opening.
  select.focus();
  roleChange.value = {
    userId: person.userId,
    email: person.email,
    held: person.role,
    role,
    select,
    ...marketRoleChange(
      person,
      role,
      marketData.value.name,
      marketData.value.permissionTable ?? [],
    ),
  };
}

/** Cancel, Escape and the backdrop change nothing; the shell gives focus back to the select. */
function cancelRoleChange() {
  if (!roleChange.value) return;
  roleChange.value.select.value = roleChange.value.held;
  roleChange.value = null;
}

/**
 * Confirmed: the role is changed, and the list re-read in place with Manage market still open. A
 * refusal is said beneath the row, where it has always been said (bug 43), and the list is re-read
 * too, since someone else may have moved or removed them first, as the refusal itself often means.
 * The shell gives focus back to the select, unless the re-read took it away, as it does when the
 * person looking changed their own role or the row moved past those shown, when focus goes to the
 * list. A refusal whose row moved past those shown finds that person, or no one would read it.
 */
async function handleRoleChange() {
  const target = roleChange.value;
  const market = marketData.value;
  const marketId = read.key.value;
  if (!market || !marketId || !target) return;
  await roleChanging.submit(
    async (isCurrent) => {
      // A refusal closes the confirmation as a change does: what the write answers is its refusal's
      // sentence, or nothing.
      let refusal = '';
      try {
        await api.put(
          `/markets/${encodeURIComponent(marketId)}/roles/${encodeURIComponent(target.userId)}`,
          { role: target.role },
        );
      } catch (err) {
        refusal = getApiErrorMessage(err, 'The role was not changed.');
      }
      // Held until the confirmation closes: during the re-read its confirm would send a second
      // write.
      await rereadAfterAWrite(isCurrent);
      return refusal;
    },
    {
      done: async (refusal) => {
        if (refusal) {
          target.select.value = target.held;
          userError.value = { userId: target.userId, email: target.email, message: refusal };
        } else {
          changesMade.value++;
        }
        roleChange.value = null;
        // Once the confirmation has closed and the page behind it is no longer inert.
        await nextTick();
        if (target.select.isConnected) return;
        peopleList.value?.focus();
        if (userError.value && !refusalWithNoRow.value) findPerson(target.email);
      },
    },
  );
}

/**
 * The name is the market's public web address, so it can change only while the market is a draft
 * (E21/F03/S04). Past that, this says why rather than offering a control the server refuses.
 */
const renameAllowed = computed(() => marketData.value?.phase === MarketPhase.Draft);

/**
 * The name is written and the market read again, both inside the write. A refusal is said in the
 * server's own words: a clash is about the public web address, not only the exact name.
 */
async function handleRename() {
  const market = marketData.value;
  const marketId = read.key.value;
  const name = renameValue.value.trim();
  if (!market || !marketId || name === market.name) return;
  await rename.submit(
    async (isCurrent) => {
      try {
        // Its own write, carrying only the name - not the whole market (E21/F03/S04).
        await api.put(`/markets/${encodeURIComponent(marketId)}/name`, { name });
      } catch (err) {
        // The market changed under the rename (ADR 0024), most likely leaving draft: it is read
        // again, so the field gives way to why the name is fixed, the sentence kept.
        if (isMarketChanged(err)) await rereadAfterAWrite(isCurrent);
        throw err;
      }
      await rereadAfterAWrite(isCurrent);
    },
    {
      done: () => {
        changesMade.value++;
        // The open market may be this one: a rename is a write, so the store re-reads it.
        refreshTheOpenMarket(marketId);
      },
      // Renamed after Manage market moved on: the open market still takes the new name.
      late: (answer) => {
        if (answer.ok) refreshTheOpenMarket(marketId);
      },
    },
  );
}

function askToHandOn() {
  handingOn.value = true;
}

/** Cancel, Escape and the backdrop change nothing; the shell gives focus back to "Transfer ownership". */
function cancelHandOn() {
  handingOn.value = false;
}

/**
 * Confirmed: the person chosen becomes the Owner and this person an Admin, in one write. The market
 * is re-read, as every write here re-reads it, so "Transfer ownership" goes, since this person no
 * longer owns it, and Users with access shows both new roles; focus goes to that list, as its button
 * is gone. A refusal stays in the dialog; one saying the market changed under it re-reads the
 * market behind it, as a removal's does, and so does one saying the person chosen has no access,
 * since the read the choice came from is stale: they then drop out of the choices.
 */
async function handleHandOn(userId: string) {
  const market = marketData.value;
  const marketId = read.key.value;
  if (!market || !marketId) return;
  await handOn.submit(
    async (isCurrent) => {
      try {
        await api.post(`/markets/${encodeURIComponent(marketId)}/hand-on`, { userId });
      } catch (err) {
        if (isMarketChanged(err) || getApiErrorStatus(err) === 400)
          await rereadAfterAWrite(isCurrent);
        throw err;
      }
      await rereadAfterAWrite(isCurrent);
    },
    {
      done: async () => {
        changesMade.value++;
        // The open market may be this one: what this person may do on it changed with their role.
        refreshTheOpenMarket(marketId);
        handingOn.value = false;
        // Once the dialog has closed and the page behind it is no longer inert.
        await nextTick();
        peopleList.value?.focus();
      },
      late: (answer) => {
        if (answer.ok) refreshTheOpenMarket(marketId);
      },
    },
  );
}

/**
 * Its public pages, which go with it, in words, while it has them (ADR 0022, T469): its market
 * page, and its vendor page, where its vendors also check in, and which is the record once it has
 * run (E26/F06/S02).
 */
const publicPages = computed(() => {
  const market = marketData.value;
  if (!market || !hasVendorPage(market)) return '';
  return 'Its market page and vendor page will stop working for anyone who has the links.';
});

/** One delete however often it is pressed; the confirmation holds until it answers. */
async function handleDeleteConfirm() {
  const market = marketData.value;
  const marketId = read.key.value;
  if (!market || !marketId) return;
  await deletion.submit(() => api.delete(`/markets/${encodeURIComponent(marketId)}`), {
    done: () => {
      deleteConfirming.value = false;
      emit('manageClose');
    },
  });
}

function handleDeleteCancel() {
  deleteConfirming.value = false;
}

/**
 * A change to who may do what answers the table, which this copy of the market then shows: taken
 * into the read for the market it is open on, and a re-read asked before it is asked again.
 */
function handleTableChanged(table: PermissionTableRow[]) {
  const marketId = read.key.value;
  if (marketId) read.adopt(marketId, (market) => ({ ...market, permissionTable: table }));
  if (openersCopy.value) openersCopy.value = { ...openersCopy.value, permissionTable: table };
  changesMade.value++;
}

const addUserButton = ref<HTMLButtonElement | null>(null);
const addUserInput = ref<HTMLInputElement | null>(null);

/**
 * Opening the row takes away "Invite someone", and closing it its Cancel, so focus goes where the
 * person is next: the field, and then "Invite someone" again. Left alone it fell to `<body>`.
 */
async function openAddUser() {
  showAddUserForm.value = true;
  await nextTick();
  addUserInput.value?.focus();
}

/** Cancelling clears what was typed and any error, so reopening does not hand back a rejected value. */
async function closeAddUser() {
  showAddUserForm.value = false;
  newUserEmail.value = '';
  inviteSent.value = null;
  addUser.edit();
  await nextTick();
  addUserButton.value?.focus();
}
</script>

<template>
  <AppDialog
    :open="manageOpen"
    title="Manage market"
    testid="manage-market"
    size="wide"
    scroll="body"
    :error="errorMessage"
    :submission="[addUser, rename]"
    @close="emit('manageClose')"
  >
    <p v-if="shownName" class="market-name">{{ shownName }}</p>

    <p v-if="loading" class="empty-state">Loading...</p>
    <div v-else-if="marketData" class="content">
      <section class="section">
        <h3 id="manage-market-people-heading">Users with access</h3>
        <div
          ref="peopleList"
          class="users-list"
          role="group"
          aria-labelledby="manage-market-people-heading"
          tabindex="-1"
          data-testid="manage-market-people"
        >
          <ListFrame
            v-model:words="peopleWords"
            :items="accessList"
            :finds="findsPerson"
            :itemKey="keyOfPerson"
            :noun="PERSON"
            findLabel="Find in users with access"
            testid="manage-market-access"
          >
            <template #row="{ item: row }">
              <div class="user-entry" data-testid="manage-market-person">
                <div class="user-card">
                  <span class="user-email"><EmailAddress :words="row.email" /></span>
                  <!--
                  A role with nowhere to go is stated, not offered (E20/F01/S03). The owner's own row
                  rendered a select whose only option was "Owner" - a control that looks like a
                  decision and is not one, which is the same thing S01 settled for the org picker. A
                  role the organization gives is stated too: only Manage organization changes it.
                -->
                  <span
                    v-if="row.fromOrganization || !changeableRoles(row.role).length"
                    class="role-badge"
                    :class="`role-${row.role}`"
                    data-testid="manage-market-role"
                  >
                    {{ roleWords(row, organizationLabel) }}
                  </span>
                  <select
                    v-else
                    :value="row.role"
                    :name="`role-${row.userId}`"
                    :aria-label="`${row.email}'s role`"
                    class="field field--select role-select"
                    data-testid="manage-market-role-select"
                    @keydown="openInsteadOfStepping"
                    @change="askToChangeRole(row, $event.target as HTMLSelectElement)"
                  >
                    <option :value="row.role">{{ getRoleDisplayName(row.role) }}</option>
                    <option v-for="r in changeableRoles(row.role)" :key="r" :value="r">
                      {{ getRoleDisplayName(r) }}
                    </option>
                  </select>
                  <button
                    v-if="!row.fromOrganization && canManageRoles(marketData, row.role)"
                    type="button"
                    class="btn btn--secondary btn--destructive"
                    data-testid="manage-market-remove-user-button"
                    @click="askToRemove(row)"
                  >
                    Remove<span class="visually-hidden"> {{ row.email }}</span>
                  </button>
                  <!-- A market role the organization's reaches changes nothing; its Remove tidies it
                       away and leaves the organization's role (the walk's admin added as Editor). -->
                  <div v-if="row.addingNothing" class="user-also">
                    <p class="user-also-text" data-testid="manage-market-also">
                      {{ alsoWords(row, organizationLabel) }}
                    </p>
                    <button
                      v-if="canManageRoles(marketData, row.addingNothing)"
                      type="button"
                      class="btn btn--secondary btn--destructive"
                      data-testid="manage-market-remove-user-button"
                      @click="askToRemove(row)"
                    >
                      Remove<span class="visually-hidden">
                        {{ getRoleDisplayName(row.addingNothing) }} on this market</span
                      >
                    </button>
                  </div>
                </div>
                <!-- Beneath the row that caused it: a refused change used to be reported at the foot of
                     the dialog, far from the select that made it (bug 43). -->
                <p
                  v-if="userError?.userId === row.userId"
                  class="form-error"
                  data-testid="manage-market-user-error"
                >
                  {{ userError.message }}
                </p>
              </div>
            </template>
          </ListFrame>
          <p v-if="refusalWithNoRow" class="form-error" data-testid="manage-market-user-error">
            {{ refusalWithNoRow.email }}: {{ refusalWithNoRow.message }}
          </p>
        </div>
        <p
          v-if="anyThroughOrganization"
          class="form-hint organization-people"
          data-testid="manage-market-organization-people"
        >
          Organization admins and members are managed in
          <RouterLink
            v-if="marketData.inOrganization && marketData.organizationId"
            :to="{ name: 'organizations', query: { manage: marketData.organizationId } }"
            >Manage organization</RouterLink
          ><template v-else>Manage organization</template>.
        </p>
        <!-- The invitations waiting, for a reader who may give some role: nobody in them has access
             until they accept, so they are their own list, after the people who have it. -->
        <InvitationsWaiting
          :waiting="invitations"
          kind="market"
          :mayWithdraw="mayWithdraw"
          :open="manageOpen"
          testid="manage-market"
          :focusWhenNoneLeft="peopleList"
          @withdrawn="changesMade++"
        />
        <!-- Opens the row it adds; that row carries its own Cancel. The button used to turn into a
             Cancel of its own, left alone above the row it cancelled (bug 43). -->
        <button
          v-if="grantableRoles.length && !showAddUserForm"
          type="button"
          class="btn btn--secondary"
          ref="addUserButton"
          data-testid="manage-market-add-user-button"
          @click="openAddUser"
        >
          Invite someone
        </button>
        <!-- Its own form, so Enter in the field sends the invitation through the very same handler. -->
        <form v-if="showAddUserForm" class="add-user-form" @submit.prevent="handleAddUser">
          <div class="add-org-row">
            <input
              ref="addUserInput"
              v-model="newUserEmail"
              type="email"
              name="email"
              autocomplete="off"
              placeholder="Email address"
              aria-label="Email of the person to invite"
              class="field"
              data-testid="manage-market-add-user-input"
            />
            <select
              v-model="newUserRole"
              name="role"
              aria-label="Their role"
              class="field field--select"
              data-testid="manage-market-add-user-select"
            >
              <option v-for="r in grantableRoles" :key="r" :value="r">
                {{ getRoleDisplayName(r) }}
              </option>
            </select>
            <button
              type="submit"
              class="btn btn--primary"
              :disabled="!newUserEmail.trim()"
              data-testid="manage-market-add-user-submit"
            >
              Send invitation
            </button>
            <button
              type="button"
              class="btn btn--secondary"
              data-testid="manage-market-add-user-cancel"
              @click="closeAddUser"
            >
              Cancel
            </button>
          </div>
          <p class="form-hint" data-testid="manage-market-add-user-hint">
            They get an email, and join once they accept it signed in with this address.
          </p>
          <p
            v-if="addUserSentence"
            ref="addUserErrorLine"
            class="form-error"
            data-testid="manage-market-add-user-error"
          >
            {{ addUserSentence }}
          </p>
          <InvitationSent :sent="inviteSent" testid="manage-market-add-user" />
        </form>
      </section>

      <!-- Who may do what on this market (E39/F01/S04): a line here and the rows in a dialog of
           their own, since they would double this one's length for whoever came to add a person. -->
      <MarketPermissions
        v-if="marketData.permissionTable?.length"
        :market="marketData"
        @changed="handleTableChanged"
        @market-changed="read.reread()"
      />
      <!-- Every change on the market, newest first, a page at a time (E40/F01/S03): after the
           people and who may do what (E39/F01/S04). -->
      <HistorySection v-if="canReadHistory" :key="marketData.id" testid="manage-market-history">
        <MarketHistory
          :market-id="marketData.id"
          :row-labels="rowLabels"
          :path="intakeModeOf(marketData)"
          :changes-made="changesMade"
          :questions="marketData.rejectionQuestions ?? []"
          :fields="marketData.applicationForm?.fields ?? []"
        />
      </HistorySection>

      <!-- One organization, fixed when the market was created (E21/F03/S05). This was a list,
           "Organizations with access", with Add and Remove - but there is only ever one, "Add"
           REPLACED it (moving the market, who can see it, and whose deletion deletes it), and it
           fell back to the typed text as an id when no organization of that name existed. -->
      <section class="section">
        <h3>Organization</h3>
        <p class="org-line" data-testid="manage-market-organization">
          <template v-if="marketData.organizationName">
            Belongs to <strong>{{ marketData.organizationName }}</strong>. Its admins run it; its
            members can view it.
          </template>
          <template v-else>Belongs to no organization you can see.</template>
        </p>
      </section>

      <section class="section">
        <h3>Rename market</h3>
        <!-- Renaming is the Market Setup row's: whoever may not change the setup is told why (bug 37). -->
        <p v-if="renameRefusal" class="form-hint" data-testid="manage-market-rename-refused">
          {{ renameRefusal }}
        </p>
        <p v-else-if="!renameAllowed" class="form-hint" data-testid="manage-market-rename-fixed">
          This market's public web address comes from its name, and it has already been shared, so
          its name can no longer change.
        </p>
        <form v-else class="rename-row" @submit.prevent="handleRename">
          <input
            v-model="renameValue"
            name="name"
            autocomplete="off"
            class="field"
            maxlength="100"
            aria-label="Market name"
            data-testid="manage-market-rename-input"
          />
          <button
            type="submit"
            class="btn btn--primary"
            :disabled="!renameValue.trim() || renameValue.trim() === marketData.name"
            data-testid="manage-market-rename-save-button"
          >
            Save
          </button>
        </form>
        <p v-if="renameSentence" class="form-error" data-testid="manage-market-rename-error">
          {{ renameSentence }}
        </p>
      </section>

      <section v-if="canHandOn" class="section" data-testid="manage-market-hand-on">
        <h3>Transfer ownership</h3>
        <template v-if="anyoneToHandOnTo">
          <p class="section-line" data-testid="manage-market-hand-on-line">
            Make someone with access its Owner. You stay on it as an Admin.
          </p>
          <button
            type="button"
            class="btn btn--secondary"
            data-testid="manage-market-hand-on-button"
            @click="askToHandOn"
          >
            Transfer ownership
          </button>
        </template>
        <p v-else class="section-line" data-testid="manage-market-hand-on-nobody">
          Nobody else has access to this market yet. Invite someone under Users with access first.
        </p>
      </section>

      <section v-if="canDelete" class="section danger-section">
        <h3>Delete market</h3>
        <button
          type="button"
          class="btn btn--destructive"
          data-testid="manage-market-delete-button"
          @click="deleteConfirming = true"
        >
          Delete market
        </button>
      </section>
    </div>
  </AppDialog>

  <!-- The product's destructive dialog, opened on Cancel: it names the person, the role they lose
       and the place in the organization they keep. -->
  <AppDialog
    :open="manageOpen && !!removing"
    :title="removing?.title ?? ''"
    testid="manage-market-remove"
    destructive
    confirm-label="Remove"
    :submission="removal"
    @close="cancelRemove"
    @submit="handleRemoveUser"
  >
    <!-- One paragraph: what they lose and what they keep are one thought. -->
    <p class="confirm-text">
      <span data-testid="manage-market-remove-consequence">{{ removing?.loses }}</span>
      <template v-if="removing?.keeps">
        {{ ' ' }}<span data-testid="manage-market-remove-keeps">{{ removing.keeps }}</span>
      </template>
    </p>
  </AppDialog>

  <!-- Not destructive, since another change undoes it. Its body scrolls: Viewer to Admin lists about
       twenty rows on the default table, and the question and its answer stay in sight. -->
  <AppDialog
    :open="manageOpen && !!roleChange"
    :title="roleChange?.title ?? ''"
    testid="manage-market-role-change"
    scroll="body"
    confirm-label="Change role"
    :submission="roleChanging"
    @close="cancelRoleChange"
    @submit="handleRoleChange"
  >
    <template v-if="roleChange">
      <p class="confirm-text" data-testid="manage-market-role-change-was">{{ roleChange.was }}</p>
      <div :data-testid="`manage-market-role-change-${roleChange.kind}`">
        <p class="confirm-text">{{ roleChange.lead }}</p>
        <ul v-if="roleChange.rows.length" class="role-change-rows">
          <li v-for="label in roleChange.rows" :key="label">{{ label }}</li>
        </ul>
      </div>
    </template>
  </AppDialog>

  <HandOnMarketDialog
    :open="manageOpen && handingOn && !!marketData"
    :market-name="marketData?.name ?? 'this market'"
    :people="accessList"
    :organization-name="organizationLabel"
    :submission="handOn"
    @close="cancelHandOn"
    @confirm="handleHandOn"
    @choose="handOn.edit()"
  />

  <!--
    The product's destructive dialog, as archiving and deleting an organization are (bug 43): it
    names what goes, and opens on Cancel. It was an inline "Are you sure?" with Confirm before
    Cancel and focus left on the page, so one stray Enter was the whole irreversible action.
  -->
  <AppDialog
    :open="manageOpen && deleteConfirming && !!marketData"
    :title="`Delete ${marketData?.name ?? 'this market'}?`"
    testid="manage-market-delete"
    destructive
    confirm-label="Delete market"
    :submission="deletion"
    @close="handleDeleteCancel"
    @submit="handleDeleteConfirm"
  >
    <p class="confirm-text" data-testid="manage-market-delete-consequence">
      This deletes the market with its applications, its assignments, its check-in records and the
      record of who changed what. It cannot be undone.
    </p>
    <p v-if="publicPages" class="confirm-text" data-testid="manage-market-delete-public">
      {{ publicPages }}
    </p>
  </AppDialog>
</template>

<style scoped>
/* The scrim, window, close control and width belong to `AppDialog`; the buttons and fields to
   `primitives.css`. What is left is this dialog's own list of people and organizations. */
.market-name {
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
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

/* The frame's rows here are cards, each with its border, so they keep the room between them. */
.users-list :deep(.list-frame__rows) {
  gap: var(--space-2);
}

.user-entry {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.user-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
  background: var(--mm-beige);
}

/* A floor, so a long role beside it (a long organization's name) takes a line of its own rather
   than squeezing the address into a sliver. */
.user-email {
  flex: 1;
  min-width: min(100%, 12rem);
  font-size: var(--text-sm);
  color: var(--mm-black);
  overflow-wrap: anywhere;
}

/* On a phone a member's address takes a line of its own, with the role and Remove beneath it:
   beside them, a long address was squeezed into a column a few letters wide, over four lines. */
@media (width <= 640px) {
  .user-email {
    flex-basis: 100%;
  }
}

/* A market role the organization's outranks: its own line beneath the address and the role. */
.user-also {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* On the card's beige, the muted ink that reaches AA there (4.23:1 for --mm-text-muted). */
.user-also-text {
  flex: 1;
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-text-muted-on-beige);
}

/* On a phone the line takes the row and its Remove goes beneath it, at the start, where every
   other row's Remove sits beside its role. */
@media (width <= 640px) {
  .user-also {
    flex-wrap: wrap;
  }

  .user-also-text {
    flex-basis: 100%;
  }
}

/* A role "through" a long organization name wraps inside the card rather than running past it. */
.role-badge {
  display: inline-block;
  min-width: 0;
  padding: var(--space-hairline) var(--space-2);
  border-radius: var(--radius-control);
  font-weight: 400;
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

/* A role the caller may change is a select, not a badge pretending to be one. It used to be a
   badge wrapping a transparent select and a hand-drawn chevron, which is three things saying one. */
.role-select {
  width: auto;
  flex: 0 0 auto;
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

.role-editor,
.role-viewer {
  background: var(--mm-chip-positive);
  color: var(--mm-text-green);
}

.empty-state {
  color: var(--mm-text-muted);
  font-size: var(--text-sm);
  margin: 0;
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

/* On a phone the email field and the role each take a line of the invite row, with Send invitation
   and Cancel at the end of a line beneath them: beside them at 390 the field and the role were
   squeezed to 66px each, reading "User e" and "Edi" (T142), and beside the role alone the two
   buttons left Cancel a line of its own. */
@media (width <= 640px) {
  .add-user-form .add-org-row {
    flex-wrap: wrap;
  }

  .add-user-form input.field,
  .add-user-form .field--select {
    flex-basis: 100%;
  }

  .add-user-form .btn--primary {
    margin-left: auto;
  }
}

.org-line,
.section-line {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
}

/* The line keeps its distance from the button it explains. */
.section-line + .btn {
  margin-top: var(--space-3);
}

.add-org-row,
.rename-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.form-error {
  margin: 0;
  color: var(--mm-red);
  font-size: var(--text-xs);
}

.form-hint {
  margin: 0;
  color: var(--mm-text-muted);
  font-size: var(--text-xs);
}

/* After `.form-hint`, whose margin it overrides: the note keeps its distance from "Invite someone". */
.organization-people {
  margin-bottom: var(--space-3);
}

/* Underlined, as `.note a` is: told from its sentence by more than colour (WCAG 1.4.1). */
.organization-people a {
  color: var(--mm-text-link);
  text-decoration: underline;
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

.role-change-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
  color: var(--mm-black);
}
</style>
