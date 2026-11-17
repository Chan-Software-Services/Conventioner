<script setup lang="ts">
/**
 * What the public map says of the table picked (T422, T465): its code in a pill of its section's
 * colours and the hall it stands in, and each part of it, the whole table or its left and right
 * halves, with the vendor's public name, website and Instagram as pill links, or that the part is
 * free on the day, or that a vendor sits there unnamed; and a close button, heard as `close`.
 *
 * It is a region named by its heading, "Table <code>" to a reader, the code alone shown. It is no
 * dialog: it holds nothing modal and traps no focus. The page stands it in the speech bubble at a
 * desk and at the vendor panel's top on anything narrower, and keeps the live region round it.
 *
 * Nothing a vendor typed is rendered as markup: their three answers are text, and a link is built
 * from them only as an `http`/`https` address or an Instagram handle.
 */
import { useId } from 'vue';
import IconCloseRound from '@/components/icons/IconCloseRound.vue';
import {
  DETAILS_NOT_LISTED,
  freeHalfOn,
  freeTableOn,
  instagramLink,
  websiteLink,
  type TableCard,
} from '@/utils/publicMap';
import type { TablePaint } from './publicMapPaint';

defineProps<{
  /** The table picked, its halves already narrowed to what is shown. */
  card: TableCard;
  /** The open day, in words (`dayInWords`). */
  day: string;
  /** The name of the hall the table stands in. */
  hallName: string;
  /** The table's section colours, or null for a table in no section. */
  paint: TablePaint | null;
}>();

const emit = defineEmits<{
  /** Close pressed. */
  close: [];
}>();

const headingId = `public-map-card-${useId()}`;

const HALF_NAMES = { left: 'Left half', right: 'Right half' } as const;
</script>

<template>
  <section class="public-map-card" :aria-labelledby="headingId" data-testid="public-map-card">
    <div class="public-map-card__head">
      <h2 :id="headingId" class="public-map-card__title">
        <span class="visually-hidden">Table </span>
        <span
          class="public-map-card__code"
          :style="paint ? { background: paint.fill, borderColor: paint.edge } : undefined"
          data-testid="public-map-card-code"
          >{{ card.code }}</span
        >
      </h2>
      <p class="public-map-card__hall">{{ hallName }}</p>
      <button
        type="button"
        class="public-map-card__close"
        aria-label="Close"
        data-testid="public-map-card-close"
        @click="emit('close')"
      >
        <IconCloseRound aria-hidden="true" />
      </button>
    </div>
    <div
      v-for="part in card.halves"
      :key="part.side"
      class="public-map-card__part"
      :data-testid="part.side === 'whole' ? 'public-map-card-whole' : 'public-map-card-half'"
    >
      <h3 v-if="part.side !== 'whole'" class="public-map-card__half">
        {{ HALF_NAMES[part.side] }}
      </h3>
      <p v-if="!part.seat" class="public-map-card__note">
        {{ part.side === 'whole' ? freeTableOn(day) : freeHalfOn(day) }}
      </p>
      <p v-else-if="!part.seat.name" class="public-map-card__note">
        {{ DETAILS_NOT_LISTED }}
      </p>
      <template v-else>
        <p class="public-map-card__name" data-testid="public-map-card-name">
          {{ part.seat.name }}
        </p>
        <!-- The address and the handle say which link is which: their kind is a reader's alone. -->
        <dl
          v-if="websiteLink(part.seat.website) || instagramLink(part.seat.instagram)"
          class="public-map-card__links"
        >
          <template v-if="websiteLink(part.seat.website)">
            <dt class="visually-hidden">Website</dt>
            <dd>
              <a
                :href="websiteLink(part.seat.website)!.href"
                target="_blank"
                rel="noopener noreferrer"
                class="public-map-card__link"
                data-testid="public-map-card-website"
                >{{ websiteLink(part.seat.website)!.text }}</a
              >
            </dd>
          </template>
          <template v-if="instagramLink(part.seat.instagram)">
            <dt class="visually-hidden">Instagram</dt>
            <dd>
              <a
                :href="instagramLink(part.seat.instagram)!.href"
                target="_blank"
                rel="noopener noreferrer"
                class="public-map-card__link"
                data-testid="public-map-card-instagram"
                >{{ instagramLink(part.seat.instagram)!.text }}</a
              >
            </dd>
          </template>
        </dl>
      </template>
    </div>
  </section>
</template>

<style scoped>
.public-map-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  overflow-wrap: anywhere;
}

/* The code pill and the hall on one line, the close button at its end. */
.public-map-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.public-map-card__title {
  display: flex;
  margin: 0;
  font-size: var(--text-xs);
  font-weight: 600;
}

/* A table's code in its section's colours, as the map draws the table: the floor's grey for a
   table in no section. */
.public-map-card__code {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: calc(var(--space-8) + var(--space-3));
  height: var(--space-6);
  padding-inline: var(--space-2);
  border: 1.5px solid var(--mm-border-soft);
  border-radius: var(--radius-pill);
  background: var(--layout-floor);
  color: var(--mm-black);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.public-map-card__hall {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

.public-map-card__close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  /* A tap target's least width, not a width for words: 44px on a phone round a 16px cross. */
  min-width: var(--control-height-compact);
  height: var(--control-height-compact);
  margin-inline-start: auto;
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--mm-text-muted);
  cursor: pointer;
}

.public-map-card__close:hover {
  background: var(--layout-floor);
  color: var(--mm-black);
}

.public-map-card__close svg {
  width: var(--space-4);
  height: var(--space-4);
}

.public-map-card__note {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

.public-map-card__part {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.public-map-card__half {
  margin: var(--space-1) 0 0;
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--mm-text-muted);
}

.public-map-card__name {
  margin: 0;
  font-family: 'Merge One', sans-serif;
  font-size: var(--text-lg);
  line-height: 1.2;
}

/* The website and the Instagram as soft pills, each on a line of its own. */
.public-map-card__links {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
}

.public-map-card__links dd {
  max-width: 100%;
  margin: 0;
}

.public-map-card__link {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-height: var(--control-height-compact);
  padding: 0 var(--space-3);
  border: 1px solid var(--mm-border-soft);
  border-radius: var(--radius-pill);
  color: var(--mm-black);
  font-size: var(--text-xs);
  text-decoration: none;
}

.public-map-card__link:hover {
  border-color: var(--layout-section-4-edge);
  background: var(--layout-section-4-fill);
}
</style>
