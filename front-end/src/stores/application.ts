import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  requestLoginCode,
  verifyLoginCode,
  resumeSignIn,
  endRememberedSignIn,
  type SignedIn,
  verifyErrorFrom,
  codeStateFrom,
  type CodeState,
  requestErrorFrom,
  saveErrorFrom,
  fetchApplicantApplication,
  saveApplicantApplication,
  checkInWithDoorCode,
  checkOutWithDoorCode,
  undoOwnCheckIn,
  undoOwnCheckOut,
} from '@/utils/applicantApi';
import { getApiErrorMessage, getApiErrorStatus } from '@/utils/api';
import { isHumanCheckRequired } from '@/utils/captcha';
import {
  IntakeMode,
  type Application,
  type EssentialFormOptions,
  type FormField,
} from '@/assets/types/datatypes';
import { EMPTY_ESSENTIAL_OPTIONS } from '@/utils/essentialFields';
import { fetchPublicApplicationForm } from '@/utils/publicApplicationForm';
import { fetchVendorPage, type VendorPageInfo, type VendorPageRead } from '@/utils/vendorPage';

/** What reading the vendor's own application found. */
export interface ApplicationRead {
  application: Application | null;
  failed: boolean;
}

/**
 * What reading a signed-in vendor's page found: `failed` when a read got no answer, `notFound` when
 * the market no longer has a vendor page (taken back to draft, say), which reads as a stranger's.
 */
export interface VendorRead {
  failed: boolean;
  notFound: boolean;
}

/**
 * Where a vendor's sign-in is kept: this tab's sessionStorage (decided 2026-10-02, bug 36).
 *
 * It lived only in memory, so a reload - of a long form, half filled - signed the vendor out, and
 * the next code was a minute's wait away. The tab is the right lifetime: it survives a reload and
 * moving between Your Application and the form, a new tab asks to sign in again, and closing the
 * tab ends it. The token itself still expires after 30 minutes on the server.
 *
 * Every read and write is guarded: storage can be unavailable (a private window, blocked site
 * data), and then the sign-in simply lasts as long as the page, as it always did.
 *
 * "Remember me" (ADR 0022) changes none of this: it spares the code, not the tab. A remembered
 * device holds an HttpOnly cookie the server set, which this code never reads; a new tab asks the
 * server to resume from it and keeps the token it is given here, as a right code's is.
 */
const SESSION_KEY = 'conventioner.applicantSession';

interface StoredSession {
  marketId: string;
  marketSlug: string;
  applicantEmail: string;
  token: string;
}

function storedSession(): StoredSession | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const session = parsed as Partial<StoredSession>;
    if (!session.marketId || !session.marketSlug || !session.applicantEmail || !session.token) {
      return null;
    }
    return session as StoredSession;
  } catch {
    return null;
  }
}

function keepSession(session: StoredSession | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Unavailable storage: the sign-in lasts as long as the page.
  }
}

/**
 * A door code scanned at the entrance (ADR 0022), kept in this tab from the moment the page opens
 * on `?door=<code>` until it is used once, so it survives the sign-in it may take first.
 *
 * It is for the vendor who scanned it, and checks in no one else: on a device at the door that
 * vendors share, the next vendor to sign in was once checked in by a scan they never made.
 * `applicantEmail` is that vendor's address: the first one the sign-in sends a code to, or the
 * vendor whose sign-in ran out as it checked them in; null until then, when the first sign-in here
 * is the scanner's own.
 */
const DOOR_CODE_KEY = 'conventioner.doorCode';

interface HeldDoorCode {
  marketSlug: string;
  code: string;
  applicantEmail: string | null;
}

function storedDoorCode(): HeldDoorCode | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(DOOR_CODE_KEY) ?? 'null') as unknown;
    const held = parsed as Partial<HeldDoorCode> | null;
    if (!held?.marketSlug || !held.code) return null;
    const applicantEmail = typeof held.applicantEmail === 'string' ? held.applicantEmail : null;
    return { marketSlug: held.marketSlug, code: held.code, applicantEmail };
  } catch {
    return null;
  }
}

function keepDoorCode(held: HeldDoorCode | null): void {
  try {
    if (held) sessionStorage.setItem(DOOR_CODE_KEY, JSON.stringify(held));
    else sessionStorage.removeItem(DOOR_CODE_KEY);
  } catch {
    // Unavailable storage: the code lasts as long as the page.
  }
}

