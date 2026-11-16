/**
 * An autosave's state is one phase moved only by its table (T420, T277 ticket 10).
 *
 * T271 gave the plan's line one owner, but its state was a status string written at eight places
 * beside ten other variables, so nothing stopped a change from bringing back "Saving…" with
 * nothing out, or "refused" beside an unsaved edit. The table answers the next state for each
 * event, the same object for a pair it does not hold, and the words on screen are read from it.
 *
 * One `describe` per row of the table and one `it` per cell; then the derived words, a walk over
 * every state reachable from clean, and the two options through `useAutosave`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  messageOf,
  statusOf,
  transition,
  unsavedIn,
  useAutosave,
  type AutosaveEvent,
  type AutosavePhase,
  type AutosaveState,
} from '@/utils/useAutosave';

const at = (phase: AutosavePhase, hold = false): AutosaveState => ({ phase, hold });

const clean = (saved = false): AutosavePhase => ({ kind: 'clean', saved });
const pausing: AutosavePhase = { kind: 'pausing' };
const held: AutosavePhase = { kind: 'held' };
const sending = (after: 'none' | 'pausing' | 'wanted' = 'none', drop = false): AutosavePhase => ({
  kind: 'sending',
  after,
  drop,
});
const failed = (sentence = 'The plan was not saved.'): AutosavePhase => ({
  kind: 'failed',
  sentence,
});
const refused = (kept = false, sentence = 'Market is not a draft'): AutosavePhase => ({
  kind: 'refused',
  sentence,
  kept,
});

const EVENTS = {
  edit: { kind: 'edit' },
  pauseEnds: { kind: 'pauseEnds' },
  ok: { kind: 'ok' },
  failed: { kind: 'failed', sentence: 'Offline.' },
  refused: { kind: 'refused', sentence: 'No.', keep: false },
  refusedKept: { kind: 'refused', sentence: 'No.', keep: true },
  lost: { kind: 'lost' },
  holdOn: { kind: 'holdOn' },
  holdOff: { kind: 'holdOff' },
  flush: { kind: 'flush' },
  forget: { kind: 'forget' },
  savedEnds: { kind: 'savedEnds' },
} satisfies Record<string, AutosaveEvent>;

/** A pair not in the table: the same state object, and no send. */
function expectNotInTable(state: AutosaveState, event: AutosaveEvent) {
  const step = transition(state, event);
  expect(step.state).toBe(state);
  expect(step.send).toBe(false);
}

function expectStep(state: AutosaveState, event: AutosaveEvent, next: AutosaveState, send = false) {
  const step = transition(state, event);
  expect(step.state).not.toBe(state);
  expect(step.state).toEqual(next);
  expect(step.send).toBe(send);
}

describe('from clean', () => {
  it('edit: pausing, or held under the hold', () => {
    expectStep(at(clean()), EVENTS.edit, at(pausing));
    expectStep(at(clean(true)), EVENTS.edit, at(pausing));
    expectStep(at(clean(), true), EVENTS.edit, at(held, true));
  });

  it('pauseEnds: not in the table', () => {
    expectNotInTable(at(clean()), EVENTS.pauseEnds);
  });

  it('ok: not in the table', () => {
    expectNotInTable(at(clean(true)), EVENTS.ok);
  });

  it('failed: not in the table', () => {
    expectNotInTable(at(clean()), EVENTS.failed);
  });

  it('refused: not in the table', () => {
    expectNotInTable(at(clean()), EVENTS.refused);
  });

  it('lost: not in the table', () => {
    expectNotInTable(at(clean()), EVENTS.lost);
  });

  it('holdOn: clean under the hold, saved kept; not in the table when held already', () => {
    expectStep(at(clean(true)), EVENTS.holdOn, at(clean(true), true));
    expectNotInTable(at(clean(), true), EVENTS.holdOn);
  });

  it('holdOff: clean with no hold; not in the table when not held', () => {
    expectStep(at(clean(true), true), EVENTS.holdOff, at(clean(true)));
    expectNotInTable(at(clean()), EVENTS.holdOff);
  });

  it('flush: not in the table', () => {
    expectNotInTable(at(clean()), EVENTS.flush);
  });

  it('forget: not in the table', () => {
    expectNotInTable(at(clean(true)), EVENTS.forget);
  });

  it('savedEnds: clean, no longer saved; not in the table when not saved', () => {
    expectStep(at(clean(true)), EVENTS.savedEnds, at(clean()));
    expectStep(at(clean(true), true), EVENTS.savedEnds, at(clean(), true));
    expectNotInTable(at(clean()), EVENTS.savedEnds);
  });
});

