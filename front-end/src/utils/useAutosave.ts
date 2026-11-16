import { computed, getCurrentInstance, onMounted, onUnmounted, readonly, shallowRef } from 'vue';
import { getApiErrorMessage, getApiErrorStatus } from '@/utils/api';

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'refused';

/** Said after a refusal's own sentence: what the screen did about it. */
const TAKEN_BACK = ' The plan is back as it was last saved.';

/**
 * Whether a failed save was the server saying no (400 to 499) rather than the save not getting
 * through: no answer, a 5xx, a 401 (the session ended, which the app's interceptor answers), a 408
 * (the request timed out) or a 429 (too many requests). A refusal will be refused again, so what it
 * carried is dropped; a failure may go through next time, so it is kept and sent again.
 */
export function isRefusal(err: unknown): boolean {
  const status = getApiErrorStatus(err);
  if (status === null || status < 400 || status > 499) return false;
  return status !== 401 && status !== 408 && status !== 429;
}

export interface AutosaveOptions {
  /** Write the working copy as it stands at the call. */
  send: () => Promise<void>;
  /**
   * The last try on the way out of the page: start a write that outlives it (a keepalive request),
   * true when one started. Its answer is never read: the page is going.
   */
  sendOnUnload: () => boolean;
  /** After a save the server took: the re-read. */
  afterSave: () => Promise<void> | void;
  /** After a refusal: take the server's copy back. Called with the refusal's sentence. */
  afterRefusal: (sentence: string) => Promise<void> | void;
  /** Whether this person may write at all; false sends nothing and counts no edit. */
  may: () => boolean;
  /** The sentence for a failure with no sentence of its own. */
  failure: string;
  /**
   * Keep the working copy when the server refuses a save, where the default takes the server's
   * copy back (a location's layout, T257): the edits stay unsaved, the status line says the
   * refusal's own sentence with nothing after it, and the next edit, `retry` or a flush sends the
   * copy again. The screen that then takes the server's copy (its Reload) calls `forget`.
   */
  keepOnRefusal?: boolean;
  /**
   * The pause after an edit. 0 is no pause: an edit is sent in the same call, or, while a save is
   * out, when that save answers (a click saved as it is made, one write out at a time).
   */
  delay?: number;
  /**
   * Take the server's copy back on a failure too, as on a refusal: for a screen with no Retry, so
   * nothing is kept unsaved for a button it does not have. `afterRefusal` runs with the sentence.
   */
  takesBackOnFailure?: boolean;
}

// The table (T420): an autosave's state is one phase, and only `transition` moves it.

/**
 * Where the working copy stands against the server.
 *
 * - `clean`: nothing unsaved, nothing out; `saved` while "Plan saved" shows.
 * - `pausing`: an edit waits for its pause.
 * - `held`: an edit waits for the hold to end.
 * - `sending`: a save is out; `after` is what follows it (`none`: no edit since it went;
 *   `pausing`: an edit since, its pause running; `wanted`: an edit since, whose pause ended or
 *   which the hold keeps), and `drop` is set once the person may no longer write, so its answer
 *   drops everything.
 * - `failed`: a save failed on the way; its edits are kept for the next edit, Retry or a flush.
 * - `refused`: the server refused a save; `kept` when the screen keeps its copy (`keepOnRefusal`).
 */
export type AutosavePhase =
  | { kind: 'clean'; saved: boolean }
  | { kind: 'pausing' }
  | { kind: 'held' }
  | { kind: 'sending'; after: 'none' | 'pausing' | 'wanted'; drop: boolean }
  | { kind: 'failed'; sentence: string }
  | { kind: 'refused'; sentence: string; kept: boolean };

/** `hold` is the screen's (the Pricing card's), and outlives every phase; no pause runs under it. */
export interface AutosaveState {
  phase: AutosavePhase;
  hold: boolean;
}

export type AutosaveEvent =
  | { kind: 'edit' }
  | { kind: 'pauseEnds' }
  | { kind: 'ok' }
  | { kind: 'failed'; sentence: string }
  | { kind: 'refused'; sentence: string; keep: boolean }
  /** The person may no longer write. */
  | { kind: 'lost' }
  | { kind: 'holdOn' }
  | { kind: 'holdOff' }
  | { kind: 'flush' }
  /** The screen took the server's copy in place of its own. */
  | { kind: 'forget' }
  /** "Plan saved" has shown its 2 s. */
  | { kind: 'savedEnds' };

export interface AutosaveStep {
  state: AutosaveState;
  /** Start a save of the working copy as it stands. */
  send: boolean;
}

const CLEAN: AutosavePhase = { kind: 'clean', saved: false };
const SENDING: AutosavePhase = { kind: 'sending', after: 'none', drop: false };

