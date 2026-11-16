// @vitest-environment happy-dom
/**
 * Create new market posts only what the dialog asks for: the name, the organization, how vendors
 * apply, and when. The server starts every other field of a new market itself, and drops any key
 * outside `MARKET_CREATE_FIELDS` in `back-end/api/markets.py`.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const push = vi.fn();
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push }),
}));

vi.mock('@/utils/organizations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/organizations')>()),
  fetchOrganizations: () => Promise.resolve([{ id: 'org-1', name: 'Example Collective' }]),
}));

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/api')>()),
  api,
}));

import NewMarketOverlay from '@/views/NewMarketOverlay.vue';
import { tryEveryClose } from './support/dialogCloses';

beforeEach(() => {
  api.post.mockReset();
  push.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
});

it('posts the name, the organization, how vendors apply and the date, and nothing else', async () => {
  api.post.mockResolvedValue({ data: { market_id: 'market-1' } });
  const wrapper = mount(NewMarketOverlay, {
    props: { newOpen: true },
    global: { stubs: { RouterLink: true } },
    attachTo: document.body,
  });
  await flushPromises();

  await wrapper.get('[data-testid="new-market-name-input"]').setValue('Spring Fair');
  await wrapper.get('[data-testid="new-market-path-form"] input').setValue(true);
  await wrapper.get('form').trigger('submit');
  await flushPromises();

  expect(api.post).toHaveBeenCalledTimes(1);
  const [url, body] = api.post.mock.calls[0];
  expect(url).toBe('/markets');
  expect(Object.keys(body).sort()).toEqual([
    'creationDate',
    'intakeMode',
    'name',
    'organizationId',
  ]);
  expect(body).toMatchObject({ name: 'Spring Fair', organizationId: 'org-1', intakeMode: 'form' });
  expect(push).toHaveBeenCalledWith(expect.stringContaining('market-1'));
  wrapper.unmount();
});

/** The dialog open with a market ready to create: a name, its one organization and a path. */
async function readyToCreate() {
  const wrapper = mount(NewMarketOverlay, {
    props: { newOpen: true },
    global: { stubs: { RouterLink: true } },
    attachTo: document.body,
  });
  await flushPromises();
  await wrapper.get('[data-testid="new-market-name-input"]').setValue('Spring Fair');
  await wrapper.get('[data-testid="new-market-path-form"] input').setValue(true);
  return wrapper;
}

const refused = (sentence: string) =>
  Object.assign(new Error('refused'), {
    isAxiosError: true,
    response: { status: 409, data: { error: sentence } },
  });

it('makes one market for two presses, and nothing closes it while it creates (T411)', async () => {
  let answer!: (value: unknown) => void;
  api.post.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  const wrapper = await readyToCreate();

  document.querySelector('form')!.requestSubmit();
  document.querySelector('form')!.requestSubmit();
  await flushPromises();
  await tryEveryClose('new-market');

  expect(api.post).toHaveBeenCalledTimes(1);
  expect(wrapper.emitted('newClose')).toBeUndefined();
  expect(
    document.querySelector('[data-testid="new-market-submit-button"]')!.hasAttribute('disabled'),
  ).toBe(true);

  answer({ data: { market_id: 'market-1' } });
  await flushPromises();
  expect(push).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});

it("opens without the last opening's refusal, and a change to the name takes a refusal away", async () => {
  const clash = 'A market already uses that web address.';
  api.post.mockRejectedValue(refused(clash));
  const wrapper = await readyToCreate();

  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-testid="new-market-error"]').text()).toBe(clash);

  await wrapper.get('[data-testid="new-market-name-input"]').setValue('Spring Fair 2');
  expect(wrapper.find('[data-testid="new-market-error"]').exists()).toBe(false);

  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-testid="new-market-error"]').text()).toBe(clash);

  await wrapper.setProps({ newOpen: false });
  await wrapper.setProps({ newOpen: true });
  await flushPromises();
  expect(wrapper.find('[data-testid="new-market-error"]').exists()).toBe(false);
  expect(document.body.textContent).not.toContain(clash);
  wrapper.unmount();
});
