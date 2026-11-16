// @vitest-environment happy-dom
/**
 * A read belongs to its key (T277 ticket 11, T421).
 *
 * Each screen held its own data, loading flag and error, read on a watch of the market id and
 * checked each answer by hand, nine guards under eight names, or none: moved from market A to
 * market B, a screen could show A's answer, or A's refusal, under B's name. `readStep` is the one
 * table every keyed read moves by, one test per row here; `useServerRead` sends the reads it asks
 * for and steps their answers in, driven below through a tiny component the way a screen is.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { AxiosError } from 'axios';
import { defineComponent, h, nextTick, ref } from 'vue';

import {
  readStep,
  useServerRead,
  type ReadEvent,
  type ReadPhase,
  type ReadState,
  type ServerRead,
  type ServerReadOptions,
} from '@/utils/useServerRead';
import { OFFLINE_MESSAGE, SERVER_FAULT_MESSAGE } from '@/utils/api';

type Rows = string[];

function at(
  phase: ReadPhase,
  more: Partial<ReadState<string, Rows>> = {},
): ReadState<string, Rows> {
  const held = phase === 'ready' || phase === 'refreshing' || phase === 'refresh_failed';
  return {
    key: 'a',
    phase,
    data: held ? ['ana'] : null,
    sentence: phase === 'failed' || phase === 'refresh_failed' ? 'It failed.' : '',
    readAt: held ? 100 : null,
    asked: 5,
    holding: 0,
    ...more,
  };
}

const step = (state: ReadState<string, Rows>, event: ReadEvent<string, Rows>) =>
  readStep(state, event);

const answer = (asked: number, data: Rows = ['ben']): ReadEvent<string, Rows> => ({
  kind: 'answer',
  asked,
  data,
  at: 200,
});
const failure = (asked: number, missing = false): ReadEvent<string, Rows> => ({
  kind: 'failure',
  asked,
  sentence: 'Could not.',
  missing,
});
const ask: ReadEvent<string, Rows> = { kind: 'ask' };
const keyed = (key: string | null, lazy = false): ReadEvent<string, Rows> => ({
  kind: 'key',
  key,
  lazy,
});
const adopt = (key: string): ReadEvent<string, Rows> => ({
  kind: 'adopt',
  key,
  change: (rows) => [...rows, 'cy'],
});

const PHASES: ReadPhase[] = [
  'empty',
  'loading',
  'ready',
  'refreshing',
  'failed',
  'refresh_failed',
  'missing',
];
const CLEARED = { data: null, sentence: '', readAt: null, holding: 0 };

describe('readStep, row by row', () => {
  it.each(PHASES)('1: the same key changes nothing, from %s', (phase) => {
    const state = at(phase, { holding: 1 });
    expect(step(state, keyed('a'))).toBe(state);
    const arrayKeyed = { ...state, key: ['m', 'e'] } as unknown as ReadState<string, Rows>;
    expect(readStep(arrayKeyed, { kind: 'key', key: ['m', 'e'], lazy: false } as never)).toBe(
      arrayKeyed,
    );
  });

  it.each(PHASES)('2: no key empties, from %s, sending nothing', (phase) => {
    expect(step(at(phase, { holding: 1 }), keyed(null))).toEqual({
      ...CLEARED,
      key: null,
      phase: 'empty',
      asked: 6,
    });
  });

  it.each(PHASES)('3: another key loads it with nothing held, from %s', (phase) => {
    expect(step(at(phase, { holding: 1 }), keyed('b'))).toEqual({
      ...CLEARED,
      key: 'b',
      phase: 'loading',
      asked: 6,
    });
  });

  it.each(PHASES)('4: another key, lazy, is empty on that key, from %s', (phase) => {
    expect(step(at(phase, { holding: 1 }), keyed('b', true))).toEqual({
      ...CLEARED,
      key: 'b',
      phase: 'empty',
      asked: 6,
    });
  });

  it('5: an ask on a key held and not read loads it', () => {
    expect(step(at('empty'), ask)).toEqual({ ...at('empty'), phase: 'loading', asked: 6 });
  });

  it('6: an ask with no key changes nothing', () => {
    const state = at('empty', { key: null });
    expect(step(state, ask)).toBe(state);
  });

  it('7: the newest answer of a first read is ready', () => {
    expect(step(at('loading'), answer(5))).toEqual({
      ...at('loading'),
      phase: 'ready',
      data: ['ben'],
      readAt: 200,
    });
  });

  it('8: the newest failure of a first read is failed, or missing', () => {
    expect(step(at('loading'), failure(5))).toEqual({
      ...at('loading'),
      phase: 'failed',
      sentence: 'Could not.',
    });
    expect(step(at('loading'), failure(5, true))).toEqual({ ...at('loading'), phase: 'missing' });
  });

  it('9: an ask on ready re-reads', () => {
    expect(step(at('ready'), ask)).toEqual({ ...at('ready'), phase: 'refreshing', asked: 6 });
  });

  it('10: the newest answer of a re-read replaces the data', () => {
    const state = at('refreshing', { sentence: 'Old failure.' });
    expect(step(state, answer(5))).toEqual({
      ...state,
      phase: 'ready',
      data: ['ben'],
      readAt: 200,
      sentence: '',
    });
  });

  it('11: the newest failure of a re-read keeps the data, or is missing with none', () => {
    expect(step(at('refreshing'), failure(5))).toEqual({
      ...at('refreshing'),
      phase: 'refresh_failed',
      sentence: 'Could not.',
    });
    expect(step(at('refreshing'), failure(5, true))).toEqual({
      ...at('refreshing'),
      phase: 'missing',
      data: null,
      readAt: null,
    });
  });

  it('12: an ask on refresh_failed re-reads, the failure still said', () => {
    expect(step(at('refresh_failed'), ask)).toEqual({
      ...at('refresh_failed'),
      phase: 'refreshing',
      sentence: 'It failed.',
      asked: 6,
    });
  });

  it.each(['failed', 'missing'] as const)('13: an ask on %s loads again', (phase) => {
    expect(step(at(phase), ask)).toEqual({
      ...at(phase),
      phase: 'loading',
      sentence: '',
      asked: 6,
    });
  });

  it.each(['loading', 'refreshing'] as const)(
    '14: an ask on %s overtakes the read out',
    (phase) => {
      expect(step(at(phase), ask)).toEqual({ ...at(phase), asked: 6 });
    },
  );

  it.each(['loading', 'refreshing'] as const)(
    '15: an answer or failure not the newest changes nothing, on %s',
    (phase) => {
      const state = at(phase);
      expect(step(state, answer(4))).toBe(state);
      expect(step(state, failure(4))).toBe(state);
      expect(step(state, failure(4, true))).toBe(state);
    },
  );

  it.each(PHASES)('16: a hold on a key held counts one more write, from %s', (phase) => {
    expect(step(at(phase, { holding: 1 }), { kind: 'hold' })).toEqual(at(phase, { holding: 2 }));
    const noKey = at('empty', { key: null });
    expect(step(noKey, { kind: 'hold' })).toBe(noKey);
  });

  it.each(['loading', 'refreshing'] as const)(
    '17: the newest answer or failure while a write is held changes nothing, on %s',
    (phase) => {
      const state = at(phase, { holding: 1 });
      expect(step(state, answer(5))).toBe(state);
      expect(step(state, failure(5))).toBe(state);
    },
  );

  it.each(PHASES)('18: an ask while a write is held changes nothing, on %s', (phase) => {
    const state = at(phase, { holding: 1 });
    expect(step(state, ask)).toBe(state);
  });

  it('19: a release counts one write less, and the last asks from the phase held', () => {
    expect(step(at('ready', { holding: 2 }), { kind: 'release', key: 'a' })).toEqual(
      at('ready', { holding: 1 }),
    );
    const released = (phase: ReadPhase) =>
      step(at(phase, { holding: 1 }), { kind: 'release', key: 'a' });
    expect(released('empty')).toEqual({ ...at('empty'), phase: 'loading', asked: 6 });
    expect(released('ready')).toEqual({ ...at('ready'), phase: 'refreshing', asked: 6 });
    expect(released('refresh_failed')).toEqual({
      ...at('refresh_failed'),
      phase: 'refreshing',
      asked: 6,
    });
    expect(released('failed')).toEqual({
      ...at('failed'),
      phase: 'loading',
      sentence: '',
      asked: 6,
    });
    expect(released('missing')).toEqual({ ...at('missing'), phase: 'loading', asked: 6 });
    expect(released('loading')).toEqual({ ...at('loading'), asked: 6 });
    expect(released('refreshing')).toEqual({ ...at('refreshing'), asked: 6 });
    // With nothing held, a release changes nothing.
    const free = at('ready');
    expect(step(free, { kind: 'release', key: 'a' })).toBe(free);
  });

  it.each(PHASES)('20: a release or an adopt of another key changes nothing, on %s', (phase) => {
    const state = at(phase, { holding: 1 });
    expect(step(state, { kind: 'release', key: 'b' })).toBe(state);
    expect(step(state, adopt('b'))).toBe(state);
  });

  it.each(['ready', 'refresh_failed'] as const)(
    "21: an adopt on %s takes the write's answer, the read's time kept",
    (phase) => {
      expect(step(at(phase), adopt('a'))).toEqual({ ...at(phase), data: ['ana', 'cy'] });
    },
  );

  it('22: an adopt while a re-read is out takes the answer and overtakes the read, unless a write holds', () => {
    expect(step(at('refreshing'), adopt('a'))).toEqual({
      ...at('refreshing'),
      data: ['ana', 'cy'],
      asked: 6,
    });
    expect(step(at('refreshing', { holding: 1 }), adopt('a'))).toEqual({
      ...at('refreshing', { holding: 1 }),
      data: ['ana', 'cy'],
    });
  });

  it.each(['empty', 'loading', 'failed', 'missing'] as const)(
    '23: an adopt on %s changes nothing: nothing is held to change',
    (phase) => {
      const state = at(phase);
      expect(step(state, adopt('a'))).toBe(state);
    },
  );

  it.each(['empty', 'ready', 'failed', 'refresh_failed', 'missing'] as const)(
    'any pair not listed changes nothing: an answer or failure on %s',
    (phase) => {
      const state = at(phase);
      expect(step(state, answer(5))).toBe(state);
      expect(step(state, failure(5))).toBe(state);
    },
  );
});

/* ---------------------------------------------------------------------------------------------- */