describe('from pausing', () => {
  it('edit: pausing again, a new state so the pause restarts', () => {
    expectStep(at(pausing), EVENTS.edit, at(pausing));
  });

  it('pauseEnds: sending, and send', () => {
    expectStep(at(pausing), EVENTS.pauseEnds, at(sending()), true);
  });

  it('ok: not in the table', () => {
    expectNotInTable(at(pausing), EVENTS.ok);
  });

  it('failed: not in the table', () => {
    expectNotInTable(at(pausing), EVENTS.failed);
  });

  it('refused: not in the table', () => {
    expectNotInTable(at(pausing), EVENTS.refused);
  });

  it('lost: clean', () => {
    expectStep(at(pausing), EVENTS.lost, at(clean()));
  });

  it('holdOn: held, under the hold', () => {
    expectStep(at(pausing), EVENTS.holdOn, at(held, true));
  });

  it('holdOff: not in the table', () => {
    expectNotInTable(at(pausing), EVENTS.holdOff);
  });

  it('flush: sending, and send', () => {
    expectStep(at(pausing), EVENTS.flush, at(sending()), true);
  });

  it('forget: clean', () => {
    expectStep(at(pausing), EVENTS.forget, at(clean()));
  });

  it('savedEnds: not in the table', () => {
    expectNotInTable(at(pausing), EVENTS.savedEnds);
  });
});

describe('from held', () => {
  it('edit: not in the table, the edit already waits', () => {
    expectNotInTable(at(held, true), EVENTS.edit);
  });

  it('pauseEnds: not in the table', () => {
    expectNotInTable(at(held, true), EVENTS.pauseEnds);
  });

  it('ok: not in the table', () => {
    expectNotInTable(at(held, true), EVENTS.ok);
  });

  it('failed: not in the table', () => {
    expectNotInTable(at(held, true), EVENTS.failed);
  });

  it('refused: not in the table', () => {
    expectNotInTable(at(held, true), EVENTS.refused);
  });

  it('lost: clean, the hold kept', () => {
    expectStep(at(held, true), EVENTS.lost, at(clean(), true));
  });

  it('holdOn: not in the table', () => {
    expectNotInTable(at(held, true), EVENTS.holdOn);
  });

  it('holdOff: pausing, with no hold', () => {
    expectStep(at(held, true), EVENTS.holdOff, at(pausing));
  });

  it('flush: sending, and send, the hold kept', () => {
    expectStep(at(held, true), EVENTS.flush, at(sending(), true), true);
  });

  it('forget: clean', () => {
    expectStep(at(held, true), EVENTS.forget, at(clean(), true));
  });

  it('savedEnds: not in the table', () => {
    expectNotInTable(at(held, true), EVENTS.savedEnds);
  });
});

