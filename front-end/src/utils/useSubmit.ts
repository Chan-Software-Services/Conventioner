import { computed, getCurrentScope, onScopeDispose, shallowRef, watch } from 'vue';
import { getApiErrorMessage, SERVER_FAULT_MESSAGE } from '@/utils/api';

/**
 * Where a form's submit stands: being filled in, its request out, refused with the sentence to
 * say, or done.
 */
export type SubmitPhase =
  | { kind: 'editing' }
  | { kind: 'sending' }
  | { kind: 'refused'; sentence: string }
  | { kind: 'done' };

/** The phase, and the opening it belongs to: each new opening of the form counts one more. */
export interface SubmitState {
  phase: SubmitPhase;
  opening: number;
}

export type SubmitEvent =
  | { kind: 'submit' }
  | { kind: 'ok'; opening: number }
  | { kind: 'refused'; opening: number; sentence: string }
  | { kind: 'edit' }
  | { kind: 'open' };

const EDITING: SubmitPhase = { kind: 'editing' };

/**
 * The next state; the same object when the event is refused or belongs to an earlier opening.
 *
 * One table for a page form and a dialog alike (T277 ticket 08, report 4.8): a submit is taken
 * from any phase but `sending`, so a second press while one is out sends nothing; an answer moves
 * only the opening it was sent in, so an answer that lands after the form moved on (another way
 * in, another step, a dialog closed and opened again) touches nothing; an edit takes a refusal, or
 * a save that stays open, back to editing; an opening starts editing again whatever was out.
 */
export function submitStep(state: SubmitState, event: SubmitEvent): SubmitState {
  const { phase } = state;
  switch (event.kind) {
    case 'open':
      return { phase: EDITING, opening: state.opening + 1 };
    case 'submit':
      return phase.kind === 'sending' ? state : { ...state, phase: { kind: 'sending' } };
    case 'edit':
      return phase.kind === 'refused' || phase.kind === 'done'
        ? { ...state, phase: EDITING }
        : state;
    case 'ok':
      return phase.kind === 'sending' && event.opening === state.opening
        ? { ...state, phase: { kind: 'done' } }
        : state;
    case 'refused':
      return phase.kind === 'sending' && event.opening === state.opening
        ? { ...state, phase: { kind: 'refused', sentence: event.sentence } }
        : state;
  }
}

/** An answer that landed after its opening had gone: what it was, for the form to hand on. */
export type LateAnswer<T> = { ok: true; answer: T } | { ok: false; error: unknown };

export interface SubmitHandlers<T> {
  /** The answer of the opening it was sent in, once the phase is `done`. */
  done?: (answer: T) => void | Promise<void>;
  /**
   * A refusal of the opening it was sent in: its side effects, and the sentence to say. Nothing
   * returned, or no handler, says the server's sentence, else the form's `failure`.
   */
  refused?: (error: unknown) => string | void;
  /** An answer or refusal that landed after the form moved to another opening. */
  late?: (answer: LateAnswer<T>) => void;
}

export interface SubmitOptions {
  /** What the form is open on (its mode, its step): a change of it is a new opening. */
  scope?: () => unknown;
  /** The sentence for a refusal with none of its own. */
  failure?: string;
}

/**
 * A form's submit, held by `submitStep`'s table (T277 ticket 08).
 *
 * `submit(send, handlers)` sends nothing while one is out; otherwise it awaits `send()` and hands
 * the answer to `done` or `refused` when the form is still in the opening it was sent in, and to
 * `late` when it is not. A change of `scope` is a new opening, at once (a synchronous watch, so no
 * answer can land between the change and the opening). Once the component is gone no handler is
 * called, `late` included: the screen it would speak to is gone.
 *
 * No timer and no retry: a request that never answers is left to a reload.
 */
export function useSubmit(options: SubmitOptions = {}) {
  const failure = options.failure ?? SERVER_FAULT_MESSAGE;
  const state = shallowRef<SubmitState>({ phase: EDITING, opening: 0 });
  let gone = false;

  function step(event: SubmitEvent) {
    state.value = submitStep(state.value, event);
  }

  if (options.scope) watch(options.scope, () => step({ kind: 'open' }), { flush: 'sync' });
  if (getCurrentScope()) {
    onScopeDispose(() => {
      gone = true;
      step({ kind: 'open' });
    });
  }

  const phase = computed(() => state.value.phase);
  const sending = computed(() => phase.value.kind === 'sending');
  const sentence = computed(() => (phase.value.kind === 'refused' ? phase.value.sentence : ''));

  async function submit<T>(send: () => Promise<T>, handlers: SubmitHandlers<T> = {}) {
    const before = state.value;
    step({ kind: 'submit' });
    if (state.value === before) return;
    const opening = state.value.opening;
    let answer: T;
    try {
      answer = await send();
    } catch (error: unknown) {
      if (gone) return;
      if (state.value.opening !== opening) {
        handlers.late?.({ ok: false, error });
        return;
      }
      const said = handlers.refused?.(error);
      step({
        kind: 'refused',
        opening,
        sentence: typeof said === 'string' ? said : getApiErrorMessage(error, failure),
      });
      return;
    }
    if (gone) return;
    if (state.value.opening !== opening) {
      handlers.late?.({ ok: true, answer });
      return;
    }
    step({ kind: 'ok', opening });
    await handlers.done?.(answer);
  }

  /** A field changed: a refusal, or a save that stays open, goes back to editing. */
  function edit() {
    step({ kind: 'edit' });
  }

  return { phase, sending, sentence, submit, edit };
}

export type Submission = ReturnType<typeof useSubmit>;
