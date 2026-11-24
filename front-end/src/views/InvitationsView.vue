<script setup lang="ts">
/**
 * The Invitations page, `/invitations` (T538, ADR 0047): every invitation waiting for the signed-in
 * address, each accepted or declined in its own row. The invitation's email links here, and so does
 * the Markets list's line when any wait.
 *
 * Only invitations sent to the signed-in address are listed, so a forwarded email lets nobody else
 * answer one. A row answered keeps its place until the page is left or read again.
 */
import { onMounted, ref } from 'vue';
import type { Invitation } from '@/assets/types/datatypes';
import { getApiErrorMessage } from '@/utils/api';
import { fetchInvitations } from '@/utils/invitations';
import InvitationRow from '@/components/InvitationRow.vue';
import ReadFailed from '@/components/ReadFailed.vue';

const invitations = ref<Invitation[]>([]);
const loading = ref(true);
const errorMessage = ref('');

async function read() {
  loading.value = true;
  errorMessage.value = '';
  try {
    invitations.value = await fetchInvitations();
  } catch (error) {
    errorMessage.value = getApiErrorMessage(error, 'Could not read your invitations.');
    invitations.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void read();
});
</script>

<template>
  <div class="invitations-view">
    <div class="header">
      <h1>Invitations</h1>
    </div>

    <div class="content-block">
      <p v-if="loading" class="empty-state" data-testid="invitations-loading">
        Loading invitations…
      </p>
      <ReadFailed
        v-else-if="errorMessage"
        name="invitations"
        :message="errorMessage"
        @retry="read"
      />
      <p v-else-if="invitations.length === 0" class="empty-state" data-testid="invitations-none">
        No invitations are waiting for you.
      </p>
      <ul v-else class="invitations-list" data-testid="invitations-list">
        <InvitationRow
          v-for="invitation in invitations"
          :key="invitation.id"
          :invitation="invitation"
        />
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* The list column Markets and Organizations stand in, its gutter narrowing on a phone as theirs
   does. */
.invitations-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: var(--list-max);
  margin: 0 auto;
  padding: var(--space-8);
}

@media (width <= 640px) {
  .invitations-view {
    padding: var(--space-4);
  }
}

.header {
  padding-bottom: var(--space-6);
  border-bottom: 1px solid var(--mm-border);
}

.header h1 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--mm-black);
}

.content-block {
  padding-top: var(--space-6);
}

.empty-state {
  margin: 0;
  color: var(--mm-text-muted);
  font-size: var(--text-sm);
}

.invitations-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
