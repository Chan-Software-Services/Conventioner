/**
 * The door's words: a vendor checked in or out, or either undone, by an organizer or by the vendor
 * on their vendor page (with the door code; their undo takes none); a door code made, which never
 * names the code (ADR 0022); and the market's self check-in switch turned on or off (T496). An
 * entry from before the vendor page reads as made on the public check-in page it names.
 *
 * Reads:
 * - `check-in/checked_in`
 * - `check-in/check_in_undone`
 * - `check-in/checked_out`
 * - `check-in/check_out_undone`
 * - `check-in/door_code_made`
 * - `check-in/self_check_in_set`
 */
import { asDetail, sentence, type HistoryReaders } from './shared';

/** How a vendor's own check-in, check-out or undo of either was made, as its entry's `via` says. */
function byTheVendor(entry: { detail?: unknown }): string {
  const via = asDetail(entry.detail).via;
  if (via === 'door_code') return ' with the door code';
  if (via === 'vendor_page') return ' on their vendor page';
  return ' on the check-in page';
}

export const readers: HistoryReaders = {
  'check-in/checked_in': {
    parts(entry, context) {
      const { actor, text, vendor, onDay } = sentence(entry, context);
      return entry.actor
        ? [actor, text('checked '), vendor, text(` in${onDay(entry.subject.date)}`)]
        : [vendor, text(` checked in${byTheVendor(entry)}${onDay(entry.subject.date)}`)];
    },
  },
  'check-in/check_in_undone': {
    parts(entry, context) {
      const { actor, text, vendor, onDay } = sentence(entry, context);
      return entry.actor
        ? [actor, text('undid the check-in of '), vendor, text(onDay(entry.subject.date))]
        : [vendor, text(` undid their check-in${byTheVendor(entry)}${onDay(entry.subject.date)}`)];
    },
  },
  'check-in/checked_out': {
    parts(entry, context) {
      const { actor, text, vendor, onDay } = sentence(entry, context);
      return entry.actor
        ? [actor, text('checked '), vendor, text(` out${onDay(entry.subject.date)}`)]
        : [vendor, text(` checked out${byTheVendor(entry)}${onDay(entry.subject.date)}`)];
    },
  },
  'check-in/check_out_undone': {
    parts(entry, context) {
      const { actor, text, vendor, onDay } = sentence(entry, context);
      return entry.actor
        ? [actor, text('undid the check-out of '), vendor, text(onDay(entry.subject.date))]
        : [vendor, text(` undid their check-out${byTheVendor(entry)}${onDay(entry.subject.date)}`)];
    },
  },
  'check-in/door_code_made': {
    parts(entry, context) {
      const { actor, text, detail } = sentence(entry, context);
      return detail.replaced
        ? [actor, text('made a new door code, which ended the old one and every poster of it')]
        : [actor, text('made the door code')];
    },
  },
  'check-in/self_check_in_set': {
    parts(entry, context) {
      const { actor, text, after } = sentence(entry, context);
      return [
        actor,
        text(
          after.enabled
            ? 'let vendors check themselves in and out'
            : 'stopped vendors checking themselves in and out',
        ),
      ];
    },
  },
};
