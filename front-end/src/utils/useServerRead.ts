import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type Ref } from 'vue';
import { getApiErrorMessage } from '@/utils/api';

/**
 * Where a screen's read of the server stands for the key it is open on (T277 ticket 11).
 *
 * Each screen held its own data, loading flag and error, read on a watch of the market id and
 * checked each answer by hand, so a screen moved from market A to market B could show A's answer,
 * or A's refusal, under B's name. One table now holds every such read.
 */
export type ReadPhase =
  /** No key, or a lazy read not asked yet. */
  | 'empty'
  /** A read of this key is out and nothing of it is held. */
  | 'loading'
  | 'ready'
  /** A re-read is out; data is held. */
  | 'refreshing'
  /** The first read of this key failed; nothing held. */
  | 'failed'
  /** A re-read failed; data kept, as it was last read. */
  | 'refresh_failed'
  /** Only with `options.missing`: gone, or not this person's. */
  | 'missing';

export interface ReadState<K, T> {
  key: K | null;
  phase: ReadPhase;
  data: T | null;
  /** The failure said: in failed and refresh_failed, and in refreshing from refresh_failed. */
  sentence: string;
  /** When the data held was read, in milliseconds; null with no data. */
  readAt: number | null;
  /** The newest read asked: an answer to any other is dropped. */
  asked: number;
  /** Writes out under holdWhile on this key. */
  holding: number;
}

export type ReadEvent<K, T> =
  | { kind: 'key'; key: K | null; lazy: boolean }
  | { kind: 'ask' }
  | { kind: 'answer'; asked: number; data: T; at: number }
  | { kind: 'failure'; asked: number; sentence: string; missing: boolean }
  | { kind: 'hold' }
  | { kind: 'release'; key: K }
  | { kind: 'adopt'; key: K; change: (data: T) => T };

/** Keys are the same by `Object.is`, or element by element when both are arrays. */
function sameKey(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((one, i) => Object.is(one, b[i]));
}

/** `ask` from the phase held, with no write out: rows 5, 6, 9, 12, 13 and 14. */
function asking<K, T>(state: ReadState<K, T>): ReadState<K, T> {
  const asked = state.asked + 1;
  switch (state.phase) {
    case 'empty':
      return state.key === null ? state : { ...state, phase: 'loading', asked };
    case 'ready':
      return { ...state, phase: 'refreshing', asked };
    case 'refresh_failed':
      // The failure stays said while the next re-read is out, so it does not blink on a clock.
      return { ...state, phase: 'refreshing', asked };
    case 'failed':
    case 'missing':
      return { ...state, phase: 'loading', sentence: '', asked };
    case 'loading':
    case 'refreshing':
      // The read out is overtaken.
      return { ...state, asked };
  }
}

/**
 * The next state; the same object when the event changes nothing.
 *
 * The rows are the spec's (T421): a key change empties the state in one step, so nothing of the
 * last key is held under the new one; only the newest read asked lands; a write held on the key
 * keeps every read asked before or during it from landing, since the server may have served it
 * before the write, and its release asks again; a write's own answer is adopted only for its key.
 */
export function readStep<K, T>(state: ReadState<K, T>, event: ReadEvent<K, T>): ReadState<K, T> {
  switch (event.kind) {
    case 'key': {
      if (sameKey(event.key, state.key)) return state;
      const cleared = {
        key: event.key,
        data: null,
        sentence: '',
        readAt: null,
        holding: 0,
        asked: state.asked + 1,
      };
      if (event.key === null || event.lazy) return { ...cleared, phase: 'empty' };
      return { ...cleared, phase: 'loading' };
    }
    case 'ask':
      return state.holding > 0 ? state : asking(state);
    case 'answer':
      if (event.asked !== state.asked || state.holding > 0) return state;
      if (state.phase !== 'loading' && state.phase !== 'refreshing') return state;
      return { ...state, phase: 'ready', data: event.data, readAt: event.at, sentence: '' };
    case 'failure':
      if (event.asked !== state.asked || state.holding > 0) return state;
      if (state.phase !== 'loading' && state.phase !== 'refreshing') return state;
      if (event.missing) {
        return { ...state, phase: 'missing', data: null, readAt: null, sentence: '' };
      }
      return {
        ...state,
        phase: state.phase === 'loading' ? 'failed' : 'refresh_failed',
        sentence: event.sentence,
      };
    case 'hold':
      return state.key === null ? state : { ...state, holding: state.holding + 1 };
    case 'release': {
      if (!sameKey(event.key, state.key) || state.holding === 0) return state;
      const released = { ...state, holding: state.holding - 1 };
      return released.holding > 0 ? released : asking(released);
    }
    case 'adopt': {
      if (!sameKey(event.key, state.key) || state.data === null) return state;
      if (state.phase === 'ready' || state.phase === 'refresh_failed') {
        return { ...state, data: event.change(state.data) };
      }
      if (state.phase === 'refreshing') {
        // The read out was asked before the write's answer, unless a write still holds the key.
        const asked = state.holding === 0 ? state.asked + 1 : state.asked;
        return { ...state, data: event.change(state.data), asked };
      }
      return state;
    }
  }
}

export interface ServerReadOptions<T, K> {
  /** getApiErrorMessage's fallback for a failed first read. */
  failure: string;
  /** Said when a re-read fails with data held; by default the failure's own sentence. */
  refreshFailure?: string;
  /** A failure that means the thing is gone for this person: the market store's 404 and 403. */
  missing?: (error: unknown) => boolean;
  /** Read only when asked: a key change moves to empty, never loading (row 4). */
  lazy?: boolean;
  /** Each answer that lands, with its key: the market store remembers the market last opened. */
  landed?: (data: T, key: K) => void;
  /** A failure taken as missing, with its key: the market store forgets the pointer to it. */
  gone?: (key: K) => void;
}

