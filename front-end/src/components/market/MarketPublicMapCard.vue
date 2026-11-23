<script setup lang="ts">
/**
 * The Public map card, on the market's Tools tab, after Discord's (T422, D25, D26, D30).
 *
 * The public map is a page anyone may open at the market's own address, `/<slug>`, with no sign-in
 * (T469): once the map is open it is what the market page shows. It draws each market
 * day's tables and who is at them. It publishes three answers of each vendor and nothing else of
 * them (ADR 0035): the form's short text questions an Admin points at here for the public name,
 * the website and the Instagram handle. The public name may also be the built-in business name
 * every form asks (T502, ADR 0042), offered first, so a form with no short text question can still
 * open its map. The switch turns it on, and only once a name is chosen.
 *
 * Each choice saves as it is made through `PUT /markets/<id>/public-map`, and the page reads the
 * market again (`changed`), never patching it; a refusal is said on the card's error line and the
 * control goes back to what is stored, as Discord's card does. Whether this person may change it
 * is the table's "Publish the map" row: anyone it refuses reads the same controls, disabled, with
 * the row's sentence, and an archived market says its map is closed instead.
 *
 * The map answers only while the server's gate holds (`public_map_market_by_slug`); the card says
 * the first of what the market still lacks for it, in the gate's order: a location laid out as the
 * map draws it (`mapped_locations` in `back-end/public_map.py`), then its results out.
 */
import { computed, ref } from 'vue';
import ChoiceField from '@/components/ChoiceField.vue';
import ElementSettingContainer from '@/components/elements/ElementSettingContainer.vue';
import { api, getApiErrorMessage } from '@/utils/api';
import { formTextQuestions } from '@/utils/discordQuestion';
import { BUSINESS_NAME_KEY, BUSINESS_NAME_LABEL } from '@/utils/essentialFields';
import { layoutPath, marketPagePath } from '@/utils/market';
import { MarketAction, actionRefusal } from '@/utils/marketActions';
import { useCopyAddress } from '@/utils/useCopyAddress';
import { vendorsWereTold } from '@/utils/vendorPage';
import { MarketPhase, type Market, type PublicMapSettings } from '@/assets/types/datatypes';
import type { PickerGroup } from '@/components/SearchPicker.vue';

const props = defineProps<{ market: Market }>();
const emit = defineEmits<{ (event: 'changed'): void }>();

const NOT_SHOWN = 'Not shown';

const settings = computed<PublicMapSettings>(
  () =>
    props.market.publicMap ?? {
      enabled: false,
      nameQuestion: null,
      websiteQuestion: null,
      instagramQuestion: null,
    },
);
const archived = computed(() => props.market.phase === MarketPhase.Archived);
const refusal = computed(() => actionRefusal(props.market, MarketAction.PublishMap));
const editable = computed(() => refusal.value === null);

/** The card's three questions, each by the setting it is stored as. */
type Question = 'nameQuestion' | 'websiteQuestion' | 'instagramQuestion';

const textQuestions = computed(() => formTextQuestions(props.market));
const textOptions = computed(() =>
  textQuestions.value.map((field) => ({ value: field.key, label: field.label })),
);
/** What the public name may be read from: the built-in business name first, then the form's short
 * text questions, the server's `name_questions`. The website and the Instagram handle are the
 * form's questions only. */
const nameOptions = computed(() => [
  { value: BUSINESS_NAME_KEY, label: `${BUSINESS_NAME_LABEL} (built in)` },
  ...textOptions.value,
]);
const offered = (setting: Question) =>
  setting === 'nameQuestion' ? nameOptions.value : textOptions.value;
const groups = (setting: Question): PickerGroup[] => [{ options: offered(setting) }];
const QUESTIONS: Array<{ setting: Question; id: string; label: string }> = [
  { setting: 'nameQuestion', id: 'name', label: 'Public name' },
  { setting: 'websiteQuestion', id: 'website', label: 'Website' },
  { setting: 'instagramQuestion', id: 'instagram', label: 'Instagram' },
];

/** A stored question while the setting may still name it; one the form lost reads as none, as
 * the server reads it (`chosen_question`). */
