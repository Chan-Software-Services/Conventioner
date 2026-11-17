// @vitest-environment happy-dom
/**
 * A page that fills the window (T465): while one is mounted `<html>` carries `fills-the-window`,
 * so the window keeps no gutter for a bar it never shows, and the class goes when the last such
 * page leaves.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useFillsTheWindow } from '@/utils/useFillsTheWindow';

const Page = defineComponent({
  setup() {
    useFillsTheWindow();
    return () => h('div');
  },
});

const holds = () => document.documentElement.classList.contains('fills-the-window');

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const page of mounted.splice(0)) page.unmount();
});

const open = () => {
  const page = mount(Page);
  mounted.push(page);
  return page;
};
const close = (page: VueWrapper) => {
  page.unmount();
  mounted.splice(mounted.indexOf(page), 1);
};

describe('a page that fills the window', () => {
  it('puts the class on <html> while it is mounted, and takes it off on unmount', () => {
    expect(holds()).toBe(false);
    const page = open();
    expect(holds()).toBe(true);
    close(page);
    expect(holds()).toBe(false);
  });

  it('keeps the class while another such page is still mounted', () => {
    const first = open();
    const second = open();
    close(first);
    expect(holds()).toBe(true);
    close(second);
    expect(holds()).toBe(false);
  });
});