/**
 * The next state, and whether to start a save; the same object, and no send, for a pair not in
 * the table. `docs/implementation/modules/plan-autosave.md` has the table whole.
 */
export function transition(state: AutosaveState, event: AutosaveEvent): AutosaveStep {
  const { phase, hold } = state;
  const same: AutosaveStep = { state, send: false };
  const to = (next: AutosavePhase, nextHold = hold, send = false): AutosaveStep => ({
    state: { phase: next, hold: nextHold },
    send,
  });
  const holdOn = () => (hold ? same : to(phase, true));
  const holdOff = () => (hold ? to(phase, false) : same);
  /** An edit after nothing is out: it waits for its pause, or for the hold. */
  const waiting: AutosavePhase = hold ? { kind: 'held' } : { kind: 'pausing' };
  switch (phase.kind) {
    case 'clean':
      if (event.kind === 'edit') return to(waiting);
      if (event.kind === 'holdOn') return holdOn();
      if (event.kind === 'holdOff') return holdOff();
      if (event.kind === 'savedEnds') return phase.saved ? to(CLEAN) : same;
      return same;
    case 'pausing':
      // A new state for an edit, so the composable starts its pause again.
      if (event.kind === 'edit') return to({ kind: 'pausing' });
      if (event.kind === 'pauseEnds' || event.kind === 'flush') return to(SENDING, hold, true);
      if (event.kind === 'lost' || event.kind === 'forget') return to(CLEAN);
      if (event.kind === 'holdOn') return to({ kind: 'held' }, true);
      return same;
    case 'held':
      if (event.kind === 'holdOff') return to({ kind: 'pausing' }, false);
      // A held edit is sent as kept: the working copy holds the value from before the text that
      // is not one.
      if (event.kind === 'flush') return to(SENDING, hold, true);
      if (event.kind === 'lost' || event.kind === 'forget') return to(CLEAN);
      return same;
    case 'sending':
      switch (event.kind) {
        case 'edit':
          if (phase.drop || phase.after === 'wanted') return same;
          return to({ ...phase, after: hold ? 'wanted' : 'pausing' });
        case 'pauseEnds':
        case 'flush':
          return phase.after === 'pausing' ? to({ ...phase, after: 'wanted' }) : same;
        case 'holdOn':
          if (hold) return same;
          return to({ ...phase, after: phase.after === 'pausing' ? 'wanted' : phase.after }, true);
        case 'holdOff':
          if (!hold) return same;
          return to({ ...phase, after: phase.after === 'wanted' ? 'pausing' : phase.after }, false);
        case 'lost':
          return phase.drop ? same : to({ ...phase, drop: true });
        case 'forget':
          return phase.after === 'none' ? same : to({ ...phase, after: 'none' });
        case 'ok':
          if (phase.drop) return to({ kind: 'clean', saved: phase.after === 'none' });
          if (phase.after === 'none') return to({ kind: 'clean', saved: true });
          // "Saving…" stands only while a save is out: an edit this one did not carry, in its
          // pause or held, shows nothing until a save carries it.
          if (phase.after === 'pausing') return to({ kind: 'pausing' });
          return hold ? to({ kind: 'held' }) : to(SENDING, hold, true);
        case 'failed':
          // Retry could never send it, so neither the edits nor the failed line are kept for it.
          if (phase.drop) return to(CLEAN);
          if (phase.after === 'none') return to({ kind: 'failed', sentence: event.sentence });
          if (phase.after === 'pausing') return to({ kind: 'pausing' });
          return hold ? to({ kind: 'held' }) : to(SENDING, hold, true);
        case 'refused':
          // The copy is written whole and every later edit builds on the refused one, so a
          // refusal drops them all, unless the screen keeps its copy.
          return to({ kind: 'refused', sentence: event.sentence, kept: event.keep && !phase.drop });
        default:
          return same;
      }
    case 'failed':
      if (event.kind === 'edit') return to(waiting);
      if (event.kind === 'lost' || event.kind === 'forget') return to(CLEAN);
      if (event.kind === 'holdOn') return holdOn();
      if (event.kind === 'holdOff') return holdOff();
      if (event.kind === 'flush') return to(SENDING, hold, true);
      return same;
    case 'refused':
      if (event.kind === 'edit') return to(waiting);
      if (event.kind === 'lost') return phase.kept ? to({ ...phase, kept: false }) : same;
      if (event.kind === 'forget') return to(CLEAN);
      if (event.kind === 'holdOn') return holdOn();
      if (event.kind === 'holdOff') return holdOff();
      if (event.kind === 'flush') return phase.kept ? to(SENDING, hold, true) : same;
      return same;
  }
}