function held(setting: Question): string {
  const key = settings.value[setting];
  return key && offered(setting).some((option) => option.value === key) ? key : '';
}

const nameChosen = computed(() => held('nameQuestion') !== '');
/** Off with no name chosen, the switch cannot be turned on; on, it can always be turned off. */
const switchDisabled = computed(
  () => !editable.value || (!settings.value.enabled && !nameChosen.value),
);

const saveError = ref<string | null>(null);

/** Save one change; a refused one was never the market's, so `goBack` shows what is stored. */
async function save(change: Partial<PublicMapSettings>, goBack: () => void): Promise<void> {
  saveError.value = null;
  try {
    await api.put(`/markets/${encodeURIComponent(props.market.id)}/public-map`, change);
    emit('changed');
  } catch (err) {
    saveError.value = getApiErrorMessage(err, 'This change was not saved.');
    goBack();
  }
}

const fields = ref<Partial<Record<Question, InstanceType<typeof ChoiceField> | null>>>({});

function onQuestion(setting: Question, key: string): void {
  if (key === held(setting)) return;
  void save({ [setting]: key || null }, () => fields.value[setting]?.showHeld());
}

const switchInput = ref<HTMLInputElement | null>(null);

function onSwitch(event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked;
  void save({ enabled }, () => {
    if (switchInput.value) switchInput.value.checked = settings.value.enabled;
  });
}

/**
 * Whether a location is laid out as the map draws it, the server's `mapped_locations`: its layout
 * has a scale, and a table numbered in one of the location's own sections.
 */
const laidOut = computed(() => {
  const plan = props.market.setupObject;
  return (plan?.locations ?? []).some((location) => {
    const layout = plan?.floorplans?.find((each) => each.locationId === location.id);
    if (!layout?.scalePxPerUnit || layout.scalePxPerUnit <= 0) return false;
    const sections = new Set(
      (plan?.sections ?? [])
        .filter((section) => section.location?.id === location.id && section.id)
        .map((section) => section.id),
    );
    return layout.tables.some(
      (table) => table.sectionId && sections.has(table.sectionId) && table.number !== null,
    );
  });
});

/** The first thing the map still lacks before it can open, or null. */
const missing = computed<'archived' | 'layout' | 'results' | null>(() => {
  if (archived.value) return 'archived';
  if (!laidOut.value) return 'layout';
  if (!vendorsWereTold(props.market)) return 'results';
  return null;
});

/** The map's address: the market page's, `/<slug>`, as the rail's "Market page" builds it, which
 * shows the map once it is open (D31, T469). */
const mapUrl = computed(() =>
  props.market.slug ? `${window.location.origin}${marketPagePath(props.market.slug)}` : '',
);
const { copied, copy } = useCopyAddress();
</script>

