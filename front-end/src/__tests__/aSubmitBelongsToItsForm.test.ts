// @vitest-environment happy-dom
/**
 * A form's submit is one transition table (T277 ticket 08, report 4.8): a second press while one
 * is out sends nothing, and an answer that lands after the form moved on (another mode, another
 * step, another opening) belongs to what the person left, so it never touches what they moved to.
 *
 * `submitStep` is the table, one test per row; `useSubmit` is the table held by a component,
 * driven here by a tiny form whose answers the test holds open and settles when it says.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { submitStep, useSubmit, type SubmitPhase, type SubmitState } from '@/utils/useSubmit';

const editing: SubmitPhase = { kind: 'editing' };
const sending: SubmitPhase = { kind: 'sending' };
const done: SubmitPhase = { kind: 'done' };
const refused: SubmitPhase = { kind: 'refused', sentence: 'No.' };

function at(phase: SubmitPhase, opening = 3): SubmitState {
  return { phase, opening };
}

describe('the transition table', () => {
  it('row 1: a submit from editing is sending', () => {
    expect(submitStep(at(editing), { kind: 'submit' })).toEqual(at(sending));
  });

  it('row 2: the answer of this opening, from sending, is done', () => {
    expect(submitStep(at(sending), { kind: 'ok', opening: 3 })).toEqual(at(done));
  });

  it("row 3: this opening's refusal, from sending, is refused with its sentence", () => {
    expect(submitStep(at(sending), { kind: 'refused', opening: 3, sentence: 'Too soon.' })).toEqual(
      at({ kind: 'refused', sentence: 'Too soon.' }),
    );
  });

  it('row 4: an edit after a refusal is editing again', () => {
    expect(submitStep(at(refused), { kind: 'edit' })).toEqual(at(editing));
  });

  it('row 5: a submit after a refusal is sending', () => {
    expect(submitStep(at(refused), { kind: 'submit' })).toEqual(at(sending));
  });

  it('row 6: an opening, from any phase, is editing in the next opening', () => {
    for (const phase of [editing, sending, refused, done]) {
      expect(submitStep(at(phase), { kind: 'open' })).toEqual(at(editing, 4));
    }
  });

  it('row 7: a submit while sending is refused, the state unchanged', () => {
    const state = at(sending);
    expect(submitStep(state, { kind: 'submit' })).toBe(state);
  });

  it('row 8: an edit after a save that stays open is editing again', () => {
    expect(submitStep(at(done), { kind: 'edit' })).toEqual(at(editing));
  });

  it('row 9: a submit after a save that stays open is sending', () => {
    expect(submitStep(at(done), { kind: 'submit' })).toEqual(at(sending));
  });

  it("row 10: an earlier opening's answer or refusal changes nothing, in any phase", () => {
    for (const phase of [editing, sending, refused, done]) {
      const state = at(phase);
      expect(submitStep(state, { kind: 'ok', opening: 2 })).toBe(state);
      expect(submitStep(state, { kind: 'refused', opening: 2, sentence: 'Late.' })).toBe(state);
    }
  });

  it('row 11: an edit while editing changes nothing', () => {
    const state = at(editing);
    expect(submitStep(state, { kind: 'edit' })).toBe(state);
  });

  it('leaves every other event in a phase unchanged', () => {
    const sendingState = at(sending);
    expect(submitStep(sendingState, { kind: 'edit' })).toBe(sendingState);
    for (const phase of [editing, refused, done]) {
      const state = at(phase);
      expect(submitStep(state, { kind: 'ok', opening: 3 })).toBe(state);
      expect(submitStep(state, { kind: 'refused', opening: 3, sentence: 'No.' })).toBe(state);
    }
  });
});

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** What the tiny form was told, in order. */
const told: string[] = [];

/**
 * A form with a field, a Send button and a step the test moves: the scope. It shows the phase, the
 * sentence and what `done` handed it; `refusedSays` is what its `refused` handler returns.
 */
function tinyForm(send: () => Promise<string>, refusedSays?: string) {
  return defineComponent({
    setup() {
      const step = ref('one');
      const shown = ref('');
      const { phase, sending, sentence, submit, edit } = useSubmit({
        scope: () => step.value,
        failure: 'It did not go through.',
      });
      const press = () =>
        submit(send, {
          done: (answer) => {
            shown.value = answer;
            told.push(`done ${answer}`);
          },
          refused: (err) => {
            told.push(`refused ${(err as Error).message}`);
            return refusedSays;
          },
          late: (answer) => told.push(answer.ok ? `late ok ${answer.answer}` : 'late refused'),
        });
      return () =>
        h('form', { onSubmit: (e: Event) => (e.preventDefault(), void press()) }, [
          h('input', { 'data-testid': 'field', onInput: edit }),
          h('button', { 'data-testid': 'send', disabled: sending.value }, 'Send'),
          h('button', {
            type: 'button',
            'data-testid': 'move',
            onClick: () => (step.value = step.value === 'one' ? 'two' : 'one'),
          }),
          h('p', { 'data-testid': 'phase' }, phase.value.kind),
          h('p', { 'data-testid': 'sentence' }, sentence.value),
          h('p', { 'data-testid': 'shown' }, shown.value),
        ]);
    },
  });
}

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  told.length = 0;
});

