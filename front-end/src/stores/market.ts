/**
 * The open market, exactly as the server last reported it (E21/F02/S01).
 *
 * The back end is the only source of truth about a market. This is its one holder in the browser:
 * every market screen, the phase rail and every tab read the market from here, and nothing else
 * keeps a copy of its own. It used to be held three ways at once - a view's ref, a value one tab
 * published for its siblings, and `localStorage` - written by eleven call sites that each patched
 * their own copy, which is how the form builder came to ignore a phase change until the organizer
 * left the tab (the-market-frame ticket 02).
 *
 * The rules, from the-market-frame ticket 03:
 *
 * - **Keyed by the route's id.** A market held for one id is never shown while another is open,
 *   not even for a frame; an answer for a market no longer open is dropped.
 * - **Fetched on every arrival**, and re-read (`refresh`) after every write that changes the market.
 *   Nothing patches what is held: a write is followed by asking the server, so no caller needs to
 *   know which fields its write touched.
 * - **What it holds is shown while a re-read of the same market is in flight**, so returning to a
 *   screen or saving does not blank it.
 * - **A missing market and one the organizer cannot reach read identically.** Anything else that
 *   fails is `failed` when nothing is held, and `refresh` is the retry; a failed RE-read keeps what
 *   it holds and reads `refresh_failed`, so a dropped connection never unmounts a screen's unsaved
 *   work, and the frame says once that what is shown is as it was last read.
 * - An editor's unsaved work is the editor's own working copy, never layered on this.
 *
 * The read is keyed by the open id (`useServerRead`, T421): its phase is the store's `status`, one
 * union, so the store can never read failed and old at once, as it could with a `stale` flag beside
 * the status after a failed re-read of one market and a failed arrival of the next.
 */
import axios from 'axios';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Market } from '@/assets/types/datatypes';
import { api, onMarketChanged } from '@/utils/api';
import { parseMarketFromApi } from '@/utils/market';
import { forgetLastMarket, lastMarketId, rememberLastMarket } from '@/utils/lastMarket';
import { useServerRead, type ReadPhase } from '@/utils/useServerRead';

/** Where the open market's read stands: the keyed read's phase, `missing` included. */
export type MarketStatus = ReadPhase;

/** Gone, or no longer this organizer's to see: the two read identically. */
function isMissing(err: unknown): boolean {
  const code = axios.isAxiosError(err) ? err.response?.status : undefined;
  return code === 404 || code === 403;
}

export const useMarketStore = defineStore('market', () => {
  /** The id that is open: the read's key, set by `open` and emptied by `clear`. */
  const marketId = ref<string | null>(null);

  const read = useServerRead<string, Market>(
    () => marketId.value,
    async (id) => {
      const response = await api.get(`/markets/${encodeURIComponent(id)}`);
      return parseMarketFromApi(response.data.market);
    },
    {
      failure: 'This market could not be loaded.',
      missing: isMissing,
      // Arriving at a market is what opening one means, so this is the one place the pointer behind
      // "Previously opened" is set - by the list, a link, a bookmark or a new market alike.
      landed: (_market, id) => rememberLastMarket(id),
      gone: (id) => {
        if (lastMarketId() === id) forgetLastMarket();
      },
    },
  );

  /** The market as the server last reported it - only ever the one for the id that is open. */
  const market = read.data;
  const status = read.phase;
  /**
   * A re-read of the open market failed and none has landed since: what is held is as it was last
   * read. True in `refresh_failed` and in the `refreshing` that follows it, which keeps the failure
   * said, so the frame's line does not blink while the next re-read is out.
   */
  const rereadFailed = computed(
    () =>
      status.value === 'refresh_failed' ||
      (status.value === 'refreshing' && read.sentence.value !== ''),
  );

  /** Re-read the open market; nothing to do with none open. */
  function refresh(): Promise<void> {
    return read.reread();
  }

  /** Open a market by id, or re-read it when it is the one already open. */
  function open(id: string): Promise<void> {
    if (id === marketId.value) void read.reread();
    else marketId.value = id;
    return read.settled();
  }

  /** Forget the market entirely - on signing out, so one account never sees another's. */
  function clear(): void {
    marketId.value = null;
  }

  return { marketId, market, status, rereadFailed, open, refresh, clear };
});

/**
 * Re-read the open market whenever a write meets "market changed" (`onMarketChanged`): the write
 * stored nothing, and what the screens hold is older than the server's, so every surface reading
 * this store follows the market as it now stands. Installed once, beside the session's
 * interceptor (`main.ts`). Answers the function that removes it.
 */
export function installMarketChanged(): () => void {
  return onMarketChanged(() => void useMarketStore().refresh());
}