export type WriteOutcome<R> =
  { kind: 'ok'; answer: R } | { kind: 'failed'; error: unknown } | { kind: 'left' };

export interface ServerRead<K, T> {
  key: Readonly<Ref<K | null>>;
  phase: Readonly<Ref<ReadPhase>>;
  data: Readonly<Ref<T | null>>;
  sentence: Readonly<Ref<string>>;
  readAt: Readonly<Ref<number | null>>;
  /** Ask again (Refresh, Try again, a clock); resolves when this read lands, fails or is dropped. */
  reread(): Promise<void>;
  /** Resolves when the newest read out settles, at once with none out: the market store's `open`. */
  settled(): Promise<void>;
  /** A write on the current key: reads asked before or during it never land, and it ends in a re-read. */
  holdWhile<R>(write: (key: K) => Promise<R>): Promise<WriteOutcome<R>>;
  /** Take a write's own answer into the data, for the key it was made on (rows 20 to 23). */
  adopt(key: K, change: (data: T) => T): void;
}

/**
 * A screen's read of the server, keyed (T277 ticket 11): `readStep`'s table, with the reads it asks
 * for sent and their answers stepped in.
 *
 * The key is watched synchronously, so the state moves in the same tick as the key: nothing reads
 * the last key's data under the new one, not even for a frame. Each read is numbered, and only the
 * newest lands. Once the scope is gone (a component unmounted) nothing out lands, and no `landed`
 * or `gone` is called.
 *
 * A write goes through `holdWhile`: it is made on the key open when it starts, and answers `left`,
 * never `failed`, when the key moved before it answered, so another market's refusal is never
 * said. Adopt the write's answer inside the write, on the key it is handed: the key is still held
 * there, so the re-read its release asks is the only one. An adopt after the release, while that
 * re-read is out, overtakes it and reads once more (row 22).
 *
 * No timer and no retry of its own: a fetcher that needs a timeout gives one to axios, and a clock
 * is the screen's.
 */
export function useServerRead<K, T>(
  key: () => K | null,
  fetcher: (key: K) => Promise<T>,
  options: ServerReadOptions<T, K>,
): ServerRead<K, T> {
  const state = shallowRef<ReadState<K, T>>({
    key: null,
    phase: 'empty',
    data: null,
    sentence: '',
    readAt: null,
    asked: 0,
    holding: 0,
  });
  /** The scope is gone: nothing out lands. */
  let gone = false;
  /** Counts each change of key, so a write made on one opening of a key never releases another. */
  let opening = 0;
  /** Each read out, by its number, settled once its answer was stepped in or dropped. */
  const out = new Map<number, Promise<void>>();

  function step(event: ReadEvent<K, T>): boolean {
    const before = state.value;
    const after = readStep(before, event);
    if (after === before) return false;
    state.value = after;
    const reading = after.phase === 'loading' || after.phase === 'refreshing';
    if (after.asked > before.asked && reading && after.key !== null) send(after.asked, after.key);
    return true;
  }

  function send(asked: number, forKey: K): void {
    let request: Promise<T>;
    try {
      request = fetcher(forKey);
    } catch (error: unknown) {
      request = Promise.reject(error);
    }
    const handled = request.then(
      (data) => {
        if (gone) return;
        if (step({ kind: 'answer', asked, data, at: Date.now() })) options.landed?.(data, forKey);
      },
      (error: unknown) => {
        if (gone) return;
        const missing = options.missing?.(error) ?? false;
        const sentence =
          state.value.phase === 'refreshing'
            ? (options.refreshFailure ?? getApiErrorMessage(error, options.failure))
            : getApiErrorMessage(error, options.failure);
        if (step({ kind: 'failure', asked, sentence, missing }) && missing) options.gone?.(forKey);
      },
    );
    const settledOne = handled.finally(() => out.delete(asked));
    out.set(asked, settledOne);
  }

  watch(
    key,
    (next) => {
      if (gone) return;
      if (step({ kind: 'key', key: next, lazy: options.lazy ?? false })) opening += 1;
    },
    { flush: 'sync', immediate: true },
  );

  if (getCurrentScope()) {
    onScopeDispose(() => {
      gone = true;
      state.value = { ...state.value, asked: state.value.asked + 1 };
    });
  }

  function reread(): Promise<void> {
    if (gone || !step({ kind: 'ask' })) return Promise.resolve();
    return out.get(state.value.asked) ?? Promise.resolve();
  }

  function settled(): Promise<void> {
    return out.get(state.value.asked) ?? Promise.resolve();
  }

  async function holdWhile<R>(write: (key: K) => Promise<R>): Promise<WriteOutcome<R>> {
    const madeOn = state.value.key;
    if (gone || madeOn === null) return { kind: 'left' };
    const mine = opening;
    step({ kind: 'hold' });
    let outcome: WriteOutcome<R>;
    try {
      outcome = { kind: 'ok', answer: await write(madeOn) };
    } catch (error: unknown) {
      outcome = { kind: 'failed', error };
    }
    if (gone || mine !== opening) return { kind: 'left' };
    step({ kind: 'release', key: madeOn });
    return outcome;
  }

  function adopt(forKey: K, change: (data: T) => T): void {
    if (!gone) step({ kind: 'adopt', key: forKey, change });
  }

  return {
    key: computed(() => state.value.key),
    phase: computed(() => state.value.phase),
    data: computed(() => state.value.data),
    sentence: computed(() => state.value.sentence),
    readAt: computed(() => state.value.readAt),
    reread,
    settled,
    holdWhile,
    adopt,
  };
}