describe('from sending', () => {
  it('edit: a pause behind it, or wanted under the hold; not in the table when wanted or dropping', () => {
    expectStep(at(sending('none')), EVENTS.edit, at(sending('pausing')));
    expectStep(at(sending('pausing')), EVENTS.edit, at(sending('pausing')));
    expectStep(at(sending('none'), true), EVENTS.edit, at(sending('wanted'), true));
    expectNotInTable(at(sending('wanted')), EVENTS.edit);
    expectNotInTable(at(sending('none', true)), EVENTS.edit);
  });

  it('pauseEnds: wanted after a pause; not in the table otherwise', () => {
    expectStep(at(sending('pausing')), EVENTS.pauseEnds, at(sending('wanted')));
    expectNotInTable(at(sending('none')), EVENTS.pauseEnds);
    expectNotInTable(at(sending('wanted')), EVENTS.pauseEnds);
  });

  it('ok: clean and saved, the pause running on, the wanted save sent, or held', () => {
    expectStep(at(sending('none')), EVENTS.ok, at(clean(true)));
    expectStep(at(sending('pausing')), EVENTS.ok, at(pausing));
    expectStep(at(sending('wanted')), EVENTS.ok, at(sending('none')), true);
    expectStep(at(sending('wanted'), true), EVENTS.ok, at(held, true));
    // A drop: clean, saved only when nothing came after the save.
    expectStep(at(sending('none', true)), EVENTS.ok, at(clean(true)));
    expectStep(at(sending('pausing', true)), EVENTS.ok, at(clean()));
    expectStep(at(sending('wanted', true), true), EVENTS.ok, at(clean(), true));
  });

  it('failed: failed, the pause running on, the wanted save sent, held, or clean on a drop', () => {
    expectStep(at(sending('none')), EVENTS.failed, at(failed('Offline.')));
    expectStep(at(sending('pausing')), EVENTS.failed, at(pausing));
    expectStep(at(sending('wanted')), EVENTS.failed, at(sending('none')), true);
    expectStep(at(sending('wanted'), true), EVENTS.failed, at(held, true));
    expectStep(at(sending('none', true)), EVENTS.failed, at(clean()));
    expectStep(at(sending('wanted', true)), EVENTS.failed, at(clean()));
  });

  it('refused: refused, kept only when asked and not dropping', () => {
    expectStep(at(sending('none')), EVENTS.refused, at(refused(false, 'No.')));
    expectStep(at(sending('wanted')), EVENTS.refusedKept, at(refused(true, 'No.')));
    expectStep(at(sending('pausing', true)), EVENTS.refusedKept, at(refused(false, 'No.')));
    expectStep(at(sending('none'), true), EVENTS.refused, at(refused(false, 'No.'), true));
  });

  it('lost: the drop set; not in the table when set', () => {
    expectStep(at(sending('pausing')), EVENTS.lost, at(sending('pausing', true)));
    expectNotInTable(at(sending('none', true)), EVENTS.lost);
  });

  it('holdOn: under the hold, a pause behind it becoming wanted; not in the table when held', () => {
    expectStep(at(sending('pausing')), EVENTS.holdOn, at(sending('wanted'), true));
    expectStep(at(sending('none')), EVENTS.holdOn, at(sending('none'), true));
    expectNotInTable(at(sending('wanted'), true), EVENTS.holdOn);
  });

  it('holdOff: no hold, a wanted save becoming a pause; not in the table when not held', () => {
    expectStep(at(sending('wanted'), true), EVENTS.holdOff, at(sending('pausing')));
    expectStep(at(sending('none'), true), EVENTS.holdOff, at(sending('none')));
    expectNotInTable(at(sending('pausing')), EVENTS.holdOff);
  });

  it('flush: wanted after a pause; not in the table otherwise', () => {
    expectStep(at(sending('pausing')), EVENTS.flush, at(sending('wanted')));
    expectNotInTable(at(sending('none')), EVENTS.flush);
    expectNotInTable(at(sending('wanted')), EVENTS.flush);
  });

  it('forget: nothing after the save out; not in the table when nothing is', () => {
    expectStep(at(sending('pausing')), EVENTS.forget, at(sending('none')));
    expectStep(at(sending('wanted', true), true), EVENTS.forget, at(sending('none', true), true));
    expectNotInTable(at(sending('none')), EVENTS.forget);
  });

  it('savedEnds: not in the table', () => {
    expectNotInTable(at(sending()), EVENTS.savedEnds);
  });
});

