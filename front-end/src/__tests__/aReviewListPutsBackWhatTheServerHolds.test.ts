/**
 * A list saved on the market a click at a time (E19/F03, E33/F03) writes one click at a time
 * (T420): a click made while a write is out waits for its answer and is then sent with the list as
 * it stands, and a write that does not land puts back what the server holds, with the reason. Two
 * quick clicks used to put two writes out at once, and when both failed the first click stayed on
 * screen beside the error, though the server never took it (T277's probe 12).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { MARKET_CHANGED_CODE } from '@/utils/api';
import type { Market } from '@/assets/types/datatypes';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/stores/market', () => ({ useMarketStore: () => ({ refresh }) }));

import { useSavedOnTheMarket } from '@/utils/savedOnTheMarket';

type Held = { list: string[]; none?: boolean };
type Answer = { list: string[]; none: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function answer(status: number, data: unknown): AxiosError {
  const config = { headers: {} } as InternalAxiosRequestConfig;
  const response = { status, data, statusText: '', headers: {}, config };
  return new AxiosError('Request failed', undefined, config, {}, response as never);
}

const CHANGED_SENTENCE = 'Someone else changed this market.';

function list(start: Held, write: ReturnType<typeof vi.fn>) {
  const market = ref({ id: 'm1', ...start } as unknown as Market & Held);
  const saved = useSavedOnTheMarket<string>(
    market,
    (held) => (held as unknown as Held).list,
    write as never,
    'failed',
    (held) => Boolean((held as unknown as Held).none),
  );
  return { market, ...saved };
}

beforeEach(() => refresh.mockClear());

describe('a review list writes one click at a time', () => {
  it('puts back the stored list after two quick clicks whose write fails, with the reason', async () => {
    const first = deferred<Answer>();
    const write = vi.fn().mockReturnValueOnce(first.promise);
    const { value, error, save } = list({ list: ['stored'] }, write);

    const a = save(['stored', 'first']);
    const b = save(['stored', 'first', 'second']);
    expect(write).toHaveBeenCalledTimes(1);
    expect(value.value).toEqual(['stored', 'first', 'second']);

    first.reject(new Error('offline'));
    await Promise.all([a, b]);

    // The click behind the failed write is dropped with it: the screen has no Retry.
    expect(write).toHaveBeenCalledTimes(1);
    expect(error.value).toBe('failed');
    expect(value.value).toEqual(['stored']);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('sends the click made while a write was out when it answers, with the list as it stands', async () => {
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { value, save } = list({ list: [] }, write);

    const a = save(['a']);
    const b = save(['a', 'b']);
    const c = save(['a', 'b', 'c']);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1]).toEqual(['a']);

    first.resolve({ list: ['a'], none: false });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    // The answer of the first write does not take back the clicks after it.
    expect(value.value).toEqual(['a', 'b', 'c']);
    expect(write.mock.calls[1][1]).toEqual(['a', 'b', 'c']);

    second.resolve({ list: ['a', 'b', 'c'], none: false });
    await Promise.all([a, b, c]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(value.value).toEqual(['a', 'b', 'c']);
  });

  it('keeps a write that landed on screen when the one after it fails', async () => {
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { value, error, save } = list({ list: ['stored'] }, write);

    const a = save(['stored', 'first']);
    const b = save(['stored', 'first', 'second']);
    first.resolve({ list: ['stored', 'first'], none: false });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(value.value).toEqual(['stored', 'first', 'second']);

    second.reject(new Error('offline'));
    await Promise.all([a, b]);
    expect(value.value).toEqual(['stored', 'first']);
    expect(error.value).toBe('failed');
  });

  it('re-reads the market once the queue is through, and not between its writes', async () => {
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { save } = list({ list: [] }, write);

    const a = save(['a']);
    const b = save(['a', 'b']);
    first.resolve({ list: ['a'], none: false });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(refresh).not.toHaveBeenCalled();

    second.resolve({ list: ['a', 'b'], none: false });
    await Promise.all([a, b]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ignores a re-read that lands while a click waits behind the write out', async () => {
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { market, value, save } = list({ list: [] }, write);

    const a = save(['a']);
    const b = save(['a', 'b']);
    // A re-read from before the clicks.
    market.value = { ...market.value, list: [] } as unknown as Market & Held;
    await nextTick();
    expect(value.value).toEqual(['a', 'b']);

    first.resolve({ list: ['a'], none: false });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    market.value = { ...market.value, list: ['a'] } as unknown as Market & Held;
    await nextTick();
    expect(value.value).toEqual(['a', 'b']);

    second.resolve({ list: ['a', 'b'], none: false });
    await Promise.all([a, b]);
    expect(value.value).toEqual(['a', 'b']);
  });

  it('queues a choice of none behind the write out, and puts back what the server holds when it fails', async () => {
    const first = deferred<Answer>();
    const write = vi.fn().mockReturnValueOnce(first.promise);
    const { value, none, error, save, chooseNone } = list({ list: ['stored'] }, write);

    const a = save(['stored', 'first']);
    const b = chooseNone();
    expect(write).toHaveBeenCalledTimes(1);
    expect(value.value).toEqual([]);
    expect(none.value).toBe(true);

    first.reject(new Error('offline'));
    await Promise.all([a, b]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(value.value).toEqual(['stored']);
    expect(none.value).toBe(false);
    expect(error.value).toBe('failed');
  });

  it('sends a choice of none queued behind a write that landed', async () => {
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { value, none, save, chooseNone } = list({ list: [] }, write);

    const a = save(['first']);
    const b = chooseNone();
    first.resolve({ list: ['first'], none: false });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[1].slice(1)).toEqual([[], true]);
    expect(none.value).toBe(true);

    second.resolve({ list: [], none: true });
    await Promise.all([a, b]);
    expect(value.value).toEqual([]);
    expect(none.value).toBe(true);
  });

  it('puts back a choice of none the server held when a mark after it fails', async () => {
    const first = deferred<Answer>();
    const write = vi.fn().mockReturnValueOnce(first.promise);
    const { value, none, save } = list({ list: [], none: true }, write);

    const a = save(['first']);
    expect(none.value).toBe(false);
    first.reject(new Error('offline'));
    await a;
    expect(value.value).toEqual([]);
    expect(none.value).toBe(true);
  });

  it('shows the list the market now holds when the market changed under the write', async () => {
    const first = deferred<Answer>();
    const write = vi.fn().mockReturnValueOnce(first.promise);
    const { market, value, error, save } = list({ list: ['stored'] }, write);

    const a = save(['stored', 'first']);
    const b = save(['stored', 'first', 'second']);
    // The store re-reads the market on that refusal (ADR 0024); here the re-read lands first.
    market.value = {
      ...market.value,
      list: ['stored', 'from another tab'],
    } as unknown as Market & Held;
    first.reject(answer(409, { error: CHANGED_SENTENCE, code: MARKET_CHANGED_CODE }));
    await Promise.all([a, b]);

    expect(write).toHaveBeenCalledTimes(1);
    expect(value.value).toEqual(['stored', 'from another tab']);
    expect(error.value).toBe(CHANGED_SENTENCE);
  });

  it('takes the market changed re-read that lands after the refusal', async () => {
    const first = deferred<Answer>();
    const write = vi.fn().mockReturnValueOnce(first.promise);
    const { market, value, error, save } = list({ list: ['stored'] }, write);

    const a = save(['stored', 'first']);
    first.reject(answer(409, { error: CHANGED_SENTENCE, code: MARKET_CHANGED_CODE }));
    await a;
    expect(value.value).toEqual(['stored']);

    market.value = {
      ...market.value,
      list: ['stored', 'from another tab'],
    } as unknown as Market & Held;
    await nextTick();
    expect(value.value).toEqual(['stored', 'from another tab']);
    expect(error.value).toBe(CHANGED_SENTENCE);
  });

  it('clears the reason at the next click and sends it', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async (_id: string, l: string[], n: boolean) => ({
        list: l,
        none: n,
      }));
    const { value, error, save } = list({ list: [] }, write);

    await save(['a']);
    expect(error.value).toBe('failed');
    const next = save(['b']);
    expect(error.value).toBe('');
    await next;
    expect(write).toHaveBeenCalledTimes(2);
    expect(value.value).toEqual(['b']);
    expect(error.value).toBe('');
  });
});
