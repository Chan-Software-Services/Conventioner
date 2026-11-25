import { computed, type Ref } from 'vue';
import { api, getApiErrorMessage } from '@/utils/api';
import { fetchMarketApplications } from '@/utils/applicantApi';
// One rendering of an answer for the drawer, its dialog and the review card alike (E41/F01/S01).
import {
  ESSENTIAL_KEY_PREFIX,
  FULL_NAME_KEY,
  answerText,
  applicantName,
} from '@/utils/essentialFields';
import { getFormattedDate } from '@/utils/utils';
import { useServerRead } from '@/utils/useServerRead';
import { datesTheyNeed } from '@/utils/datesWithinReach';
import { addedLine, verdictLine } from '@/utils/verdicts';
import { priceLine } from '@/utils/pricing';
import {
  overrideIndex,
  reasonIndex,
  type OverriddenPlacement,
  type PlacementOverride,
  type PlacementReason,
  type UnplacedDate,
} from '@/utils/placementReason';
import type { VendorNames } from '@/utils/vendorIdentity';
import type {
  AnswerUpdate,
  Application,
  ApplicationStatus,
  Market,
  MarketDateObject,
  ReviewState,
  TableShareNotice as TableShareNoticeData,
} from '@/assets/types/datatypes';

interface AssignmentStatisticsResponse {
  unassignedVendors?: unknown[];
  unplacedDates?: UnplacedDate[];
  overriddenPlacements?: OverriddenPlacement[];
}

export interface MarketTableRowResponse {
  date: string;
  assignment: string[];
  location: string;
  section: string;
  tableChoice: string;
  tableCode: string;
  tier: string;
  /** Each occupant's price for this table-day, in cents, and the Pricing card's row that set it:
   *  a group's name, "Everyone else" on a card with groups, null on one without; none where it is
   *  unpriced (E43/F01/S01, S02). */
  prices?: { email: string; cents: number; group?: string | null }[];
}

export interface VendorTableAssignment {
  tableCode: string;
  tableChoice: string;
  section: string;
  tier: string;
  location: string;
  /** What this assignment costs for its day, in cents, or null where the market prices nothing. */
  priceCents: number | null;
  /** The price group that set it, or null where the card has no groups (E43/F01/S02). */
  priceGroup: string | null;
}

/** One vendor as the Vendors list and the vendor drawer read them: their application and seats. */
export interface VendorRow {
  rowIndex: number;
  /** Their application, which "Update info" writes to (E41/F01/S01). */
  applicationId: string;
  email: string;
  displayEmail: string;
  assignmentsByDate: Map<string, VendorTableAssignment>;
  isAssigned: boolean;
  assignedDateCount: number;
  /**
   * The dates they need a table on: their own answers, within the market's ceiling; every market
   * day for a vendor added by hand (E38/F08/S02).
   */
  reachableDateCount: number;
  /**
   * Every answer, keyed by field key, an organizer's update read in its place (E41/F01/S01); the
   * drawer shows the organizer's own questions.
   */
  answers: Record<string, unknown>;
  /** The answers an organizer updated: who, when, and what the vendor wrote. */
  answerUpdates: Record<string, AnswerUpdate>;
  /** Why their table-share request pairs nobody, when it does not (E27/F01/S03). */
  tableShareNotice: TableShareNoticeData | null;
  /** Who gave their verdict, and when (E34/F01/S01); null where nobody was recorded. */
  verdict: string | null;
  /**
   * Whether they need a table, as the server says (E38/F08/S02): the run's own, and a vendor added
   * by hand, who is out of the run and unassigned like anyone until seated.
   */
  needsATable: boolean;
  /** Their application's status, whose label the Vendors list shows for anyone outside the run. */
  status: ApplicationStatus;
  /** Their review state as the server serves it (ADR 0037), which "Rejected only" reads. */
  reviewState: ReviewState;
  /**
   * Added by hand and never applied (E36/F03/S01), as the server serves their origin: outside the
   * run, though approved. One whose answers arrived since, by an import or their own save, is an
   * applicant like any other (T277 P7), though the drawer still says who added them.
   */
  added: boolean;
}

/** One of the organizer's own questions as the drawer lists it. */
export interface SubmittedAnswer {
  key: string;
  label: string;
  value: string;
  /** An organizer's update of it, or null where the answer is the vendor's own. */
  update: AnswerUpdate | null;
}