function text(testid: string) {
  return wrapper!.get(`[data-testid="${testid}"]`).text();
}

describe('useSubmit', () => {
  it('sends once for a second press while the first is out, and is done on its answer', async () => {
    const answer = held<string>();
    const send = vi.fn(() => answer.promise);
    wrapper = mount(tinyForm(send));

    await wrapper.get('form').trigger('submit');
    await wrapper.get('form').trigger('submit');

    expect(send).toHaveBeenCalledTimes(1);
    expect(text('phase')).toBe('sending');
    expect((wrapper.get('[data-testid="send"]').element as HTMLButtonElement).disabled).toBe(true);

    answer.resolve('sent');
    await flushPromises();

    expect(text('phase')).toBe('done');
    expect(text('shown')).toBe('sent');
    expect(told).toEqual(['done sent']);
  });

  it("says the refusal's own sentence, and drops it when a field changes", async () => {
    wrapper = mount(tinyForm(() => Promise.reject(new Error('no')), 'Wait a minute.'));

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(text('phase')).toBe('refused');
    expect(text('sentence')).toBe('Wait a minute.');

    await wrapper.get('[data-testid="field"]').trigger('input');

    expect(text('phase')).toBe('editing');
    expect(text('sentence')).toBe('');
  });

  it("takes the sentence from the server's answer when the handler gives none", async () => {
    const config = { headers: {} } as InternalAxiosRequestConfig;
    const tooSoon = new AxiosError('429', 'ERR_BAD_REQUEST', config, null, {
      status: 429,
      statusText: 'TOO MANY REQUESTS',
      data: { error: 'Please wait before asking for another code.' },
      headers: {},
      config,
    });
    wrapper = mount(tinyForm(() => Promise.reject(tooSoon)));

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(text('sentence')).toBe('Please wait before asking for another code.');
  });

  it('says its failure for a refusal that carries no sentence', async () => {
    wrapper = mount(tinyForm(() => Promise.reject(new Error('Network Error'))));

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(text('sentence')).toBe('It did not go through.');
  });

  it('drops an answer that lands after the scope moved on, and hands it to `late`', async () => {
    const answer = held<string>();
    wrapper = mount(tinyForm(() => answer.promise));

    await wrapper.get('form').trigger('submit');
    await wrapper.get('[data-testid="move"]').trigger('click');

    expect(text('phase')).toBe('editing');

    answer.resolve('sent');
    await flushPromises();

    expect(text('phase')).toBe('editing');
    expect(text('shown')).toBe('');
    expect(told).toEqual(['late ok sent']);
  });

  it('drops a refusal that lands after the scope moved on, and hands it to `late`', async () => {
    const answer = held<string>();
    wrapper = mount(tinyForm(() => answer.promise, 'Wait a minute.'));

    await wrapper.get('form').trigger('submit');
    await wrapper.get('[data-testid="move"]').trigger('click');
    answer.reject(new Error('no'));
    await flushPromises();

    expect(text('phase')).toBe('editing');
    expect(text('sentence')).toBe('');
    expect(told).toEqual(['late refused']);
  });

  it('sends again in the scope moved to while the earlier answer is still out', async () => {
    const first = held<string>();
    const second = held<string>();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    wrapper = mount(tinyForm(send));

    await wrapper.get('form').trigger('submit');
    await wrapper.get('[data-testid="move"]').trigger('click');
    await wrapper.get('form').trigger('submit');
    second.resolve('second');
    await flushPromises();
    first.resolve('first');
    await flushPromises();

    expect(send).toHaveBeenCalledTimes(2);
    expect(text('shown')).toBe('second');
    expect(told).toEqual(['done second', 'late ok first']);
  });

  it('calls nothing for an answer that lands after the form is gone', async () => {
    const answer = held<string>();
    const refusal = held<string>();
    const send = vi.fn().mockReturnValueOnce(answer.promise);
    wrapper = mount(tinyForm(send));
    const other = mount(tinyForm(() => refusal.promise));

    await wrapper.get('form').trigger('submit');
    await other.get('form').trigger('submit');
    wrapper.unmount();
    wrapper = null;
    other.unmount();
    answer.resolve('sent');
    refusal.reject(new Error('no'));
    await flushPromises();

    expect(told).toEqual([]);
  });
});
