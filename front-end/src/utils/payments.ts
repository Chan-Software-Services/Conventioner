/**
 * A vendor's payments (E44/F01/S01): what they owe for each table-day, the payments an organizer
 * recorded, and how the two compare, as the drawer's Payment tab reads them.
 *
 * The back end is the authority: it prices each table-day from the seat the vendor holds, keeps the
 * line of a freed table, and adds up both totals (`back-end/payments.py`). This only reads, words
 * and records.
 */
import type { InjectionKey } from 'vue';
import { api, getApiErrorStatus } from '@/utils/api';
import { formatPrice } from '@/utils/pricing';
import { getTimestampDate } from '@/utils/utils';

/**
 * What a page showing payments provides to hear of a payment written from the drawer whose answer
 * came once the drawer's Payment tab was gone (closed, or another tab chosen), when no event can
 * reach it: Payments reads its totals again.
 */
export const PAYMENT_WRITTEN: InjectionKey<() => void> = Symbol('paymentWritten');

/** How the organizers take a payment (Daniel, T92 Q7), as the server names each. */
export const PAYMENT_METHODS: readonly { id: PaymentMethod; label: string }[] = [
  { id: 'e-transfer', label: 'E-transfer' },
  { id: 'cash', label: 'Cash' },
];

export type PaymentMethod = 'e-transfer' | 'cash';

/** One table-day: the seat, or the seat as it was freed, and what is owed for it. */
export interface PaymentLine {
  date: string;
  tableCode: string;
  tier: string;
  tableChoice: string;
  /** The price group that set its price (E43/F01/S02), "Everyone else", or null on a card with
   * no groups. */
  group?: string | null;
  /** What the pricing calculates for the seat; null where it has no price. */
  priceCents: number | null;
  /** What is owed for the day: the price, unless someone set it by hand. */
  owedCents: number | null;
  owedSetBy: string | null;
  owedSetAt: string | null;
  /** The amount was set by the free's "Also remove its $15.00 …?", which seating the day again
   * takes back, rather than by hand. */
  owedByFree?: boolean;
  /** The table was freed; the line stays, still owed (Q26). */
  freed: boolean;
  /** When and by whom it was freed; null for a seat held now. */
  freedAt: string | null;
  freedBy: string | null;
}

export interface Payment {
  id: string;
  /** A payment the vendor made, or a refund given back to them, whose `cents` is negative. */
  kind: 'payment' | 'refund';
  cents: number;
  method: PaymentMethod;
  /** The day it was paid, `YYYY-MM-DD`. */
  paidOn: string;
  note: string;
  recordedBy: string;
  recordedAt: string;
  /** The last edit, when it was edited (E44/F01/S02). */
  editedBy: string | null;
  editedAt: string | null;
  /** Taken out of the amount paid; it is kept, and shown so. */
  removedBy: string | null;
  removedAt: string | null;
}

/**
 * How what a vendor paid compares with what they owe, as the server reads it (`balance_state` in
 * `back-end/payments.py`), the one reading the Payment tab, the Payments page's lists and the
 * export's payment filter share: they owe, paid in full (square, with something owed), or paid more
 * than owed. Null for a vendor in none: owing nothing and paying nothing, or, on a market without
 * prices, owing nothing and paying something.
 */
export type BalanceState = 'owes' | 'paid' | 'over';

export interface VendorAccount {
  /** The market's currency; null on a market that sets no prices. */
  currency: string | null;
  lines: PaymentLine[];
  payments: Payment[];
  owedCents: number;
  paidCents: number;
  /** The state the server reads the two totals in. */
  balanceState: BalanceState | null;
  /** Whether what was paid compares with what is owed (`compares` in `back-end/payments.py`):
   * always on a market with prices, and on one without only for an account owing an amount set by
   * hand, or refunded beyond what it paid. */
  compares: boolean;
}

export interface NewPayment {
  cents: number;
  method: PaymentMethod;
  paidOn: string;
  note: string;
}

/** The currency an amount is shown in where the market names none: the card's own default. */
const DEFAULT_CURRENCY = 'CAD';

/** The currency an account's amounts are shown in, and an amount field's beside them. */
export function currencyOf(account: Pick<VendorAccount, 'currency'>): string {
  return account.currency ?? DEFAULT_CURRENCY;
}

/** An amount in the account's currency; a refund's negative amount reads "-$15.00". */
export function money(cents: number, account: Pick<VendorAccount, 'currency'>): string {
  const amount = formatPrice(Math.abs(cents), currencyOf(account));
  return cents < 0 ? `-${amount}` : amount;
}

type Served = Pick<VendorAccount, 'currency' | 'owedCents' | 'paidCents' | 'balanceState'>;

/**
 * How what they paid compares with what they owe, in the words of the state the server serves:
 * "Owes $27.00", "Paid in full", or "Paid $15.00 more than owed", the case where a refund is to be
 * issued (Q26). In no state, it reads as what was paid, "Paid $35.00", or "Nothing owed" where
 * nothing was.
 */
export function balanceText(account: Served): string {
  switch (account.balanceState) {
    case 'owes':
      return `Owes ${money(account.owedCents - account.paidCents, account)}`;
    case 'paid':
      return 'Paid in full';
    case 'over':
      return `Paid ${money(account.paidCents - account.owedCents, account)} more than owed`;
    default:
      return account.paidCents ? `Paid ${money(account.paidCents, account)}` : 'Nothing owed';
  }
}

const BALANCE_CHIP: Record<BalanceState, string> = {
  owes: 'chip--attention',
  paid: 'chip--positive',
  over: 'chip--informational',
};

