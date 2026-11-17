/**
 * When the review's list was last read, as both views say it (E38/F05/S03), and that it ages on
 * screen without another read; `useUpdatedWords` is the ageing clock `ListFreshness` and
 * Attendance both read (T466).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, effectScope, h, ref } from 'vue';
import { updatedAgo } from '@/utils/updatedAgo';
import { useUpdatedWords } from '@/utils/useUpdatedWords';
import ListFreshness from '@/components/ListFreshness.vue';

const READ = Date.parse('2026-11-18T09:00:00Z');
const after = (seconds: number) => updatedAgo(READ, READ + seconds * 1000);

describe('updatedAgo', () => {
  it('says just now for the first minute', () => {
    expect(after(0)).toBe('Updated just now');
    expect(after(59)).toBe('Updated just now');
  });

  it('counts whole minutes, then hours', () => {
    expect(after(60)).toBe('Updated 1 minute ago');
    expect(after(150)).toBe('Updated 2 minutes ago');
    expect(after(59 * 60 + 59)).toBe('Updated 59 minutes ago');
    expect(after(60 * 60)).toBe('Updated 1 hour ago');
    expect(after(3 * 60 * 60 + 5)).toBe('Updated 3 hours ago');
  });

  it('reads a clock that runs behind the read as just now', () => {
    expect(after(-30)).toBe('Updated just now');
  });
});

describe('ListFreshness', () => {
  afterEach(() => vi.useRealTimers());

  it('ages as it stays on screen', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(READ);
    const wrapper = mount(ListFreshness, {
      props: { readAt: READ, refreshing: false, failed: '', testid: 'applications' },
    });
    expect(wrapper.get('[data-testid="applications-updated"]').text()).toBe('Updated just now');

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(wrapper.get('[data-testid="applications-updated"]').text()).toBe(
      'Updated 2 minutes ago',
    );
    wrapper.unmount();
  });

  it('asks for a refresh, and says when one failed', async () => {
    const wrapper = mount(ListFreshness, {
      props: { readAt: READ, refreshing: false, failed: '', testid: 'applications' },
    });
    await wrapper.get('[data-testid="applications-refresh"]').trigger('click');
    expect(wrapper.emitted('refresh')).toHaveLength(1);

    await wrapper.setProps({ refreshing: true });
    expect(
      wrapper.get<HTMLButtonElement>('[data-testid="applications-refresh"]').element.disabled,
    ).toBe(true);
    await wrapper.setProps({ refreshing: false, failed: 'Could not refresh.' });
    expect(wrapper.get('[data-testid="applications-refresh-error"]').text()).toBe(
      'Could not refresh.',
    );
    wrapper.unmount();
  });
});

describe('useUpdatedWords', () => {
  afterEach(() => vi.useRealTimers());

  /** A component that says the words, as a screen would, over a read time it can change. */
  function mountWords(readAt: number | null) {
    const at = ref<number | null>(readAt);
    const wrapper = mount(
      defineComponent({
        setup() {
          const words = useUpdatedWords(at);
          return () => h('p', words.value);
        },
      }),
    );
    return { wrapper, at };
  }

  it('says nothing before the first read', () => {
    const { wrapper } = mountWords(null);
    expect(wrapper.text()).toBe('');
    wrapper.unmount();
  });

  it('ages every 10 seconds as it stays on screen', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(READ);
    const { wrapper } = mountWords(READ);
    expect(wrapper.text()).toBe('Updated just now');

    // A minute turns at the next 10-second tick, not later.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(wrapper.text()).toBe('Updated 1 minute ago');
    await vi.advanceTimersByTimeAsync(9 * 1000);
    expect(wrapper.text()).toBe('Updated 1 minute ago');
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(wrapper.text()).toBe('Updated 3 minutes ago');
    wrapper.unmount();
  });

  it('says a read that lands now as just now, before the clock turns', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(READ);
    const { wrapper, at } = mountWords(READ);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 5 * 1000);
    expect(wrapper.text()).toBe('Updated 5 minutes ago');

    // Read again between two ticks: the clock is behind the read, which is now.
    vi.setSystemTime(READ + 5 * 60 * 1000 + 8 * 1000);
    at.value = Date.now();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toBe('Updated just now');
    wrapper.unmount();
  });

  it('stops its clock when the screen goes', async () => {
    vi.useFakeTimers();
    const { wrapper } = mountWords(Date.now());
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no clock outside a scope that could stop it, and still says the read', () => {
    vi.useFakeTimers();
    const words = useUpdatedWords(ref<number | null>(Date.now()));
    expect(vi.getTimerCount()).toBe(0);
    expect(words.value).toBe('Updated just now');
  });

  it('runs its clock for the effect scope that called it, and stops it with that scope', () => {
    vi.useFakeTimers();
    const scope = effectScope();
    scope.run(() => useUpdatedWords(ref<number | null>(Date.now())));
    expect(vi.getTimerCount()).toBe(1);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ListFreshness without its time', () => {
  it('draws Refresh and a failed refresh, and no time, for a screen that says it elsewhere', async () => {
    const wrapper = mount(ListFreshness, {
      props: { readAt: READ, refreshing: false, failed: '', testid: 'attendance', showTime: false },
    });
    expect(wrapper.find('[data-testid="attendance-updated"]').exists()).toBe(false);
    expect(wrapper.text()).toBe('Refresh');

    await wrapper.get('[data-testid="attendance-refresh"]').trigger('click');
    expect(wrapper.emitted('refresh')).toHaveLength(1);
    await wrapper.setProps({ failed: 'Could not refresh.' });
    expect(wrapper.get('[data-testid="attendance-refresh-error"]').text()).toBe(
      'Could not refresh.',
    );
    wrapper.unmount();
  });

  it('shows its time unless told not to', () => {
    const wrapper = mount(ListFreshness, {
      props: { readAt: READ, refreshing: false, failed: '', testid: 'applications' },
    });
    expect(wrapper.find('[data-testid="applications-updated"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