/** The status line's state: "Saving…" only while a save is out, "Plan saved" only when clean. */
export function statusOf(phase: AutosavePhase): AutosaveStatus {
  switch (phase.kind) {
    case 'clean':
      return phase.saved ? 'saved' : 'idle';
    case 'sending':
      return 'saving';
    case 'failed':
      return 'failed';
    case 'refused':
      return 'refused';
    default:
      return 'idle';
  }
}

/**
 * The status line's sentence. A screen that keeps its copy on a refusal (`keepOnRefusal`) says the
 * refusal's sentence alone, even once the copy is dropped because the person may no longer write:
 * that screen takes the server's copy back by its own re-read, not by the refusal.
 */
export function messageOf(phase: AutosavePhase, keepsOnRefusal = false): string {
  if (phase.kind === 'failed') return phase.sentence;
  if (phase.kind !== 'refused') return '';
  if (phase.kept || keepsOnRefusal) return phase.sentence;
  // Some refusals carry no full stop ("Market not found"), so the line after it would run on.
  return (/[.!?…]$/.test(phase.sentence) ? phase.sentence : `${phase.sentence}.`) + TAKEN_BACK;
}

/** Whether the server lacks an edit that may still be sent. */
export function unsavedIn(phase: AutosavePhase): boolean {
  if (phase.kind === 'clean') return false;
  if (phase.kind === 'refused') return phase.kept;
  return true;
}

/** An edit the server does not have and no save out carries. */
function behindIn(phase: AutosavePhase): boolean {
  if (phase.kind === 'sending') return phase.after !== 'none';
  return unsavedIn(phase);
}

/** Whether the state runs a pause: no pause runs under the hold. */
function pauseRuns(state: AutosaveState): boolean {
  return (
    state.phase.kind === 'pausing' ||
    (state.phase.kind === 'sending' && state.phase.after === 'pausing')
  );
}

/**
 * The order of the saves of one working copy that saves itself as it is edited (T271), on one
 * transition table (T420).
 *
 * The copy is written whole a pause after each edit, one save at a time. The plan used to send a
 * save at every pause whether or not one was still out, and answers are not promised in order: a
 * slow first save reaching the server last stored the older plan over the newer one, and the
 * re-read after it put that older plan back on screen beside "Plan saved".
 *
 * So a pause that ends while a save is out marks a save as wanted, and the answer sends it at once
 * with the working copy as it then stands; an edit whose pause is still running when the answer
 * comes is sent by its pause. `unsaved` holds until the server has the last edit.
 *
 * A save the server refuses drops every edit made so far, since the copy is written whole and every
 * later edit builds on the refused one, and the screen takes the server's copy back and says why;
 * a screen that keeps its copy instead says so with `keepOnRefusal`.
 * A save that fails on the way (no answer, a 401, 408, 429 or 5xx) keeps the edits unsaved and
 * says so; nothing retries on a timer, and the next edit, `retry` or a flush sends the copy again.
 * A screen with no Retry takes its copy back on a failure too, with `takesBackOnFailure`.
 *
 * A reload or a closed tab never unmounts the view, so an edit still waiting then (in its pause,
 * held, or after a failure) used to be lost. On `pagehide` the screen's `sendOnUnload` starts one
 * last write that outlives the page; the screen's browser question (`useUnsavedWork`) is the
 * guard, and this is a best effort.
 *
 * Its state is one `AutosaveState`, moved only by `transition`; the status, its sentence and
 * `unsaved` are read from it, never stored beside it. It knows nothing of markets: the screen
 * gives it the write, the re-read and who may write.
 */
