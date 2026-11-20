/**
 * The one loader of a map's floorplan images (T501): every map that draws a floorplan, Attendance's,
 * the layout page's and the public map, reads its images through it, so a location's tables and its
 * image appear together and another location's image is never drawn under them.
 *
 * A page gives it the images it may draw (`sources`, each a key and how to fetch its bytes) and the
 * one it draws now (`openKey`). The open key is fetched first, at once, whatever else is in flight;
 * once it is ready or has failed, the others are fetched in the background one at a time, in the
 * order given, each only once, so a later switch to one of them costs no request. A fetch in flight
 * is never started again: opening a key whose background fetch is in flight waits for that fetch.
 *
 * An image counts as ready once decoded, and only the open key's is decoded: a background image keeps
 * its bytes as an object URL and is decoded when it opens, so the page never holds bitmaps it is not
 * drawing. The open image's `url` is '' until then, and never another key's. While it loads, for at
 * most two seconds, `pending` holds the map's tables back (`LayoutMap`'s `imagePending`); after
 * that, `slow`, and the map draws its tables on the floor until the image joins them. An open image
 * whose fetch or decode fails is `failed` for that opening; a failed image, open or in the
 * background, is forgotten and fetched again the next time its key opens.
 *
 * Each object URL is revoked when its key leaves `sources` (a replaced image, another market's
 * locations) and when the page goes, and an answer landing after that is dropped. Nothing is kept
 * outside the page's life: no copy outlives a sign-out or follows a person to another account, and
 * the next page fetches again, the browser's copy answered by the server's 304 (ADR 0041).
 */
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue';

/** One image a page may draw: its key (a gridfs id, or a public location's id) and how to fetch its bytes. */
export interface FloorplanImageSource {
  key: string;
  fetch: () => Promise<Blob>;
}

export interface OpenFloorplanImage {
  /** The open image's object URL once it is decoded, else ''. Never another key's. */
  url: string;
  /** True while the open key's image is loading and the 2 s wait has not run out: the map draws
   *  neither tables nor image (`LayoutMap`'s `imagePending`). */
  pending: boolean;
  /** True once the wait ran out and the image is still loading: the map draws its tables on the floor. */
  slow: boolean;
  /** True once the open key's image failed this time it was opened. */
  failed: boolean;
}

/** How long the map's tables wait for their image before they are drawn on the floor (Q5). */
export const IMAGE_WAIT_MS = 2000;

/** What the page holds of one key's image. */
interface Held {
  /** The bytes' object URL, once fetched. */
  url: string;
  /** The fetch in flight, answering the object URL. */
  fetching: Promise<string> | null;
  /** The decode in flight. */
  decoding: Promise<void> | null;
  decoded: boolean;
}

