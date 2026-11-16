/**
 * The applicant's own words: their application submitted, or edited, under `apply`, the one verb
 * no row of the table asks.
 *
 * Reads:
 * - `apply/submitted`, its sentence and its rows
 * - `apply/edited`, its sentence and its rows, and whether it sent the application back to Open
 *
 * `apply/dealt`, their application dealt as it arrived, is the Applications group's.
 */
import { asDetail, sentence, vendorAnswers, type HistoryReaders } from './shared';

export const readers: HistoryReaders = {
  'apply/submitted': {
    parts(entry, context) {
      const { text, vendor } = sentence(entry, context);
      return [vendor, text(' applied')];
    },
    changes: vendorAnswers,
  },
  'apply/edited': {
    parts(entry, context) {
      const { text, vendor } = sentence(entry, context);
      // Their changed answers sent a verdict back to Open (decision 9.1 of T277): said here, so
      // the organizer reads why an approved vendor is open again.
      const returned = asDetail(entry.detail).returned_to_review === true;
      return [
        vendor,
        text(` edited their application${returned ? ', which sent it back to Open' : ''}`),
      ];
    },
    changes(entry, context) {
      const detail = { ...asDetail(entry.detail) };
      delete detail.returned_to_review;
      return vendorAnswers({ ...entry, detail }, context);
    },
  },
};