describe('from failed', () => {
  it('edit: pausing, or held under the hold', () => {
    expectStep(at(failed()), EVENTS.edit, at(pausing));
    expectStep(at(failed(), true), EVENTS.edit, at(held, true));
  });

  it('pauseEnds: not in the table', () => {
    expectNotInTable(at(failed()), EVENTS.pauseEnds);
  });

  it('ok: not in the table', () => {
    expectNotInTable(at(failed()), EVENTS.ok);
  });

  it('failed: not in the table', () => {
    expectNotInTable(at(failed()), EVENTS.failed);
  });

  it('refused: not in the table', () => {
    expectNotInTable(at(failed()), EVENTS.refused);
  });

  it('lost: clean', () => {
    expectStep(at(failed()), EVENTS.lost, at(clean()));
    expectStep(at(failed(), true), EVENTS.lost, at(clean(), true));
  });

  it('holdOn: failed, under the hold; not in the table when held', () => {
    expectStep(at(failed()), EVENTS.holdOn, at(failed(), true));
    expectNotInTable(at(failed(), true), EVENTS.holdOn);
  });

  it('holdOff: failed, with no hold; not in the table when not held', () => {
    expectStep(at(failed(), true), EVENTS.holdOff, at(failed()));
    expectNotInTable(at(failed()), EVENTS.holdOff);
  });

  it('flush: sending, and send', () => {
    expectStep(at(failed()), EVENTS.flush, at(sending()), true);
    expectStep(at(failed(), true), EVENTS.flush, at(sending(), true), true);
  });

  it('forget: clean', () => {
    expectStep(at(failed()), EVENTS.forget, at(clean()));
  });

  it('savedEnds: not in the table', () => {
    expectNotInTable(at(failed()), EVENTS.savedEnds);
  });
});

describe('from refused', () => {
  it('edit: pausing, or held under the hold, kept or not', () => {
    expectStep(at(refused()), EVENTS.edit, at(pausing));
    expectStep(at(refused(true)), EVENTS.edit, at(pausing));
    expectStep(at(refused(), true), EVENTS.edit, at(held, true));
  });

  it('pauseEnds: not in the table', () => {
    expectNotInTable(at(refused(true)), EVENTS.pauseEnds);
  });

  it('ok: not in the table', () => {
    expectNotInTable(at(refused()), EVENTS.ok);
  });

  it('failed: not in the table', () => {
    expectNotInTable(at(refused()), EVENTS.failed);
  });

  it('refused: not in the table', () => {
    expectNotInTable(at(refused()), EVENTS.refused);
  });

  it('lost: a kept refusal no longer kept; not in the table when not kept', () => {
    expectStep(at(refused(true)), EVENTS.lost, at(refused(false)));
    expectNotInTable(at(refused(false)), EVENTS.lost);
  });

  it('holdOn: refused, under the hold; not in the table when held', () => {
    expectStep(at(refused(true)), EVENTS.holdOn, at(refused(true), true));
    expectNotInTable(at(refused(), true), EVENTS.holdOn);
  });

  it('holdOff: refused, with no hold; not in the table when not held', () => {
    expectStep(at(refused(), true), EVENTS.holdOff, at(refused()));
    expectNotInTable(at(refused()), EVENTS.holdOff);
  });

  it('flush: a kept refusal sent again; not in the table when not kept', () => {
    expectStep(at(refused(true)), EVENTS.flush, at(sending()), true);
    expectNotInTable(at(refused(false)), EVENTS.flush);
  });

  it('forget: clean', () => {
    expectStep(at(refused(true)), EVENTS.forget, at(clean()));
    expectStep(at(refused(false)), EVENTS.forget, at(clean()));
  });

  it('savedEnds: not in the table', () => {
    expectNotInTable(at(refused()), EVENTS.savedEnds);
  });
});

describe('the words, read from the phase', () => {
  it.each<[AutosavePhase, string, boolean]>([
    [clean(), 'idle', false],
    [clean(true), 'saved', false],
    [pausing, 'idle', true],
    [held, 'idle', true],
    [sending('none'), 'saving', true],
    [sending('pausing'), 'saving', true],
    [sending('wanted', true), 'saving', true],
    [failed(), 'failed', true],
    [refused(false), 'refused', false],
    [refused(true), 'refused', true],
  ])('%o reads %s, unsaved %s', (phase, status, unsaved) => {
    expect(statusOf(phase)).toBe(status);
    expect(unsavedIn(phase)).toBe(unsaved);
  });

  it("says a failure's sentence, and nothing for a phase with no line", () => {
    expect(messageOf(failed('Offline.'))).toBe('Offline.');
    for (const phase of [clean(), clean(true), pausing, held, sending()]) {
      expect(messageOf(phase)).toBe('');
    }
  });

  it("says a kept refusal's sentence alone", () => {
    expect(messageOf(refused(true, 'This layout changed elsewhere.'))).toBe(
      'This layout changed elsewhere.',
    );
  });

  it('says the sentence alone on a screen that keeps its copy, once that copy is dropped', () => {
    expect(messageOf(refused(false, 'This market is archived.'), true)).toBe(
      'This market is archived.',
    );
  });

  it('says a refusal not kept with the plan coming back, ending its sentence first', () => {
    expect(messageOf(refused(false, 'Market is not a draft'))).toBe(
      'Market is not a draft. The plan is back as it was last saved.',
    );
    expect(messageOf(refused(false, 'Market not found!'))).toBe(
      'Market not found! The plan is back as it was last saved.',
    );
  });
});