/**
 * The served state's chip, on the Payment tab and the Payments page alike: owing asks for
 * attention, square is positive, and paid more than owed, a refund to issue, informs. No state
 * takes no tone.
 */
export function balanceChip(state: BalanceState | null): string {
  return state ? BALANCE_CHIP[state] : 'chip--neutral';
}

/** A line's seat as it reads: "North Wing 1, Gold, full table", and the price group that set its price
 * where the card has groups, as the date card names it: "…, Example College student + club member". */
export function seatText(line: PaymentLine): string {
  const size = /half/i.test(line.tableChoice) ? 'half table' : 'full table';
  return [line.tableCode, line.tier.trim(), size, line.group ?? ''].filter(Boolean).join(', ');
}

/**
 * Where a line's number came from, under its day: the seat it prices, and for a freed seat that it
 * was freed and when (Daniel: "from Sunday, now deleted"): "North Wing 1, Gold, full table - table
 * freed" and "Oct 30, 2026", the day apart so the screen keeps it on one line.
 */
export function lineSource(line: PaymentLine): { text: string; freedOn: string | null } {
  if (!line.freed) return { text: seatText(line), freedOn: null };
  return {
    text: `${seatText(line)} - table freed`,
    freedOn: line.freedAt ? getTimestampDate(line.freedAt) : null,
  };
}

/**
 * What an entry was, "Cash, paid" or "Refund by e-transfer, given": the Payment tab writes its day
 * after it, in parts, so a narrow box breaks the day only after its weekday.
 */
export function entryText(payment: Payment): string {
  if (payment.kind === 'refund') {
    return `Refund by ${methodLabel(payment.method).toLowerCase()}, given`;
  }
  return `${methodLabel(payment.method)}, paid`;
}

/** The last change to an entry since it was recorded, "Edited by …" or "Removed by …", shown
 * under "Recorded by …"; null for an entry as it was recorded. */
export function entryChange(payment: Payment): { verb: string; by: string; at: string } | null {
  if (payment.removedAt) {
    return { verb: 'Removed', by: payment.removedBy ?? '', at: payment.removedAt };
  }
  if (payment.editedAt) return { verb: 'Edited', by: payment.editedBy ?? '', at: payment.editedAt };
  return null;
}

export function methodLabel(method: PaymentMethod): string {
  return PAYMENT_METHODS.find((m) => m.id === method)?.label ?? method;
}

/** Today in the organizer's own calendar, `YYYY-MM-DD`: what a new payment's date starts at. */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function accountPath(marketId: string, email: string): string {
  return `/markets/${encodeURIComponent(marketId)}/payments/${encodeURIComponent(email)}`;
}

export async function loadAccount(marketId: string, email: string): Promise<VendorAccount> {
  return (await api.get<VendorAccount>(accountPath(marketId, email))).data;
}

/**
 * Record one payment; answers the account as it now reads.
 *
 * `requestKey` is the one press of Record it is (T270): the dialog makes it when it opens and
 * sends it on every press of that opening, so a press repeated after its answer was lost records
 * nothing new. A repeat that differs from the entry first recorded is refused 409, with the
 * account as it stands (`accountAsItStands`).
 */
export async function recordPayment(
  marketId: string,
  email: string,
  payment: NewPayment,
  requestKey: string,
): Promise<VendorAccount> {
  return (await api.post<VendorAccount>(accountPath(marketId, email), { ...payment, requestKey }))
    .data;
}

/** Record money given back, the same fields as a payment (an Admin's, E44/F01/S02), once per
 * `requestKey` as a payment is. */
export async function recordRefund(
  marketId: string,
  email: string,
  refund: NewPayment,
  requestKey: string,
): Promise<VendorAccount> {
  return (
    await api.post<VendorAccount>(`${accountPath(marketId, email)}/refunds`, {
      ...refund,
      requestKey,
    })
  ).data;
}

/** The account a 409 carries as it stands, which the refused dialog shows behind it: a repeat of a
 * press of Record that differs from the entry first recorded, or an edit or a removal of an entry
 * that changed or was removed before it was written (T335). Null otherwise. */
export function accountAsItStands(err: unknown): VendorAccount | null {
  if (getApiErrorStatus(err) !== 409) return null;
  const answer = (err as { response?: { data?: { account?: unknown } } }).response?.data;
  const account = answer?.account;
  return account && typeof account === 'object' ? (account as VendorAccount) : null;
}

function entryPath(marketId: string, paymentId: string): string {
  return `/markets/${encodeURIComponent(marketId)}/payment-entries/${encodeURIComponent(paymentId)}`;
}

export async function editPayment(
  marketId: string,
  paymentId: string,
  payment: NewPayment,
): Promise<VendorAccount> {
  return (await api.put<VendorAccount>(entryPath(marketId, paymentId), payment)).data;
}

export async function removePayment(marketId: string, paymentId: string): Promise<VendorAccount> {
  return (await api.delete<VendorAccount>(entryPath(marketId, paymentId))).data;
}

function owedPath(marketId: string, email: string, date: string): string {
  return `${accountPath(marketId, email)}/owed/${encodeURIComponent(date)}`;
}

/** Set what one table-day owes; $0 waives it. */
export async function setAmountOwed(
  marketId: string,
  email: string,
  date: string,
  cents: number,
): Promise<VendorAccount> {
  return (await api.put<VendorAccount>(owedPath(marketId, email, date), { cents })).data;
}

/** Take back an amount set by hand: the day owes its calculated price again. */
export async function useCalculatedPrice(
  marketId: string,
  email: string,
  date: string,
): Promise<VendorAccount> {
  return (await api.delete<VendorAccount>(owedPath(marketId, email, date))).data;
}