export function useAutosave(options: AutosaveOptions) {
  const delay = options.delay ?? 600;
  const refusal = options.takesBackOnFailure ? () => true : isRefusal;
  const state = shallowRef<AutosaveState>({ phase: CLEAN, hold: false });
  /** The save out, settled once its answer is handled; null while none is out. */
  let out: Promise<string | null> | null = null;
  let pause: ReturnType<typeof setTimeout> | null = null;
  let savedShown: ReturnType<typeof setTimeout> | null = null;

  function stopPause() {
    if (pause !== null) clearTimeout(pause);
    pause = null;
  }

  function pauseEnds() {
    pause = null;
    feed(options.may() ? { kind: 'pauseEnds' } : { kind: 'lost' });
  }

  /** Move the state by the table, then run what the new state asks: the pause, the timer, a save. */
  function feed(event: AutosaveEvent) {
    const before = state.value;
    const step = transition(before, event);
    if (step.state === before) return;
    state.value = step.state;

    const runs = pauseRuns(step.state);
    if (!runs || event.kind === 'edit') stopPause();
    const wasSaved = before.phase.kind === 'clean' && before.phase.saved;
    const isSaved = step.state.phase.kind === 'clean' && step.state.phase.saved;
    if (!isSaved && savedShown !== null) {
      clearTimeout(savedShown);
      savedShown = null;
    }
    if (isSaved && !wasSaved) {
      savedShown = setTimeout(() => {
        savedShown = null;
        feed({ kind: 'savedEnds' });
      }, 2000);
    }
    if (step.send) startSend();
    else if (runs && pause === null) {
      if (delay === 0) pauseEnds();
      else pause = setTimeout(pauseEnds, delay);
    }
  }

  /**
   * Send the working copy as it stands. At its answer the state moves, and a wanted save goes,
   * before `afterSave` or `afterRefusal` runs, so the re-read of the answer that freed it lands
   * while an edit is unsaved and the screen ignores it.
   */
  function startSend() {
    const answered = options.send().then(
      async () => {
        out = null;
        // An edit made after this save went, which the person may no longer write, is dropped here
        // whether or not a pause or a wanted save is behind it: a held one has neither.
        if (!options.may()) feed({ kind: 'lost' });
        feed({ kind: 'ok' });
        await options.afterSave();
        return null;
      },
      async (err: unknown) => {
        out = null;
        const sentence = getApiErrorMessage(err, options.failure);
        if (!options.may()) feed({ kind: 'lost' });
        if (refusal(err)) {
          feed({ kind: 'refused', sentence, keep: Boolean(options.keepOnRefusal) });
          await options.afterRefusal(sentence);
          return sentence;
        }
        feed({ kind: 'failed', sentence });
        return sentence;
      },
    );
    out = answered;
  }

  /** The working copy changed. */
  function edited() {
    if (!options.may()) return;
    feed({ kind: 'edit' });
  }

  /**
   * Hold the pause while the screen shows what is not kept (the Pricing card's text that is not a
   * price or a share, or a group's name it refuses, E43/F01/S01), so "Plan saved" never stands
   * beside it. An edit made meanwhile waits, and is sent a pause after the hold ends.
   */
  function hold(next: boolean) {
    feed({ kind: next ? 'holdOn' : 'holdOff' });
  }

  /**
   * Send what is not stored and wait: null once the server holds the last edit, else the sentence
   * of the failure or refusal that stopped it, a save out it waited for included. A held edit is
   * sent as kept: the working copy holds the value from before the text that is not one.
   */
  async function flush(): Promise<string | null> {
    if (!options.may()) {
      feed({ kind: 'lost' });
      return null;
    }
    feed({ kind: 'flush' });
    for (;;) {
      if (out) {
        const stopped = await out;
        if (stopped !== null) return stopped;
        continue;
      }
      if (!unsavedIn(state.value.phase)) return null;
      if (!options.may()) {
        feed({ kind: 'lost' });
        return null;
      }
      const before = state.value;
      feed({ kind: 'flush' });
      if (state.value === before) return null;
    }
  }

  /** Send what is not stored again, after a failure: the button beside it. */
  function retry() {
    void flush();
  }

  /**
   * The screen read that the person may no longer write (the market archived, their role gone, by
   * another person's change): what can never be sent is dropped now, rather than at a send that
   * may never come, and left unsaved for good, which kept the screen off every later re-read and had
   * the browser ask at every reload. A save out is left to answer, and its answer drops what is
   * still unsaved. The screen takes the server's copy back by its re-read.
   */
  function forgetUnsendable() {
    if (!options.may()) feed({ kind: 'lost' });
  }

  /**
   * The screen took the server's copy in place of its own (a layout's Reload, or another
   * location's layout): what was unsaved is no longer its work, so it is dropped with the line
   * that spoke of it. A save out is left to answer.
   */
  function forget() {
    feed({ kind: 'forget' });
  }

  /**
   * The page is going (a reload, a closed tab, a link out of the app): an edit the server does not
   * have and no save out carries is sent one last time. A save out carrying every edit is left to
   * land; one with a later edit behind it most likely lands first, since it was sent first, and
   * waiting for it would lose the later edit for sure. A screen whose writes hold a revision (the
   * plan, ADR 0024) sends the copy's own, which that save out moves past, so there the server
   * refuses the last write and only the browser's question guarded the later edit.
   */
  function onPageHide() {
    if (!options.may()) return;
    if (behindIn(state.value.phase)) options.sendOnUnload();
  }

  if (getCurrentInstance()) {
    onMounted(() => window.addEventListener('pagehide', onPageHide));
    // Leaving the view must not lose an edit, so what is unsaved is sent without waiting.
    onUnmounted(() => {
      window.removeEventListener('pagehide', onPageHide);
      void flush();
    });
  }

  return {
    status: readonly(computed(() => statusOf(state.value.phase))),
    message: readonly(computed(() => messageOf(state.value.phase, Boolean(options.keepOnRefusal)))),
    unsaved: computed(() => unsavedIn(state.value.phase)),
    edited,
    hold,
    flush,
    retry,
    forgetUnsendable,
    forget,
  };
}