describe('every state reachable from clean', () => {
  const events: AutosaveEvent[] = Object.values(EVENTS);
  const start = at(clean());
  const seen = new Map<string, AutosaveState>([[JSON.stringify(start), start]]);
  let frontier = [start];
  for (let depth = 0; depth < 6; depth += 1) {
    const next: AutosaveState[] = [];
    for (const state of frontier) {
      for (const event of events) {
        const step = transition(state, event);
        const key = JSON.stringify(step.state);
        if (!seen.has(key)) {
          seen.set(key, step.state);
          next.push(step.state);
        }
      }
    }
    frontier = next;
  }
  const reached = [...seen.values()];

  it('reaches every phase', () => {
    const kinds = new Set(reached.map((state) => state.phase.kind));
    expect([...kinds].sort()).toEqual(['clean', 'failed', 'held', 'pausing', 'refused', 'sending']);
  });

  it('runs no pause under the hold, and holds an edit only under it', () => {
    for (const { phase, hold } of reached) {
      if (hold) {
        expect(phase.kind).not.toBe('pausing');
        if (phase.kind === 'sending') expect(phase.after).not.toBe('pausing');
      } else {
        expect(phase.kind).not.toBe('held');
      }
    }
  });

  it('sends only into sending, with nothing behind the new save', () => {
    for (const state of reached) {
      for (const event of events) {
        const step = transition(state, event);
        if (step.send) expect(step.state.phase).toEqual(sending('none'));
      }
    }
  });
});

