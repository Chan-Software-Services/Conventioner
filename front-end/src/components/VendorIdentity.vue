<script setup lang="ts">
/**
 * A vendor, named: their name, with their address beneath it.
 *
 * Name primary, email secondary, and never name instead of email - two vendors can share a name,
 * while the address is unique, is what check-in matches on, and is what ties a vendor back to
 * their application.
 *
 * A vendor with no stored name renders as a single line holding their address, which is exactly
 * what every one of these surfaces showed before names existed. That is deliberate: this ships
 * without making any existing market look worse, and nobody is labelled "Unnamed vendor".
 *
 * WHICH name this is - the one they chose, or the one on their identification - is decided once by
 * `display_name` in `back-end/essential_fields.py`, beside the contract that defines both keys,
 * and handed here already resolved (E19/F02/S01). The review card is the one surface that shows
 * both, labelled: deciding about a person is not the same as scanning a list.
 *
 * The address, and a headline that is the address, are drawn by `EmailAddress`, so a column too
 * narrow for them breaks them before the "@" or a dot: drawn as plain text, the door's rows broke
 * them after a hyphen and inside the domain (T318).
 *
 * Given `business`, the name they trade under (T502), it is a line of its own between the two,
 * small and muted as the address is: one line, cut with an ellipsis where the identity has no more
 * room, its whole text in its `title`. It is never the name a vendor is called by, and a vendor
 * with none has no such line.
 */
import { computed } from 'vue';
import EmailAddress from '@/components/EmailAddress.vue';
import { vendorHeadline, vendorName, type VendorNames } from '@/utils/vendorIdentity';

const props = defineProps<{
  email: string | null | undefined;
  names: VendorNames;
  /** Their business name, or none: a surface with room for a third line gives it (Attendance). */
  business?: string;
}>();

const headline = computed(() => vendorHeadline(props.email, props.names));
const named = computed(() => vendorName(props.email, props.names) !== '');
const trades = computed(() => (props.business ?? '').trim());
</script>

<template>
  <span class="vendor-identity" data-testid="vendor-identity">
    <span class="vendor-identity-name" data-testid="vendor-identity-name"
      ><EmailAddress :words="headline"
    /></span>
    <span
      v-if="trades"
      class="vendor-identity-business"
      data-testid="vendor-identity-business"
      :title="trades"
      >{{ trades }}</span
    >
    <span v-if="named" class="vendor-identity-email" data-testid="vendor-identity-email"
      ><EmailAddress :words="email ?? ''"
    /></span>
  </span>
</template>

<style scoped>
.vendor-identity {
  display: inline-flex;
  flex-direction: column;
  min-width: 0;
  /* No wider than the cell it stands in, so the business name has a width to be cut at. */
  max-width: 100%;
}

.vendor-identity-name {
  overflow-wrap: anywhere;
}

/* One line, ending in an ellipsis where it is cut, but breakable anywhere, so its narrowest is a
   character and its widest the whole name: it widens the identity up to the cell's width and
   never asks a row for more, where an unbreakable line (`white-space: nowrap`) made the vendor as
   wide as their business name and sent a phone row's button to a line of its own. */
.vendor-identity-business {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  overflow: hidden;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
  word-break: break-all;
}

.vendor-identity-email {
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
  overflow-wrap: anywhere;
}
</style>