export function useFloorplanImages(
  sources: Ref<readonly FloorplanImageSource[]>,
  openKey: Ref<string | null | undefined>,
): { open: ComputedRef<OpenFloorplanImage>; urlOf: (key: string) => string } {
  /** Every key's image held, by key; a key leaving `sources` leaves it. */
  const held = new Map<string, Held>();
  /** Bumped whenever `held` changes, so what reads it follows. */
  const changed = ref(0);
  /** The keys fetched once, opened or in the background: a key that failed waits for its opening. */
  const triedBehind = new Set<string>();
  /** The key opened now, whose load was started this opening; null once it changes. */
  let startedFor: string | null = null;
  /** The open key whose fetch or decode failed this opening. */
  const failedFor = ref<string | null>(null);
  /** The open key whose wait ran out this opening. */
  const waitedFor = ref<string | null>(null);
  let wait: ReturnType<typeof setTimeout> | null = null;
  let behind = false;
  let gone = false;

  const sourceOf = (key: string | null | undefined) =>
    key ? sources.value.find((each) => each.key === key) : undefined;

  const touch = () => changed.value++;

  function ready(key: string): string {
    void changed.value;
    const image = held.get(key);
    return image?.decoded ? image.url : '';
  }

  function drop(key: string) {
    const image = held.get(key);
    if (!image) return;
    held.delete(key);
    if (image.url) URL.revokeObjectURL(image.url);
    touch();
  }

  /** The key's bytes as an object URL, fetched once: a fetch in flight is waited for. */
  function bytes(source: FloorplanImageSource): Promise<string> {
    let image = held.get(source.key);
    if (image?.url) return Promise.resolve(image.url);
    if (image?.fetching) return image.fetching;
    if (!image) {
      image = { url: '', fetching: null, decoding: null, decoded: false };
      held.set(source.key, image);
    }
    const mine = image;
    mine.fetching = source.fetch().then(
      (blob) => {
        // The key left the sources, or the page went, while it was in flight: dropped.
        if (gone || held.get(source.key) !== mine) throw new Error('dropped');
        mine.url = URL.createObjectURL(blob);
        mine.fetching = null;
        touch();
        return mine.url;
      },
      (error: unknown) => {
        if (held.get(source.key) === mine) held.delete(source.key);
        throw error;
      },
    );
    return mine.fetching;
  }

  /** The open key's image fetched and decoded. */
  async function load(source: FloorplanImageSource) {
    const { key } = source;
    try {
      const url = await bytes(source);
      const image = held.get(key);
      if (!image || image.url !== url) return;
      // Another key opened while it was in flight: its bytes are kept, and decoded when it opens.
      if (openKey.value !== key) return;
      if (!image.decoded) {
        image.decoding ??= decode(url).finally(() => (image.decoding = null));
        await image.decoding;
        if (held.get(key) !== image) return;
        image.decoded = true;
        touch();
      }
    } catch {
      if (gone) return;
      const image = held.get(key);
      // Bytes that cannot be drawn are dropped, so the next opening fetches them again.
      if (image?.url && !image.decoded) drop(key);
      if (openKey.value === key && startedFor === key) failedFor.value = key;
    } finally {
      if (openKey.value === key) stopWaiting();
      fetchBehind();
    }
  }

  function decode(url: string): Promise<void> {
    const image = new Image();
    image.src = url;
    return image.decode();
  }

  function stopWaiting() {
    if (wait !== null) clearTimeout(wait);
    wait = null;
  }

  /** Whether the open key has nothing left to wait for: ready, failed, or no image at all. */
  function openSettled(): boolean {
    const key = openKey.value;
    if (!sourceOf(key)) return true;
    return !!ready(key!) || failedFor.value === key;
  }

  /** The other sources fetched one at a time, in order, each once, while the open one is settled. */
  async function fetchBehind() {
    if (behind) return;
    behind = true;
    try {
      while (!gone && openSettled()) {
        const next = sources.value.find(
          ({ key }) => key !== openKey.value && !held.has(key) && !triedBehind.has(key),
        );
        if (!next) return;
        triedBehind.add(next.key);
        try {
          await bytes(next);
        } catch {
          // Forgotten: it is fetched again when its key opens.
        }
      }
    } finally {
      behind = false;
    }
  }

  /** The open key's load, started once each opening, with its wait. */
  function openNow() {
    if (gone) return;
    const key = openKey.value;
    const source = sourceOf(key);
    // Nothing to wait for: the floor alone, and the others fetched behind it.
    if (!key || !source) {
      fetchBehind();
      return;
    }
    if (startedFor === key) return;
    startedFor = key;
    // Tried once it opens: if it fails, it waits for its next opening, never the background.
    triedBehind.add(key);
    if (ready(key)) {
      fetchBehind();
      return;
    }
    stopWaiting();
    wait = setTimeout(() => {
      wait = null;
      if (openKey.value === key) waitedFor.value = key;
    }, IMAGE_WAIT_MS);
    void load(source);
  }

  watch(
    openKey,
    () => {
      startedFor = null;
      failedFor.value = null;
      waitedFor.value = null;
      stopWaiting();
      openNow();
    },
    { immediate: true, flush: 'sync' },
  );

  watch(
    () => sources.value.map(({ key }) => key),
    (keys) => {
      const kept = new Set(keys);
      for (const key of [...held.keys()]) if (!kept.has(key)) drop(key);
      for (const key of [...triedBehind]) if (!kept.has(key)) triedBehind.delete(key);
      if (startedFor && !kept.has(startedFor)) startedFor = null;
      openNow();
      fetchBehind();
    },
    { flush: 'sync' },
  );

  if (getCurrentScope()) {
    onScopeDispose(() => {
      gone = true;
      stopWaiting();
      for (const key of [...held.keys()]) drop(key);
    });
  }

  const open = computed<OpenFloorplanImage>(() => {
    const key = openKey.value;
    const url = key ? ready(key) : '';
    const loading = !!key && !!sourceOf(key) && !url && failedFor.value !== key;
    const waited = !!key && waitedFor.value === key;
    return {
      url,
      pending: loading && !waited,
      slow: loading && waited,
      failed: !!key && failedFor.value === key && !url,
    };
  });

  return { open, urlOf: ready };
}
