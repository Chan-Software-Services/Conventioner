/**
 * The Public map card's words (T422): the map turned on or off, and the form's questions it shows
 * each vendor's public name, website and Instagram handle from.
 *
 * Reads:
 * - `publish-map/public_map`, its sentence and its rows
 *
 * The server records the fields that changed (`public_map.py#_recorded`), each question by its key
 * and by its label as the form named it then, since the form may lose the question later; a question
 * recorded with no label is named by the form, else by its key and that the form no longer has it.
 */
import type { FormField } from '@/assets/types/datatypes';
import { asDetail, listed, sentence, str, type Detail, type HistoryReaders } from './shared';

/** A question of the card: its stored field, its name on the card, and the words of the sentence. */
interface CardQuestion {
  key: 'name_question' | 'website_question' | 'instagram_question';
  /** The picker's label on the card, which names its row. */
  row: string;
  /** What the map shows from it, in "set the public map's <what> to ...". */
  what: string;
  /** What a sentence says once it is not chosen any more. */
  stopped: string;
}

const QUESTIONS: readonly CardQuestion[] = [
  {
    key: 'name_question',
    row: 'Public name',
    what: 'name',
    stopped: 'stopped showing names on the public map',
  },
  {
    key: 'website_question',
    row: 'Website',
    what: 'website',
    stopped: 'stopped showing the website on the public map',
  },
  {
    key: 'instagram_question',
    row: 'Instagram',
    what: 'Instagram',
    stopped: 'stopped showing Instagram on the public map',
  },
];

/** Whether a side recorded this question: by its key or by its label. */
function records(side: Detail, key: string): boolean {
  return key in side || `${key}_label` in side;
}

/**
 * A side's question as the form named it, or null where none was chosen: its label, which `quoted`
 * sets in quotes for a sentence, or its key in quotes and that the form no longer has it.
 */
function questionName(
  side: Detail,
  key: string,
  fields: readonly FormField[],
  quoted = false,
): string | null {
  const chosen = str(side[key]);
  const label =
    str(side[`${key}_label`]) || fields.find((field) => chosen && field.key === chosen)?.label;
  if (label) return quoted ? `“${label}”` : label;
  return chosen ? `“${chosen}” (no longer on the form)` : null;
}

/** The questions an entry changed, in the card's order. */
function changedQuestions(before: Detail, after: Detail): CardQuestion[] {
  return QUESTIONS.filter(
    (question) => records(after, question.key) || records(before, question.key),
  );
}

const onOff = (value: unknown) => (value === true ? 'On' : 'Off');

export const readers: HistoryReaders = {
  'publish-map/public_map': {
    parts(entry, context) {
      const { actor, text, before, after } = sentence(entry, context);
      const said: string[] = [];
      if ('enabled' in after) {
        said.push(`turned the public map ${after.enabled === true ? 'on' : 'off'}`);
      }
      for (const question of changedQuestions(before, after)) {
        const name = questionName(after, question.key, context.fields, true);
        said.push(name ? `set the public map’s ${question.what} to ${name}` : question.stopped);
      }
      return [actor, text(said.length ? listed(said) : 'changed the public map')];
    },
    changes(entry, { fields }) {
      const detail = asDetail(entry.detail);
      const before = asDetail(detail.before);
      const after = asDetail(detail.after);
      const shown = (side: Detail, key: string) => questionName(side, key, fields) ?? 'Not shown';
      return {
        changed: [
          ...('enabled' in after || 'enabled' in before
            ? [
                {
                  field: 'Show the public map',
                  before: onOff(before.enabled),
                  after: onOff(after.enabled),
                },
              ]
            : []),
          ...changedQuestions(before, after).map((question) => ({
            field: question.row,
            before: shown(before, question.key),
            after: shown(after, question.key),
          })),
        ],
        recorded: [],
      };
    },
  },
};