/** A promise the test settles when it chooses, to hold a request in flight. */
function held<T>() {
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

interface Asked {
  key: string;
  answer: ReturnType<typeof held<Rows>>;
}

/**
 * A tiny screen on `useServerRead`: it draws the phase, the rows and the sentence, and records
 * every phase and row it drew with the key it drew them under.
 */
function screen(
  options: Partial<ServerReadOptions<Rows, string>> = {},
  first: string | null = 'a',
) {
  const marketId = ref<string | null>(first);
  const asked: Asked[] = [];
  const drawn: string[] = [];
  let read!: ServerRead<string, Rows>;
  const Screen = defineComponent({
    setup() {
      read = useServerRead(
        () => marketId.value,
        (key) => {
          const answer = held<Rows>();
          asked.push({ key, answer });
          return answer.promise;
        },
        { failure: 'The rows could not be loaded.', ...options },
      );
      return () => {
        drawn.push(`${read.key.value}:${read.phase.value}:${(read.data.value ?? []).join(',')}`);
        return h(
          'p',
          `${read.phase.value}|${(read.data.value ?? []).join(',')}|${read.sentence.value}`,
        );
      };
    },
  });
  const wrapper = mount(Screen);
  return { wrapper, marketId, asked, drawn, read: () => read };
}

const offline = () => new AxiosError('Network Error', 'ERR_NETWORK');
const refused = (status: number, error?: string) =>
  Object.assign(new AxiosError('refused'), {
    response: { status, data: error ? { error } : {} },
  });

enableAutoUnmount(afterEach);

describe('useServerRead', () => {
  it('moves in the same tick as the key: the last key is never drawn under the new one', async () => {
    const s = screen();
    s.asked[0]!.answer.settle(['ana']);
    await flushPromises();
    expect(s.wrapper.text()).toBe('ready|ana|');

    s.marketId.value = 'b';
    // Before any render, the state is already the new key's.
    expect(s.read().phase.value).toBe('loading');
    expect(s.read().data.value).toBeNull();
    await nextTick();
    expect(s.drawn.every((d) => !d.startsWith('b:') || d === 'b:loading:')).toBe(true);
    expect(s.wrapper.text()).toBe('loading||');
    expect(s.asked.map((a) => a.key)).toEqual(['a', 'b']);
  });

  it("drops an old key's answer, and an overtaken one", async () => {
    const s = screen();
    s.marketId.value = 'b';
    s.asked[0]!.answer.settle(['ana']);
    await flushPromises();
    expect(s.wrapper.text()).toBe('loading||');

    void s.read().reread();
    s.asked[1]!.answer.settle(['ben']);
    await flushPromises();
    expect(s.wrapper.text()).toBe('loading||');
    s.asked[2]!.answer.settle(['cy']);
    await flushPromises();
    expect(s.wrapper.text()).toBe('ready|cy|');
  });

  it("drops an old key's failure, saying nothing", async () => {
    const s = screen();
    s.marketId.value = 'b';
    s.asked[0]!.answer.fail(refused(409, 'Not on this market.'));
    await flushPromises();
    expect(s.wrapper.text()).toBe('loading||');
  });

  it('a hold drops a read asked before it and ends in one re-read', async () => {
    const s = screen();
    s.asked[0]!.answer.settle(['ana']);
    await flushPromises();
    void s.read().reread();
    const write = held<string>();
    const outcome = s.read().holdWhile((key) => {
      expect(key).toBe('a');
      return write.promise;
    });
    // The read asked before the write answers with the roster from before it.
    s.asked[1]!.answer.settle(['stale']);
    await flushPromises();
    expect(s.wrapper.text()).toBe('refreshing|ana|');
    // A clock asking meanwhile sends nothing: the release re-reads.
    void s.read().reread();
    expect(s.asked).toHaveLength(2);

    write.settle('done');
    expect(await outcome).toEqual({ kind: 'ok', answer: 'done' });
    expect(s.asked).toHaveLength(3);
    s.asked[2]!.answer.settle(['ana', 'ben']);
    await flushPromises();
    expect(s.wrapper.text()).toBe('ready|ana,ben|');
  });

  it("an adopt inside the write takes its answer, and the release's re-read is the only one", async () => {
    const s = screen();
    s.asked[0]!.answer.settle(['ana']);
    await flushPromises();
    const outcome = await s.read().holdWhile(async (key) => {
      s.read().adopt(key, (rows) => [...rows, 'ben']);
    });
    expect(outcome.kind).toBe('ok');
    expect(s.wrapper.text()).toBe('refreshing|ana,ben|');
    expect(s.asked).toHaveLength(2);
  });

  it('a failed write answers failed on its key and still re-reads', async () => {
    const s = screen();
    s.asked[0]!.answer.settle(['ana']);
    await flushPromises();
    const error = refused(409);
    const outcome = await s.read().holdWhile(() => Promise.reject(error));
    expect(outcome).toEqual({ kind: 'failed', error });
    expect(s.asked).toHaveLength(2);
  });

  it('a write answering after the key moved is left, whatever it answered, and releases nothing', async () => {
    const s = screen();
    s.asked[0]!.answer.settle(['ana']);
    await flushPromises();
    const refusal = held<never>();
    const refusedWrite = s.read().holdWhile(() => refusal.promise);
    const accepted = held<string>();
    const acceptedWrite = s.read().holdWhile(() => accepted.promise);
    s.marketId.value = 'b';
    // Back on a: a new opening of the key, which the writes made on the first never release.
    s.asked[1]!.answer.settle(['ben']);
    s.marketId.value = 'a';
    const reopened = held<string>();
    const reopenedWrite = s.read().holdWhile(() => reopened.promise);

    refusal.fail(refused(409, 'Not seated.'));
    accepted.settle('done');
    expect(await refusedWrite).toEqual({ kind: 'left' });
    expect(await acceptedWrite).toEqual({ kind: 'left' });
    // The write of the second opening still holds: the first opening's read lands nothing.
    s.asked[2]!.answer.settle(['stale']);
    await flushPromises();
    expect(s.wrapper.text()).toBe('loading||');
    reopened.settle('done');
    expect((await reopenedWrite).kind).toBe('ok');
  });

  it('a write with no key is left and sends nothing', async () => {
    const s = screen({}, null);
    let sent = false;
    const outcome = await s.read().holdWhile(async () => {
      sent = true;
    });
    expect(outcome).toEqual({ kind: 'left' });
    expect(sent).toBe(false);
    expect(s.asked).toHaveLength(0);
  });

  it('after unmount, a write out is left, and a write asked is left unsent', async () => {
    const s = screen();
    const write = held<string>();
    const outcome = s.read().holdWhile(() => write.promise);
    const read = s.read();
    s.wrapper.unmount();
    write.settle('done');
    expect(await outcome).toEqual({ kind: 'left' });
    let sent = false;
    const late = await read.holdWhile(async () => {
      sent = true;
    });
    expect(late).toEqual({ kind: 'left' });
    expect(sent).toBe(false);
  });

  it.each([
    ['an answer', (s: ReturnType<typeof screen>) => s.asked[0]!.answer.settle(['ana'])],
    ['a failure', (s: ReturnType<typeof screen>) => s.asked[0]!.answer.fail(refused(404))],
  ])('after unmount, %s out lands nothing and calls nothing back', async (_name, settle) => {
    const landed: string[] = [];
    const gone: string[] = [];
    const s = screen({
      landed: (_rows, key) => landed.push(key),
      missing: () => true,
      gone: (key) => gone.push(key),
    });
    const read = s.read();
    s.wrapper.unmount();
    settle(s);
    await flushPromises();
    expect(read.phase.value).toBe('loading');
    expect(read.data.value).toBeNull();
    expect(landed).toEqual([]);
    expect(gone).toEqual([]);
  });

  it("ignores an adopt of another key, so a write's answer lands only on its own", async () => {
    const s = screen();
    s.asked[0]!.answer.settle(['ana']);
    await flushPromises();
    s.read().adopt('b', () => ['ben']);
    await nextTick();
    expect(s.wrapper.text()).toBe('ready|ana|');
  });

  it('settled resolves on the newest read, and at once with none out', async () => {
    const s = screen();
    let done = false;
    void s
      .read()
      .settled()
      .then(() => (done = true));
    await flushPromises();
    expect(done).toBe(false);
    s.asked[0]!.answer.settle(['ana']);
    await flushPromises();
    expect(done).toBe(true);
    let atOnce = false;
    void s
      .read()
      .settled()
      .then(() => (atOnce = true));
    await flushPromises();
    expect(atOnce).toBe(true);

    let reread = false;
    void s
      .read()
      .reread()
      .then(() => (reread = true));
    await flushPromises();
    expect(reread).toBe(false);
    s.asked[1]!.answer.fail(offline());
    await flushPromises();
    expect(reread).toBe(true);
  });

  it('says the failure by getApiErrorMessage, and a re-read by its own sentence when given', async () => {
    const s = screen({ refreshFailure: 'Could not update. The rows are as they were last read.' });
    s.asked[0]!.answer.fail(refused(400));
    await flushPromises();
    expect(s.wrapper.text()).toBe('failed||The rows could not be loaded.');

    void s.read().reread();
    s.asked[1]!.answer.fail(refused(503));
    await flushPromises();
    expect(s.wrapper.text()).toBe(`failed||${SERVER_FAULT_MESSAGE}`);

    void s.read().reread();
    s.asked[2]!.answer.settle(['ana']);
    await flushPromises();
    void s.read().reread();
    s.asked[3]!.answer.fail(offline());
    await flushPromises();
    expect(s.wrapper.text()).toBe(
      'refresh_failed|ana|Could not update. The rows are as they were last read.',
    );
  });

  it("a re-read's failure is the failure's own sentence with none given", async () => {
    const s = screen();
    s.asked[0]!.answer.settle(['ana']);
    await flushPromises();
    void s.read().reread();
    s.asked[1]!.answer.fail(offline());
    await flushPromises();
    expect(s.wrapper.text()).toBe(`refresh_failed|ana|${OFFLINE_MESSAGE}`);
  });

  it('a missing answer calls gone with its key, and a landed one calls landed', async () => {
    const landed: string[] = [];
    const gone: string[] = [];
    const s = screen({
      missing: (error) => (error as AxiosError).response?.status === 404,
      landed: (rows, key) => landed.push(`${key}:${rows.join(',')}`),
      gone: (key) => gone.push(key),
    });
    s.asked[0]!.answer.settle(['ana']);
    await flushPromises();
    s.marketId.value = 'b';
    s.asked[1]!.answer.fail(refused(404));
    await flushPromises();
    expect(s.wrapper.text()).toBe('missing||');
    expect(landed).toEqual(['a:ana']);
    expect(gone).toEqual(['b']);
  });

  it('a lazy read waits to be asked on each key', async () => {
    const s = screen({ lazy: true });
    expect(s.asked).toHaveLength(0);
    expect(s.wrapper.text()).toBe('empty||');
    void s.read().reread();
    expect(s.asked.map((a) => a.key)).toEqual(['a']);
    s.marketId.value = 'b';
    expect(s.asked).toHaveLength(1);
    expect(s.read().phase.value).toBe('empty');
  });

  it('an array key is the same key element by element', async () => {
    const marketId = ref('m');
    const email = ref('ana@example.com');
    const asked: string[][] = [];
    const Screen = defineComponent({
      setup() {
        useServerRead(
          () => [marketId.value, email.value] as const,
          (key) => {
            asked.push([...key]);
            return new Promise<Rows>(() => {});
          },
          { failure: 'Could not.' },
        );
        return () => h('p');
      },
    });
    mount(Screen);
    marketId.value = 'm';
    email.value = 'ana@example.com';
    await nextTick();
    expect(asked).toEqual([['m', 'ana@example.com']]);
    email.value = 'ben@example.com';
    expect(asked).toEqual([
      ['m', 'ana@example.com'],
      ['m', 'ben@example.com'],
    ]);
  });
});