/**
 * The answers a vendor has typed into Apply or Edit and not yet saved, kept in this tab's
 * sessionStorage as they type (T271), so a reload, or a phone discarding the tab, reopens the form
 * on them. The tab is the sign-in's own lifetime (bug 36), so nothing of the vendor's outlives it.
 *
 * It is kept for one market and one address, and opens only for them (`draftFor`). It goes when
 * the answers are saved, on Cancel, on Sign out, when this tab signs in to its market as another
 * address, and once the market no longer takes applications (`VendorApplication`). Every read and
 * write is guarded, as the sign-in's are: with storage unavailable the answers last as long as the
 * page, as they always did.
 *
 * A save that meets an ended sign-in the device cannot renew keeps the answers it sent, marked
 * `saveAfterSignIn`, and the form sends them once by itself after the vendor signs in again as the
 * same address (`takeSaveAfterSignIn`).
 */
const DRAFT_KEY = 'conventioner.applicationDraft';

export interface ApplicationDraft {
  marketSlug: string;
  applicantEmail: string;
  formData: Record<string, unknown>;
  /** A save met an ended sign-in: send it once the vendor signs in again. */
  saveAfterSignIn: boolean;
}

function storedDraft(): ApplicationDraft | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const draft = parsed as Partial<ApplicationDraft>;
    if (
      typeof draft.marketSlug !== 'string' ||
      typeof draft.applicantEmail !== 'string' ||
      !draft.formData ||
      typeof draft.formData !== 'object' ||
      Array.isArray(draft.formData)
    ) {
      return null;
    }
    return {
      marketSlug: draft.marketSlug,
      applicantEmail: draft.applicantEmail,
      formData: draft.formData,
      saveAfterSignIn: draft.saveAfterSignIn === true,
    };
  } catch {
    return null;
  }
}

function keepDraft(draft: ApplicationDraft | null): void {
  try {
    if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Unavailable storage: the answers last as long as the page.
  }
}

/** What a check-in, a check-out or an undo came to: done, or refused with the sentence to show. */
export type CheckInResult = { ok: true } | { ok: false; message: string; signedOut: boolean };

/**
 * What asking for a sign-in code, or trying one, came to: done, or refused with the sentence to
 * say, for a code tried where the code stands, and whether the server asked for the human check
 * (`humanCheckRequired`), which the sign-in answers with a new token once. The sign-in reads its
 * own answer, never the store's shared `error`, which another reader may write while the request
 * is out (T277 ticket 08).
 */
export type CodeAnswer =
  | { ok: true }
  | { ok: false; sentence: string; codeState: CodeState | null; humanCheckRequired: boolean };

