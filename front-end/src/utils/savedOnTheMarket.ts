import { ref, watch, type Ref } from 'vue';
import { isMarketChanged } from '@/utils/api';
import { useMarketStore } from '@/stores/market';
import { useAutosave } from '@/utils/useAutosave';
import type { Market } from '@/assets/types/datatypes';

/**
 * A list the market holds and a screen changes a click at a time: what a reviewer reads first
 * (E19/F03) and which answers reject automatically (E33/F03).
 *
 * Every change is shown at once, written whole, and followed by the store re-reading the market,
 * so every surface that reads the list moves with it (E21/F02/S02).
 *
 * It is the autosave's no-pause case (T420): one write out at a time, so they land in order. A
 * click made while a write is out is sent when it answers, with the list as it then stands, and
 * the market is re-read once the last of them lands. Two quick clicks used to put two writes out
 * at once; when both failed, the first click stayed on screen beside the error, though the server
 * never took it.
 *
 * A write that does not land drops the clicks behind it with it (the screen has no Retry), puts
 * back what the server last answered, never the click before, and says why. A write that landed
 * stays on screen when a later one fails.
 *
 * A re-read of the market that lands while a click is unsaved is ignored: it was asked for before
 * the click, and putting it on screen un-ticked what was just ticked. The write's own answer, and
 * the re-read after the last of them, bring the list up to date.
 *
 * A write the server refused because the market changed under it (ADR 0024) puts back the list
 * the market holds, not the one the server last answered: the store re-reads the market on that
 * refusal (`installMarketChanged`), and what the screen last confirmed is older than the server's.
 * Taken here when the re-read landed first, and by the watch below when it lands after.
 *
 * A list that a draft must decide before Review (T206) also carries the organizer's choice of none,
 * as the market holds it (`storedNone`) and as the write answers it.
 */
export function useSavedOnTheMarket<T>(
  market: Ref<Market | null | undefined>,
  stored: (market: Market) => T[] | undefined,
  write: (marketId: string, value: T[], none: boolean) => Promise<{ list: T[]; none: boolean }>,
  failure: string,
  storedNone: (market: Market) => boolean = () => false,
) {
  const value = ref<T[]>([...((market.value && stored(market.value)) ?? [])]) as Ref<T[]>;
  /**
   * That the organizer chose none (T206): an empty list says only that nothing is marked, so the
   * choice is its own flag beside it. Written with the empty list by `chooseNone`, and false after
   * any `save`, so the next mark replaces it.
   */
  const none = ref(Boolean(market.value && storedNone(market.value)));
  const error = ref('');
  /** What the server last answered, or the market last held while nothing was unsaved. */
  let confirmed = { list: [...value.value], none: none.value };
  /** The clicks made so far: a write's answer goes on screen only when no click came after it. */
  let clicks = 0;
  /** That the write which did not land met a market changed under it (ADR 0024). */
  let changed = false;

  const autosave = useAutosave({
    delay: 0,
    takesBackOnFailure: true,
    send: async () => {
      const id = market.value?.id;
      if (!id) return;
      const carrying = clicks;
      changed = false;
      try {
        const written = await write(id, [...value.value], none.value);
        confirmed = { list: [...written.list], none: written.none };
        if (carrying === clicks) {
          value.value = [...written.list];
          none.value = written.none;
        }
      } catch (err: unknown) {
        changed = isMarketChanged(err);
        throw err;
      }
    },
    sendOnUnload: () => false,
    // Once the queue is through: a write with a click behind it leaves the re-read to the last.
    afterSave: () => {
      if (!autosave.unsaved.value) void useMarketStore().refresh();
    },
    afterRefusal: (sentence) => {
      const held = changed ? market.value : null;
      value.value = held ? [...(stored(held) ?? [])] : [...confirmed.list];
      none.value = held ? storedNone(held) : confirmed.none;
      error.value = sentence;
    },
    may: () => true,
    failure,
  });

  watch(
    () => market.value && stored(market.value),
    (held) => {
      if (!held || autosave.unsaved.value) return;
      value.value = [...held];
      confirmed = { ...confirmed, list: [...held] };
    },
  );
  watch(
    () => Boolean(market.value && storedNone(market.value)),
    (held) => {
      if (autosave.unsaved.value) return;
      none.value = held;
      confirmed = { ...confirmed, none: held };
    },
  );

  async function commit(next: T[], nextNone: boolean) {
    if (!market.value?.id) return;
    value.value = next;
    none.value = nextNone;
    error.value = '';
    clicks += 1;
    autosave.edited();
    await autosave.flush();
  }

  /** Write this list, which replaces a choice of none. */
  function save(next: T[]) {
    return commit(next, false);
  }

  /** Choose none: the empty list and the flag, in one write. */
  function chooseNone() {
    return commit([], true);
  }

  return { value, none, error, save, chooseNone };
}