function extractEmail(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  const obj = raw as { email?: unknown; vendorEmail?: unknown; vendor_email?: unknown };
  const candidate = obj.email ?? obj.vendorEmail ?? obj.vendor_email;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function assignmentSummary(assignment: VendorTableAssignment): string {
  const choice = assignment.tableChoice ? ` (${assignment.tableChoice})` : '';
  const parts = [`${assignment.tableCode || 'No table'}${choice}`];
  const meta = [assignment.section, assignment.tier, assignment.location]
    .filter((s) => !!s && s.trim().length > 0)
    .join(', ');
  if (meta) parts.push(meta);
  return parts.join(' - ');
}

/** One vendor on one date, as the reason and override indexes key them. */
const vendorOnDate = (email: string, date: string) => `${email.trim().toLowerCase()}|${date}`;

/** One occupant's price on a table row and the card's row that set it, by their lowercased address. */
function priceOf(row: MarketTableRowResponse, address: string) {
  const price = row.prices?.find((each) => each.email.trim().toLowerCase() === address);
  return { priceCents: price?.cents ?? null, priceGroup: price?.group ?? null };
}

/** Where every vendor sits, as the placements reads say it. */
interface Placements {
  tableRows: MarketTableRowResponse[];
  /** The names the tables read gave, the server's `display_name` of each vendor it knows. */
  servedNames: VendorNames;
  /**
   * Who needs a table: the run's own and the vendors added by hand (E38/F08/S02). The tables read
   * serves every applicant (E36/F02/S02) and says it of each.
   */
  needingATable: Set<string>;
  unplacedReasons: Map<string, PlacementReason>;
  placementOverrides: Map<string, PlacementOverride[]>;
  unassignedEmails: Set<string>;
}

/** One read of a market's vendors: the applications, and where each sits or why that was refused. */
interface VendorDetailsRead {
  applications: Application[];
  placements: Placements | null;
  /** Why the placements could not be read, said beside the applications that were (T123). */
  placementsRefusal: string;
}

/**
 * The applications, and where each vendor sits, read side by side but standing apart (T123).
 *
 * One `Promise.all` once emptied all three on any refusal: an approved application with incomplete
 * answers made the server refuse the two assignment reads, until T139, and the drawer then said a
 * market with questions "asks no questions of its own". A refused placements read now lands with
 * the applications, the server's reason in `placementsRefusal`; a refused applications read fails
 * the whole read.
 */
async function readVendorDetails(id: string): Promise<VendorDetailsRead> {
  const encoded = encodeURIComponent(id);
  const placements = Promise.all([
    api.get<AssignmentStatisticsResponse>(`/markets/${encoded}/assignment-statistics`),
    api.get<{
      rows: MarketTableRowResponse[];
      vendorNames: VendorNames;
      vendors?: { email: string; needsATable: boolean }[];
    }>(`/markets/${encoded}/tables`),
  ]);
  const [applicationsRead, placementsRead] = await Promise.allSettled([
    fetchMarketApplications(id),
    placements,
  ]);
  if (applicationsRead.status === 'rejected') throw applicationsRead.reason;
  const applications = Array.isArray(applicationsRead.value) ? applicationsRead.value : [];
  if (placementsRead.status === 'rejected') {
    return {
      applications,
      placements: null,
      placementsRefusal: getApiErrorMessage(
        placementsRead.reason,
        'Where the vendors sit could not be read.',
      ),
    };
  }
  const [statsResp, tablesResp] = placementsRead.value;
  const statsList = statsResp.data?.unassignedVendors ?? [];
  return {
    applications,
    placements: {
      tableRows: Array.isArray(tablesResp.data?.rows) ? tablesResp.data.rows : [],
      servedNames: tablesResp.data?.vendorNames ?? {},
      needingATable: new Set(
        (tablesResp.data?.vendors ?? [])
          .filter((vendor) => vendor.needsATable)
          .map((vendor) => vendor.email.trim().toLowerCase()),
      ),
      unplacedReasons: reasonIndex(statsResp.data?.unplacedDates ?? []),
      placementOverrides: overrideIndex(statsResp.data?.overriddenPlacements ?? []),
      unassignedEmails: new Set(
        statsList.map((item) => extractEmail(item).toLowerCase()).filter(Boolean),
      ),
    },
    placementsRefusal: '',
  };
}

export interface VendorDetailsOptions {
  /**
   * Read only when asked (`load`), as the drawer reads on opening: true by default. A screen that
   * lists the vendors, Vendors and Payments, reads on arriving at each market.
   */
  lazy?: boolean;
}

/**
 * A market's vendors, each with their application and their seats (E35/F01/S01): what the Vendors
 * list reads, and what the vendor drawer shows wherever it opens - from a seat, at the door, in
 * review. One loader, so the list and the drawer never read a vendor differently.
 *
 * Every application is kept, decided or not: the drawer opens on an applicant still in review. The
 * Vendors list counts the vendors who need a table (`needsATable`), as the server says of each.
 *
 * One keyed read (`useServerRead`, T421): a move to another market drops what was held in the same
 * tick, and an answer for the market left, or one a newer read overtook, never lands.
 */
export function useVendorDetails(
  marketId: Ref<string>,
  market: Ref<Market | null | undefined>,
  options: VendorDetailsOptions = {},
) {
  const read = useServerRead<string, VendorDetailsRead>(
    () => marketId.value || null,
    readVendorDetails,
    {
      failure: 'The vendors could not be loaded.',
      // A failed re-read keeps the vendors as last read, so it never says they were not loaded.
      refreshFailure: 'Could not update. The vendors are as they were last read.',
      lazy: options.lazy ?? true,
    },
  );

  const applications = computed<Application[]>(() => read.data.value?.applications ?? []);
  const placements = computed(() => read.data.value?.placements ?? null);
  const tableRows = computed<MarketTableRowResponse[]>(() => placements.value?.tableRows ?? []);
  const isLoading = computed(
    () => read.phase.value === 'loading' || read.phase.value === 'refreshing',
  );
  /** Whether the vendors of this market were read: the applications are held. */
  const loaded = computed(() => read.data.value !== null);
  /** The read's failure, or why where the vendors sit was refused beside the applications read. */
  const loadError = computed(() => read.sentence.value || read.data.value?.placementsRefusal || '');
  /** Whether the last read had where every vendor sits: the tables and the statistics. */
  const placementsRead = computed(() => placements.value !== null);

  /**
   * What to call each vendor: the name their application gives (`applicantName`, the client's
   * reading of `display_name`), then the server's, which wins where it has one. From the
   * applications too, so a refused placements read keeps every name (T123): the drawer's title, the
   * rows and the search by name.
   */
  const vendorNames = computed<VendorNames>(() => {
    const names: Record<string, string> = {};
    for (const application of applications.value) {
      const email = (application.applicantEmail ?? '').trim().toLowerCase();
      const name = applicantName(application.formData as Record<string, unknown> | undefined);
      if (email && name) names[email] = name;
    }
    return { ...names, ...placements.value?.servedNames };
  });

  /** The name on each vendor's identification, which a search finds as well (`vendorMatches`). */
  const legalNames = computed<VendorNames>(() => {
    const names: Record<string, string> = {};
    for (const application of applications.value) {
      const email = (application.applicantEmail ?? '').trim().toLowerCase();
      const name = String(application.formData?.[FULL_NAME_KEY] ?? '').trim();
      if (email && name) names[email] = name;
    }
    return names;
  });

  /** Read the market's vendors, or again: resolves when this read lands, fails or is overtaken. */
  function load(): Promise<void> {
    return read.reread();
  }

  const marketDates = computed<MarketDateObject[]>(
    () => market.value?.setupObject?.marketDates ?? [],
  );

  const assignmentsByEmail = computed(() => {
    const map = new Map<string, Map<string, VendorTableAssignment>>();
    for (const row of tableRows.value) {
      if (!Array.isArray(row.assignment)) continue;
      for (const email of row.assignment) {
        const address = String(email ?? '')
          .trim()
          .toLowerCase();
        if (!address) continue;
        const inner = map.get(address) ?? new Map<string, VendorTableAssignment>();
        map.set(address, inner);
        inner.set(row.date, {
          tableCode: row.tableCode,
          tableChoice: row.tableChoice,
          section: row.section,
          tier: row.tier,
          location: row.location,
          ...priceOf(row, address),
        });
      }
    }
    return map;
  });

  const rows = computed<VendorRow[]>(() =>
    applications.value.map((application, index) => {
      const emailRaw = (application.applicantEmail ?? '').trim();
      const email = emailRaw.toLowerCase();
      const assignmentsByDate =
        assignmentsByEmail.value.get(email) ?? new Map<string, VendorTableAssignment>();
      const answers = (application.formData ?? {}) as Record<string, unknown>;
      const added = application.origin === 'added';
      return {
        rowIndex: index,
        applicationId: application.id,
        email,
        displayEmail: emailRaw || `Applicant ${index + 1}`,
        assignmentsByDate,
        isAssigned: !placements.value?.unassignedEmails.has(email) && assignmentsByDate.size > 0,
        assignedDateCount: assignmentsByDate.size,
        // A hand placement can give more than they asked for; never read as "3 of 2".
        reachableDateCount: Math.max(
          assignmentsByDate.size,
          datesTheyNeed(
            { answers, added },
            marketDates.value.map((d) => d.date),
            market.value?.setupObject?.assignmentOptions?.maxAssignmentsPerVendor,
          ),
        ),
        answers,
        answerUpdates: application.answerUpdates ?? {},
        tableShareNotice: application.tableShareNotice ?? null,
        // Someone added by hand says so, in place of a verdict nobody reviewed (E36/F03/S01).
        verdict: addedLine(application) ?? verdictLine(application),
        needsATable: placements.value?.needingATable.has(email) ?? false,
        status: application.status,
        reviewState: application.review.state,
        added,
      };
    }),
  );

  function rowFor(email: string): VendorRow | null {
    const address = email.trim().toLowerCase();
    return rows.value.find((row) => row.email === address) ?? null;
  }

  /**
   * The organizer's own questions, in the order their form asks them, as this vendor answered, each
   * update in its place with who made it and what the vendor wrote (E41/F01/S01).
   */
  function submission(row: VendorRow): SubmittedAnswer[] {
    return (market.value?.applicationForm?.fields ?? [])
      .filter((field) => !field.key.startsWith(ESSENTIAL_KEY_PREFIX))
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((field) => {
        const update = row.answerUpdates[field.key];
        return {
          key: field.key,
          label: field.label || field.key,
          value: answerText(row.answers[field.key]) || 'Not answered',
          update: update ?? null,
        };
      });
  }

  /** Where they were placed on this date, or null - which is what makes the card's state. */
  function placementOn(row: VendorRow, date: string): string | null {
    const assignment = row.assignmentsByDate.get(date);
    return assignment ? assignmentSummary(assignment) : null;
  }

  /** What their assignment that day costs, as its date card says it: "Gold, full table, $35.00", with
   * the price group where the card has groups; null where they hold none or the market prices nothing. */
  function priceOn(row: VendorRow, date: string): string | null {
    const assignment = row.assignmentsByDate.get(date);
    const currency = market.value?.setupObject?.pricing?.currency ?? 'CAD';
    return assignment ? priceLine(assignment, currency) : null;
  }

  /** Why they hold no table that day, as the server computed it; absent where they have one. */
  function reasonFor(email: string, date: string): PlacementReason | undefined {
    return placements.value?.unplacedReasons.get(vendorOnDate(email, date));
  }

  /** What their placement that day overrides, when it was made by hand and contradicts them. */
  function overridesFor(email: string, date: string): PlacementOverride[] | undefined {
    return placements.value?.placementOverrides.get(vendorOnDate(email, date));
  }

  function isOrphaned(email: string, date: string): boolean {
    const target = email.trim().toLowerCase();
    return (market.value?.orphanedPins ?? []).some(
      (pin) => pin.date === date && pin.email.trim().toLowerCase() === target,
    );
  }

  return {
    applications,
    tableRows,
    vendorNames,
    legalNames,
    isLoading,
    loaded,
    loadError,
    placementsRead,
    load,
    marketDates,
    rows,
    rowFor,
    submission,
    placementOn,
    priceOn,
    reasonFor,
    overridesFor,
    isOrphaned,
  };
}

export type VendorDetails = ReturnType<typeof useVendorDetails>;

/** A market date as the drawer's assignment cards label it. */
export function dateLabel(date: string): string {
  return getFormattedDate(date) ?? date;
}