export const useApplicationStore = defineStore('application', () => {
  /**
   * The vendor's sign-in, one thing (T421): held whole or not at all, so a sign-out never leaves
   * an address or a token behind. The four names below read it and nothing writes them.
   */
  const session = ref<StoredSession | null>(storedSession());
  const marketId = computed(() => session.value?.marketId ?? null);
  const marketSlug = computed(() => session.value?.marketSlug ?? null);
  const applicantEmail = computed(() => session.value?.applicantEmail ?? null);
  const token = computed(() => session.value?.token ?? null);
  /**
   * Moved on when this tab's vendor stops being the one signed in: by `clearSession`, and by
   * `holdSignIn` holding another vendor, or another market's page, over a sign-in it did not end.
   * Each signed-in request notes it as it starts, and one that answers after it moved writes
   * nothing: on a shared door device the vendor who asked has gone, and the next person sees
   * nothing of theirs. A renewal (`resume`) signs the same vendor in again and leaves it, so the
   * request it renews still lands.
   */
  let epoch = 0;
  const application = ref<Application | null>(null);
  const error = ref<string | null>(null);
  /**
   * The vendor page's one state (ADR 0022): the market as the page reads it before sign-in, and,
   * signed in, the form's questions - its own and the essential ones the plan offers - that the
   * vendor's answers are shown against and edited in. Every section reads it here.
   */
  const page = ref<VendorPageInfo | null>(null);
  const formFields = ref<FormField[]>([]);
  const essentialOptions = ref<EssentialFormOptions>(EMPTY_ESSENTIAL_OPTIONS);
  const heldDoorCode = ref<HeldDoorCode | null>(storedDoorCode());
  /** The vendor's unsaved answers, kept in this tab; read through `draftFor`. */
  const draft = ref<ApplicationDraft | null>(storedDraft());

  /** The answers kept for `email` at `slug`, or null: one address's never open for another. */
  function draftFor(slug: string, email: string | null): ApplicationDraft | null {
    const held = draft.value;
    if (!held || !email || held.marketSlug !== slug || held.applicantEmail !== email) return null;
    return held;
  }

  /** Keep the signed-in vendor's answers as they stand, for this market and address. */
  function holdDraft(formData: Record<string, unknown>): void {
    if (!marketSlug.value || !applicantEmail.value) return;
    draft.value = {
      marketSlug: marketSlug.value,
      applicantEmail: applicantEmail.value,
      formData: JSON.parse(JSON.stringify(formData)) as Record<string, unknown>,
      saveAfterSignIn: false,
    };
    keepDraft(draft.value);
  }

  function dropDraft(): void {
    draft.value = null;
    keepDraft(null);
  }

  /**
   * Whether the signed-in vendor's kept answers wait to be sent after this sign-in, taken: the mark
   * is cleared here, before the save is out, so a save that fails is never sent again by itself.
   */
  function takeSaveAfterSignIn(): boolean {
    const held = marketSlug.value ? draftFor(marketSlug.value, applicantEmail.value) : null;
    if (!held?.saveAfterSignIn) return false;
    draft.value = { ...held, saveAfterSignIn: false };
    keepDraft(draft.value);
    return true;
  }

  function isAuthenticatedFor(slug: string): boolean {
    return token.value !== null && marketSlug.value === slug;
  }

  /** Read the market's vendor page, as anyone may before signing in. */
  async function loadPage(slug: string): Promise<VendorPageRead> {
    const read = await fetchVendorPage(slug);
    page.value = read.page;
    return read;
  }

  /**
   * Read what a signed-in vendor's page shows: their application, and on a market whose vendors
   * apply, the form's questions. A sign-in that has ended is renewed from a remembered device, or
   * else clears itself (`fetchApplication`).
   *
   * Both arrive before the page is drawn, so the form opens on what the vendor already answered
   * (bug 21): its own defaults - a ranking seeded in the plan's order - fill only what they never
   * answered, and never race their answers.
   */
  async function loadVendorRead(): Promise<VendorRead> {
    const slug = marketSlug.value;
    if (!slug) return { failed: false, notFound: false };
    const asked = epoch;
    const asksQuestions = page.value?.intakeMode === IntakeMode.Form;
    const [read, form] = await Promise.all([
      fetchApplication(),
      asksQuestions ? fetchPublicApplicationForm(slug) : Promise.resolve(null),
    ]);
    if (epoch !== asked) return { failed: false, notFound: false };
    formFields.value = form?.fields ?? [];
    essentialOptions.value = form?.essentialOptions ?? EMPTY_ESSENTIAL_OPTIONS;
    return {
      failed: read.failed || Boolean(form?.failed && !form.notFound),
      notFound: Boolean(form?.notFound),
    };
  }

  async function requestCode(
    slug: string,
    email: string,
    captchaToken: string,
  ): Promise<CodeAnswer> {
    try {
      await requestLoginCode(slug, email, captchaToken);
      // The first address sent a code after a scan is the scanner's: the code is theirs alone.
      const held = heldDoorCode.value;
      if (held && held.marketSlug === slug && held.applicantEmail === null) {
        holdDoorCode(slug, held.code, email);
      }
      return { ok: true };
    } catch (err: unknown) {
      return {
        ok: false,
        sentence: requestErrorFrom(err),
        codeState: null,
        humanCheckRequired: isHumanCheckRequired(err),
      };
    }
  }

  /** Hold a sign-in the server gave, from a right code or a remembered one, for this tab. */
  function holdSignIn(slug: string, result: SignedIn & { token: string }): void {
    // Another address signing in here never opens the answers kept for the last one.
    const held = draft.value;
    if (held && held.marketSlug === slug && held.applicantEmail !== result.applicantEmail) {
      dropDraft();
    }
    // Nor checks another vendor in with the door code held for the one who scanned it.
    const door = heldDoorCode.value;
    if (door && door.marketSlug === slug && !doorCodeIsFor(door, result.applicantEmail)) {
      dropDoorCode();
    }
    // Another vendor, or another market's page, in place of one still signed in: nothing asked for
    // the one replaced lands on the next one's page.
    const before = session.value;
    if (before && (before.marketSlug !== slug || before.applicantEmail !== result.applicantEmail)) {
      epoch += 1;
    }
    session.value = {
      marketId: result.marketId,
      marketSlug: slug,
      applicantEmail: result.applicantEmail,
      token: result.token,
    };
    keepSession(session.value);
  }

  async function verifyCode(
    slug: string,
    email: string,
    code: string,
    remember: boolean,
    captchaToken: string,
  ): Promise<CodeAnswer> {
    try {
      const result = await verifyLoginCode(slug, email, code, remember, captchaToken);
      // Every successful sign-in carries a token now, applied or not (E26/F07/S01). Without one
      // this reported success and the page went back to "Sign In" with no word (bug 6), so a
      // reply without one is a failure, said as one.
      if (!result.token) {
        return {
          ok: false,
          sentence: 'Sign-in did not complete. Please request a new code and try again.',
          codeState: null,
          humanCheckRequired: false,
        };
      }
      holdSignIn(slug, { ...result, token: result.token });
      return { ok: true };
    } catch (err: unknown) {
      return {
        ok: false,
        sentence: verifyErrorFrom(err),
        codeState: codeStateFrom(err),
        humanCheckRequired: isHumanCheckRequired(err),
      };
    }
  }

  /**
   * Sign a remembered device straight back in (ADR 0022); true when it was.
   *
   * Asked once, by a page with no sign-in in this tab, before it draws the sign-in, and by a
   * signed-in request that finds this tab's sign-in ended (`withRenewal`). Anything but a live
   * remembered sign-in - none, one that has ended, or no answer at all - is false, and says
   * nothing: the page simply asks for a code, as it would have.
   *
   * A renewal names the vendor it renews (`renewing`), and a remembered sign-in of anyone else is
   * refused, false and held nowhere: the device remembers one vendor per market, not per tab, so a
   * renewal is only ever the same vendor signed in again.
   */
  async function resume(slug: string, renewing: string | null = null): Promise<boolean> {
    try {
      const result = await resumeSignIn(slug);
      if (!result.token) return false;
      if (renewing !== null && result.applicantEmail !== renewing) return false;
      holdSignIn(slug, { ...result, token: result.token });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Make a signed-in request, and when it finds this tab's sign-in ended (a 401), ask once whether
   * the device is remembered and make it again with the sign-in that gives (ADR 0022). The 30-minute
   * sign-in ends while a vendor waits at the door; a remembered one should not then be sent a code.
   * Anything else, or a device that is not remembered, is the first answer, thrown as it came.
   *
   * A sign-in that ended here meanwhile (`asked`, the epoch the request was made in) is never
   * renewed: the remembered device may be the next vendor's by then, and the request is not theirs.
   * Nor is one renewed into another vendor's remembered sign-in (`resume`'s `renewing`).
   */
  async function withRenewal<T>(
    asked: number,
    call: (slug: string, token: string) => Promise<T>,
  ): Promise<T> {
    const slug = marketSlug.value;
    const email = applicantEmail.value;
    if (!slug || !email || !token.value) throw new Error('Not signed in');
    try {
      return await call(slug, token.value);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== 401 || epoch !== asked || !(await resume(slug, email))) throw err;
      if (epoch !== asked || !token.value) throw err;
      return call(slug, token.value);
    }
  }

  /**
   * The vendor's own application: theirs, none yet, or `failed` when the read got no answer.
   *
   * A failed read is never reported as "none". It was, and on a slow connection Your Application
   * told a vendor who had applied that they had not, and the apply page opened empty over answers
   * a save would then replace.
   *
   * Answering after the vendor signed out, it writes nothing and answers as signed out (`epoch`).
   */
  async function fetchApplication(): Promise<ApplicationRead> {
    if (!token.value || !marketSlug.value) return { application: null, failed: false };
    const asked = epoch;
    error.value = null;
    try {
      const app = await withRenewal(asked, fetchApplicantApplication);
      if (epoch !== asked) return { application: null, failed: false };
      application.value = app;
      return { application: app, failed: false };
    } catch (err: unknown) {
      if (epoch !== asked) return { application: null, failed: false };
      if ((err as { response?: { status?: number } })?.response?.status === 401) {
        // Not a failure to load: the sign-in has ended, and the caller sends them to sign in.
        clearSession();
        error.value = 'Your session has expired. Please sign in again.';
        return { application: null, failed: false };
      }
      error.value = requestErrorFrom(err);
      return { application: null, failed: true };
    }
  }

  /**
   * Save the vendor's answers; their application as the server now holds it, or null with the
   * reason in `error`. Answering after the vendor signed out, it writes nothing - no application,
   * no sentence, no answers kept for the next sign-in - and answers null (`epoch`).
   */
  async function saveApplication(formData: Record<string, unknown>): Promise<Application | null> {
    if (!token.value || !marketSlug.value) return null;
    const slug = marketSlug.value;
    const email = applicantEmail.value;
    const asked = epoch;
    error.value = null;
    try {
      const app = await withRenewal(asked, (slug, current) =>
        saveApplicantApplication(slug, current, formData),
      );
      if (epoch !== asked) return null;
      application.value = app;
      return app;
    } catch (err: unknown) {
      if (epoch !== asked) return null;
      if ((err as { response?: { status?: number } })?.response?.status === 401) {
        // An ended sign-in the device could not renew (`withRenewal`): the answers are kept, to be
        // sent once the vendor signs in again, and the sentence says so.
        if (email) {
          draft.value = {
            marketSlug: slug,
            applicantEmail: email,
            formData: JSON.parse(JSON.stringify(formData)) as Record<string, unknown>,
            saveAfterSignIn: true,
          };
          keepDraft(draft.value);
        }
        clearSession();
        error.value = email
          ? 'Your session has expired. Sign in again, and your answers will be saved.'
          : 'Your session has expired. Please sign in again.';
      } else {
        error.value = saveErrorFrom(err);
      }
      return null;
    }
  }

  /**
   * Keep a door code scanned at this market's entrance until the page uses it, for `email`, or,
   * scanned with nobody signed in, for the first address the sign-in sends a code to.
   */
  function holdDoorCode(slug: string, code: string, email: string | null = null): void {
    heldDoorCode.value = { marketSlug: slug, code, applicantEmail: email };
    keepDoorCode(heldDoorCode.value);
  }

  function dropDoorCode(): void {
    heldDoorCode.value = null;
    keepDoorCode(null);
  }

  function doorCodeIsFor(held: HeldDoorCode, email: string | null): boolean {
    return held.applicantEmail === null || held.applicantEmail === email;
  }

  /** The door code held for this market and the vendor signed in, taken: it is used once. */
  function takeDoorCode(slug: string): string | null {
    const held = heldDoorCode.value;
    if (!held || held.marketSlug !== slug || !doorCodeIsFor(held, applicantEmail.value)) {
      return null;
    }
    dropDoorCode();
    return held.code;
  }

  /** Mark the vendor's seat on `date` as checked in at `at`, or not, as the server now holds it. */
  function setCheckedIn(date: string, at: string | null): void {
    const app = application.value;
    if (!app?.seats) return;
    app.seats = app.seats.map((seat) => (seat.date === date ? { ...seat, checkedInAt: at } : seat));
  }

  /** Mark the vendor's seat on `date` as checked out at `at`, or not, as the server now holds it. */
  function setCheckedOut(date: string, at: string | null): void {
    const app = application.value;
    if (!app?.seats) return;
    app.seats = app.seats.map((seat) =>
      seat.date === date ? { ...seat, checkedOutAt: at } : seat,
    );
  }

  /** A refused check-in, check-out or undo, in its sentence; an ended sign-in clears itself. */
  function checkInRefusal(err: unknown, fallback: string): CheckInResult {
    if (getApiErrorStatus(err) === 401) return signedOutRefusal();
    return { ok: false, message: getApiErrorMessage(err, fallback), signedOut: false };
  }

  function signedOutRefusal(): CheckInResult {
    clearSession();
    error.value = 'Your session has expired. Please sign in again.';
    return { ok: false, message: error.value, signedOut: true };
  }

  /**
   * What a check-in or an undo answering after the vendor signed out comes to: nothing marked and
   * nothing said. Not `signedOut`, which has the section keep a scanned code for the next sign-in
   * of the vendor who asked: they signed out, and asked for nothing more.
   */
  const LEFT: CheckInResult = { ok: false, message: '', signedOut: false };

  /** Check the vendor in for `date` with the market's door code, scanned or typed (ADR 0022). */
  async function checkIn(date: string, doorCode: string): Promise<CheckInResult> {
    if (!token.value || !marketSlug.value) return signedOutRefusal();
    const asked = epoch;
    try {
      const { checkedInAt } = await withRenewal(asked, (slug, current) =>
        checkInWithDoorCode(slug, current, date, doorCode),
      );
      if (epoch !== asked) return LEFT;
      setCheckedIn(date, checkedInAt);
      return { ok: true };
    } catch (err: unknown) {
      if (epoch !== asked) return LEFT;
      return checkInRefusal(err, 'You were not checked in. Please try again.');
    }
  }

  /** Take back the vendor's own check-in for `date`, after a mis-tap. */
  async function undoCheckIn(date: string): Promise<CheckInResult> {
    if (!token.value || !marketSlug.value) return signedOutRefusal();
    const asked = epoch;
    try {
      await withRenewal(asked, (slug, current) => undoOwnCheckIn(slug, current, date));
      if (epoch !== asked) return LEFT;
      setCheckedIn(date, null);
      return { ok: true };
    } catch (err: unknown) {
      if (epoch !== asked) return LEFT;
      return checkInRefusal(err, 'Your check-in was not undone. Please try again.');
    }
  }

  /**
   * Check the vendor out for `date` with the market's door code, typed or put in the field by a
   * scan (T496). Built as `checkIn` is; no code is held through a sign-in that ran out, since a
   * check-out is never sent unasked.
   */
  async function checkOut(date: string, doorCode: string): Promise<CheckInResult> {
    if (!token.value || !marketSlug.value) return signedOutRefusal();
    const asked = epoch;
    try {
      const { checkedOutAt } = await withRenewal(asked, (slug, current) =>
        checkOutWithDoorCode(slug, current, date, doorCode),
      );
      if (epoch !== asked) return LEFT;
      setCheckedOut(date, checkedOutAt);
      return { ok: true };
    } catch (err: unknown) {
      if (epoch !== asked) return LEFT;
      return checkInRefusal(err, 'You were not checked out. Please try again.');
    }
  }

  /** Take back the vendor's own check-out for `date`, after a mis-tap. */
  async function undoCheckOut(date: string): Promise<CheckInResult> {
    if (!token.value || !marketSlug.value) return signedOutRefusal();
    const asked = epoch;
    try {
      await withRenewal(asked, (slug, current) => undoOwnCheckOut(slug, current, date));
      if (epoch !== asked) return LEFT;
      setCheckedOut(date, null);
      return { ok: true };
    } catch (err: unknown) {
      if (epoch !== asked) return LEFT;
      return checkInRefusal(err, 'Your check-out was not undone. Please try again.');
    }
  }

  /** End this tab's sign-in whole; every request still out then writes nothing (`epoch`). */
  function clearSession(): void {
    epoch += 1;
    session.value = null;
    application.value = null;
    formFields.value = [];
    essentialOptions.value = EMPTY_ESSENTIAL_OPTIONS;
    error.value = null;
    keepSession(null);
  }

  /**
   * Sign out: end this device's remembered sign-in on the server, then this tab's (ADR 0022).
   *
   * False, still signed in, when the server could not be reached: a remembered device left as it
   * was would sign them straight back in on their next visit, which is not what Sign out says.
   */
  async function signOut(slug: string): Promise<boolean> {
    // Before the request: on a shared device the answers go even when the server is not reached.
    dropDraft();
    try {
      await endRememberedSignIn(slug);
    } catch {
      return false;
    }
    clearSession();
    return true;
  }

  return {
    marketId,
    marketSlug,
    applicantEmail,
    token,
    application,
    error,
    page,
    formFields,
    essentialOptions,
    heldDoorCode,
    draft,
    draftFor,
    holdDraft,
    dropDraft,
    takeSaveAfterSignIn,
    isAuthenticatedFor,
    loadPage,
    loadVendorRead,
    requestCode,
    verifyCode,
    resume,
    fetchApplication,
    saveApplication,
    clearSession,
    signOut,
    holdDoorCode,
    dropDoorCode,
    takeDoorCode,
    checkIn,
    undoCheckIn,
    checkOut,
    undoCheckOut,
  };
});