/** A write whose answers the test gives one at a time. */
function heldWrites(copy: () => unknown) {
  const sent: unknown[] = [];
  const answers: { resolve: () => void; reject: (err: unknown) => void }[] = [];
  const send = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        sent.push(JSON.parse(JSON.stringify(copy())));
        answers.push({ resolve, reject });
      }),
  );
  return {
    send,
    sent,
    async answer() {
      answers.shift()!.resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
    async fail(err: unknown) {
      answers.shift()!.reject(err);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

/** A request the server answered with `status`, as axios rejects it. */
function answered(status: number, error?: string) {
  return { isAxiosError: true, response: { status, data: error ? { error } : {} } };
}

/** A request that never reached the server. */
const noAnswer = { isAxiosError: true, response: undefined };

function setUp(options: { delay?: number; takesBackOnFailure?: boolean; keepOnRefusal?: boolean }) {
  const copy = { marks: [] as string[] };
  const writes = heldWrites(() => copy);
  const afterSave = vi.fn();
  const afterRefusal = vi.fn();
  const autosave = useAutosave({
    send: writes.send,
    sendOnUnload: () => false,
    afterSave,
    afterRefusal,
    may: () => true,
    failure: 'The list was not saved.',
    ...options,
  });
  function edit(mark: string) {
    copy.marks.push(mark);
    autosave.edited();
  }
  return { copy, writes, afterSave, afterRefusal, autosave, edit };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the failed line gives way to the next edit', () => {
  it('says nothing through the next edit’s pause, and says failed again when its save fails', async () => {
    const { writes, edit, autosave } = setUp({});

    edit('a');
    await vi.advanceTimersByTimeAsync(600);
    await writes.fail(new Error('offline'));
    expect(autosave.status.value).toBe('failed');

    edit('b');
    expect(autosave.status.value).toBe('idle');
    expect(autosave.message.value).toBe('');
    expect(autosave.unsaved.value).toBe(true);

    await vi.advanceTimersByTimeAsync(600);
    expect(autosave.status.value).toBe('saving');
    expect(writes.sent[1]).toEqual({ marks: ['a', 'b'] });

    await writes.fail(new Error('offline'));
    expect(autosave.status.value).toBe('failed');
    expect(autosave.message.value).toBe('The list was not saved.');
  });
});

describe('an autosave with no pause (`delay: 0`)', () => {
  it('sends an edit in the same call, with no timer', () => {
    const { writes, edit, autosave } = setUp({ delay: 0 });

    edit('a');

    expect(writes.send).toHaveBeenCalledTimes(1);
    expect(autosave.status.value).toBe('saving');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends edits made while a save is out once it answers, in one save, with the copy as it stands', async () => {
    const { writes, edit, autosave } = setUp({ delay: 0 });

    edit('a');
    edit('b');
    edit('c');
    expect(writes.send).toHaveBeenCalledTimes(1);

    await writes.answer();
    expect(writes.send).toHaveBeenCalledTimes(2);
    expect(writes.sent[1]).toEqual({ marks: ['a', 'b', 'c'] });
    expect(autosave.status.value).toBe('saving');

    await writes.answer();
    expect(writes.send).toHaveBeenCalledTimes(2);
    expect(autosave.status.value).toBe('saved');
    expect(autosave.unsaved.value).toBe(false);
  });

  it('answers a flush once the last edit has landed', async () => {
    const { writes, edit, autosave } = setUp({ delay: 0 });

    edit('a');
    edit('b');
    let settled: string | null | undefined;
    void autosave.flush().then((sentence) => (settled = sentence));

    await writes.answer();
    expect(settled).toBeUndefined();
    await writes.answer();
    expect(settled).toBeNull();
  });
});

describe('an autosave that takes the copy back on a failure (`takesBackOnFailure`)', () => {
  it('reads a failure on the way as a refusal: the copy goes back and nothing is kept for a Retry', async () => {
    const { writes, edit, autosave, afterRefusal } = setUp({
      delay: 0,
      takesBackOnFailure: true,
    });

    edit('a');
    await writes.fail(new Error('offline'));

    expect(afterRefusal).toHaveBeenCalledWith('The list was not saved.');
    expect(autosave.status.value).toBe('refused');
    expect(autosave.unsaved.value).toBe(false);
  });

  it('drops the edits behind a save that does not land, sending nothing more', async () => {
    const { writes, edit, autosave, afterRefusal } = setUp({
      delay: 0,
      takesBackOnFailure: true,
    });

    edit('a');
    edit('b');
    let settled: string | null | undefined;
    void autosave.flush().then((sentence) => (settled = sentence));
    await writes.fail(answered(500));

    expect(writes.send).toHaveBeenCalledTimes(1);
    expect(afterRefusal).toHaveBeenCalledTimes(1);
    expect(autosave.unsaved.value).toBe(false);
    expect(settled).toBe(afterRefusal.mock.calls[0]![0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes.send).toHaveBeenCalledTimes(1);
  });

  it("still says a refusal's own sentence", async () => {
    const { writes, edit, afterRefusal } = setUp({ delay: 0, takesBackOnFailure: true });

    edit('a');
    await writes.fail(answered(409, 'This market changed. Reload to see the latest.'));

    expect(afterRefusal).toHaveBeenCalledWith('This market changed. Reload to see the latest.');
  });

  it('keeps the copy for a screen that keeps a refused one', async () => {
    const { writes, edit, autosave } = setUp({
      delay: 0,
      takesBackOnFailure: true,
      keepOnRefusal: true,
    });

    edit('a');
    await writes.fail(noAnswer);

    expect(autosave.status.value).toBe('refused');
    expect(autosave.unsaved.value).toBe(true);
  });

  it('reads a failure as a failure when not asked', async () => {
    const { writes, edit, autosave, afterRefusal } = setUp({ delay: 0 });

    edit('a');
    await writes.fail(noAnswer);

    expect(afterRefusal).not.toHaveBeenCalled();
    expect(autosave.status.value).toBe('failed');
    expect(autosave.unsaved.value).toBe(true);
  });
});
