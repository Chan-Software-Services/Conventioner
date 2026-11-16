import { useSubmit } from '@/utils/useSubmit';

/** Where a dialog's refusal is said: by the shell's error line, or by the dialog itself. */
export type DialogSays = 'dialog' | 'self';

export interface DialogSubmitOptions {
  /**
   * What the dialog is open on: its `open` prop for a dialog component (`() => props.open`), or the
   * thing its parent opened it with. A change of it is a new opening, a close among them, so an
   * answer for an earlier opening never touches the one the person is in.
   */
  opening: () => unknown;
  /** The sentence for a refusal with none of its own. */
  failure: string;
  /**
   * `'dialog'`, the default: the shell says the refusal in its error line. `'self'`: the dialog
   * says it beside the field or row it is about, from the handle's `sentence`.
   */
  says?: DialogSays;
}

/**
 * A dialog's write, held by `useSubmit`'s table keyed by the dialog's opening (T277 ticket 08,
 * T411). Handed to `AppDialog` as `submission`, it holds every close and disables the confirm
 * while it sends, and the shell says its refusal, so no dialog has to remember the hold.
 *
 * `submit(send, { done, refused, late })` is `useSubmit`'s: a second press while one is out sends
 * nothing; `done` and `refused` hear only the opening the write was sent in, and `late` hears an
 * earlier one's answer, for the dialog to hand on by its parent's refresh path, never by the event
 * that closes; once the dialog is gone nothing is called.
 */
export function useDialogSubmit(options: DialogSubmitOptions) {
  return {
    ...useSubmit({ scope: options.opening, failure: options.failure }),
    says: options.says ?? 'dialog',
  };
}

export type DialogSubmission = ReturnType<typeof useDialogSubmit>;
