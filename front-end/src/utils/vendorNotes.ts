/**
 * The two kinds of note on a market's vendors, read once per page (E31/F04).
 *
 * The vendor's own request - their answer to "Anything else you need from us?" - and the
 * organizer's side: one shared note, a "From your sheet" line an import replaces, and the mark that
 * the request was handled. `GET /markets/:id/vendor-notes` serves both kinds by address, each under
 * its own key; the vendor never sees the organizer's (map ticket 03).
 *
 * A write is followed by a re-read, never a patch, as every market write is.
 */
import { computed, type Ref } from 'vue';
import { api } from '@/utils/api';
import { useServerRead } from '@/utils/useServerRead';

export interface VendorNoteEntry {
  request: string;
  note: string;
  noteEditedBy: string | null;
  noteEditedAt: string | null;
  fromSheet: string | null;
  requestHandledAt: string | null;
  requestHandledBy: string | null;
}

/** Whether there is anything to show about this vendor at all. */
export function hasNotes(entry: VendorNoteEntry | undefined): boolean {
  return !!entry && !!(entry.request || entry.note || entry.fromSheet);
}

/** A request the door still has to deal with. */
export function requestOutstanding(entry: VendorNoteEntry | undefined): boolean {
  return !!entry?.request && !entry.requestHandledAt;
}

/**
 * A market's notes, read as the page opens on it and again whenever it opens on another: one keyed
 * read (`useServerRead`, T421), so a move to another market drops the last market's notes in the
 * same tick, and an answer for the market left never lands on this market's rows.
 */
export function useVendorNotes(marketId: Ref<string>) {
  const read = useServerRead<string, Record<string, VendorNoteEntry>>(
    () => marketId.value || null,
    async (id) => {
      const { data } = await api.get(`/markets/${encodeURIComponent(id)}/vendor-notes`);
      return (data?.notes ?? {}) as Record<string, VendorNoteEntry>;
    },
    { failure: 'The notes could not be read.' },
  );

  // Notes are beside the page's work, never its subject: a page that cannot read them still does
  // its job, without them or with those it read last, and says nothing of it.
  const notes = computed<Record<string, VendorNoteEntry>>(() => read.data.value ?? {});

  /** Read them again, after a write: resolves when this read lands, fails or is overtaken. */
  function load(): Promise<void> {
    return read.reread();
  }

  /** One vendor's entry, by address however it is cased. */
  function entryFor(email: string): VendorNoteEntry | undefined {
    return notes.value[email.trim().toLowerCase()];
  }

  return { notes, load, entryFor };
}

/** Replace the organizer's note on one vendor. */
export async function saveVendorNote(marketId: string, email: string, note: string): Promise<void> {
  await api.put(
    `/markets/${encodeURIComponent(marketId)}/vendor-notes/${encodeURIComponent(email)}`,
    { note },
  );
}

/** Mark a vendor's request handled, or take the mark back. */
export async function markRequestHandled(
  marketId: string,
  email: string,
  handled: boolean,
): Promise<void> {
  await api.put(
    `/markets/${encodeURIComponent(marketId)}/vendor-notes/${encodeURIComponent(email)}/request-handled`,
    { handled },
  );
}
