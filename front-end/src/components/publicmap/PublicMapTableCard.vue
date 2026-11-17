<script setup lang="ts">
/**
 * What the public map says of the table picked (T422, T465): its code, and each part of it, the
 * whole table or its left and right halves, with the vendor's public name, website and Instagram,
 * or that the part is free on the day, or that a vendor sits there unnamed.
 *
 * Nothing a vendor typed is rendered as markup: their three answers are text, and a link is built
 * from them only as an `http`/`https` address or an Instagram handle.
 */
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
  /** The table's section colours, or null while the page passes none. */
  paint: TablePaint | null;
}>();

const HALF_NAMES = { left: 'Left half', right: 'Right half' } as const;
</script>

<template>
  <h2 class="public-map-card__title">Table {{ card.code }}</h2>
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
      <dl
        v-if="websiteLink(part.seat.website) || instagramLink(part.seat.instagram)"
        class="public-map-card__links"
      >
        <template v-if="websiteLink(part.seat.website)">
          <dt>Website</dt>
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
          <dt>Instagram</dt>
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
</template>

<style scoped>
.public-map-card__note {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

.public-map-card__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}

.public-map-card__part {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.public-map-card__half {
  margin: 0;
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--mm-text-muted);
}

.public-map-card__name {
  margin: 0;
  font-weight: 600;
}

.public-map-card__links {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin: 0;
  font-size: var(--text-sm);
}

.public-map-card__links dt {
  color: var(--mm-text-muted);
}

.public-map-card__links dd {
  margin: 0;
  min-width: 0;
}

.public-map-card__link {
  color: var(--mm-text-link);
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* Each link stands alone on its line, so on a phone it is a thumb's target, its name level with
   its middle, as an answer that is only an address is (`AnswerValue.vue`). */
@media (width <= 640px) {
  .public-map-card__links {
    align-items: center;
  }

  .public-map-card__link {
    display: inline-flex;
    align-items: center;
    min-height: var(--target-min);
  }
}
</style>