<template>
  <ElementSettingContainer class="card-grid__wide" data-testid="plan-card-public-map">
    <template #setting-title>
      <h2>Public map</h2>
    </template>
    <template #setting-content>
      <div class="public-map-card">
        <p class="public-map-lead" data-testid="public-map-lead">
          A page anyone can open, with no sign-in, that shows each market day’s tables and who is at
          them. It shows only the answers you choose here, never an email address or a full name.
        </p>

        <p v-if="refusal && !archived" class="public-map-hint" data-testid="public-map-refusal">
          {{ refusal }}
        </p>

        <div class="public-map-choices">
          <div v-for="question in QUESTIONS" :key="question.setting" class="public-map-choice">
            <ChoiceField
              :ref="
                (field) => (fields[question.setting] = field as InstanceType<typeof ChoiceField>)
              "
              :model-value="held(question.setting)"
              :groups="groups(question.setting)"
              :label="question.label"
              :placeholder="NOT_SHOWN"
              :none-row="NOT_SHOWN"
              :testid="`public-map-${question.id}-select`"
              :field-id="`public-map-${question.id}`"
              :disabled="!editable"
              :described-by="question.id === 'name' ? 'public-map-name-help' : undefined"
              writes
              @update:model-value="onQuestion(question.setting, $event)"
            />
            <p
              v-if="question.id === 'name'"
              id="public-map-name-help"
              class="public-map-hint"
              data-testid="public-map-name-help"
            >
              The built-in business name, or a form question that holds it.
            </p>
          </div>
          <p
            v-if="!textQuestions.length"
            class="public-map-hint public-map-wide"
            data-testid="public-map-no-questions"
          >
            The form asks no short text question yet. Add one to show each vendor’s website or
            Instagram handle.
          </p>
        </div>

        <div class="public-map-switch">
          <label class="public-map-tick" for="public-map-switch">
            <input
              id="public-map-switch"
              ref="switchInput"
              type="checkbox"
              role="switch"
              :checked="settings.enabled"
              :disabled="switchDisabled"
              :aria-describedby="editable && !nameChosen ? 'public-map-switch-reason' : undefined"
              data-testid="public-map-switch"
              @change="onSwitch"
            />
            <span>Show the public map</span>
          </label>
          <p
            v-if="editable && !nameChosen"
            id="public-map-switch-reason"
            class="public-map-hint"
            data-testid="public-map-switch-reason"
          >
            Choose the public name’s question first.
          </p>
        </div>

        <p
          v-if="saveError"
          class="public-map-error"
          role="alert"
          data-testid="public-map-save-error"
        >
          {{ saveError }}
        </p>

        <p v-if="missing" class="public-map-lead" data-testid="public-map-missing">
          <template v-if="missing === 'archived'">An archived market’s map is closed.</template>
          <template v-else-if="missing === 'layout'">
            Lay out a location first: the map draws the market’s layouts.
            <RouterLink
              :to="layoutPath(market.id)"
              class="link-alone"
              data-testid="public-map-layout-link"
              >Open the layout</RouterLink
            >
          </template>
          <template v-else>The map opens once results are published.</template>
        </p>

        <div
          v-if="settings.enabled && mapUrl"
          class="public-map-address"
          data-testid="public-map-address"
        >
          <p class="public-map-url-line">
            <span class="field-label">Address</span>
            <span class="public-map-url" data-testid="public-map-url">{{ mapUrl }}</span>
          </p>
          <div class="public-map-address-actions">
            <button
              type="button"
              class="btn btn--secondary btn--compact"
              data-testid="public-map-copy"
              @click="copy(mapUrl)"
            >
              {{ copied === mapUrl ? 'Copied' : 'Copy link' }}
            </button>
            <a
              :href="mapUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn--secondary btn--compact"
              data-testid="public-map-open"
              >Open the map</a
            >
          </div>
        </div>
      </div>
    </template>
  </ElementSettingContainer>
</template>

<style scoped>
.public-map-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.public-map-lead,
.public-map-url-line {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
  line-height: 1.5;
}

/* The three choices stand in a row at a desk, as Discord's do, and one under another on a phone. */
.public-map-choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-4);
}

/* Under the whole row, at the grid's own gap from it. */
.public-map-hint.public-map-wide {
  grid-column: 1 / -1;
  margin-top: 0;
}

/* The first column's field stands near the window's left edge: past 12 questions its list runs
   right from the field, not left off the window. */
.public-map-choice:first-child
  :deep(.choice-field-picker.search-picker--list-over .search-picker-list) {
  right: auto;
  left: 0;
}

@media (width <= 640px) {
  .public-map-choices {
    grid-template-columns: minmax(0, 1fr);
  }

  .public-map-choice :deep(.choice-field-picker.search-picker--list-over .search-picker-list) {
    width: 100%;
  }
}

.public-map-tick {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--target-min);
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.public-map-tick:has(input:disabled) {
  color: var(--mm-text-muted);
}

.public-map-hint,
.public-map-error {
  margin: var(--space-1) 0 0;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

/* A refusal reads in red, whatever the card (the design language's Colour). */
.public-map-error {
  margin: 0;
  color: var(--mm-red);
}

.public-map-address {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
}

.public-map-url-line {
  min-width: 0;
}

/* The address on a line of its own under its label, as the Discord card's server name; a long slug
   breaks anywhere rather than running off a phone. */
.public-map-url {
  display: block;
  overflow-wrap: anywhere;
}

.public-map-address-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
