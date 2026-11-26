// @vitest-environment happy-dom
/**
 * The organizations list follows the newest read of it. Creating an organization reads the list
 * again; when the read the page opened with answered after that one, its older list - without the
 * new organization - replaced it, and the card the organizer had just made vanished.
 */
import { describe, it, expect, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const fetchOrganizations = vi.fn();
vi.mock('@/utils/organizations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/organizations')>()),
  fetchOrganizations: () => fetchOrganizations(),
}));
const post = vi.fn();
vi.mock('@/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/api')>()),
  api: { post: (...args: unknown[]) => post(...args) },
}));

import { createMemoryHistory, createRouter } from 'vue-router';
import OrganizationsView from '@/views/OrganizationsView.vue';
import AppDialog from '@/components/AppDialog.vue';
import ManageOrgOverlay from '@/views/ManageOrgOverlay.vue';

/** The page at an address, as the app routes it. */
async function at(address: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/organizations', name: 'organizations', component: OrganizationsView }],
  });
  await router.push(address);
  await router.isReady();
  return router;
}

async function mountAt(address = '/organizations') {
  const router = await at(address);
  const wrapper = mount(OrganizationsView, {
    global: { plugins: [router], stubs: { ManageOrgOverlay: true } },
  });
  return { router, wrapper };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const OLD = { id: 'org-1', name: 'Riverside Makers', userRole: 'owner', marketCount: 0 };
const NEW = { id: 'org-2', name: 'Harbour Collective', userRole: 'owner', marketCount: 0 };

/** Create an organization through the dialog, as the organizer does. */
async function create(wrapper: ReturnType<typeof mount>, name: string) {
  await wrapper.get('[data-testid="organizations-create-button"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="organizations-create-name-input"]').setValue(name);
  wrapper
    .findAllComponents(AppDialog)
    .find((dialog) => dialog.props('testid') === 'organizations-create')!
    .vm.$emit('submit');
  await flushPromises();
}

describe('the organizations list', () => {
  it('keeps the newest read when an older one answers after it', async () => {
    const opening = deferred<unknown[]>();
    const afterCreate = deferred<unknown[]>();
    fetchOrganizations
      .mockReturnValueOnce(opening.promise)
      .mockReturnValueOnce(afterCreate.promise);
    post.mockResolvedValue({ data: {} });

    const { wrapper } = await mountAt();
    await create(wrapper, 'Harbour Collective');
    afterCreate.resolve([OLD, NEW]);
    await flushPromises();
    opening.resolve([OLD]);
    await flushPromises();

    expect(wrapper.text()).toContain('Harbour Collective');
  });

  it('keeps the cards on screen while it reads the list again', async () => {
    fetchOrganizations.mockResolvedValueOnce([OLD]);
    post.mockResolvedValue({ data: {} });
    const { wrapper } = await mountAt();
    await flushPromises();
    expect(wrapper.text()).toContain('Riverside Makers');

    const again = deferred<unknown[]>();
    fetchOrganizations.mockReturnValueOnce(again.promise);
    await create(wrapper, 'Harbour Collective');
    expect(wrapper.text()).toContain('Riverside Makers');
    expect(wrapper.text()).not.toContain('Loading organizations');
    again.resolve([OLD, NEW]);
  });
});

describe("an organization's card", () => {
  it('counts the markets the read counted, as the Remove confirmation over it does', async () => {
    // E38/F15/S01: the organization's own `markets` list is kept in step only at best effort, so
    // the card and the confirmation both say the count the read takes from the markets themselves.
    fetchOrganizations.mockResolvedValueOnce([{ ...OLD, marketCount: 11 }]);
    const { wrapper } = await mountAt();
    await flushPromises();

    const facts = wrapper.get('[data-testid="organization-card"] .summary-card-facts');
    expect(facts.text()).toContain('Markets');
    expect(facts.get('dd').text()).toBe('11');
  });
});

/** A read that failed says how, and offers to read again (E38/F11/S01). */
describe('the organizations list, when its read fails', () => {
  it('says the organizer seems offline, and Try again reads the list again', async () => {
    fetchOrganizations.mockRejectedValueOnce({ isAxiosError: true, request: {} });
    const { wrapper } = await mountAt();
    await flushPromises();

    expect(wrapper.get('[data-testid="organizations-read-failed"]').text()).toContain(
      'You seem to be offline. Check the connection and try again.',
    );

    fetchOrganizations.mockResolvedValueOnce([OLD]);
    await wrapper.get('[data-testid="organizations-retry"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="organizations-read-failed"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Riverside Makers');
  });
});

describe('Manage organization from its address', () => {
  const manage = (wrapper: ReturnType<typeof mount>) => wrapper.getComponent(ManageOrgOverlay);

  it('opens for the organization `?manage=` names once the list has loaded', async () => {
    // Manage market's "Manage organization" points here (E38/F12/S01).
    fetchOrganizations.mockResolvedValueOnce([OLD, NEW]);
    const { wrapper } = await mountAt('/organizations?manage=org-2');
    await flushPromises();

    expect(manage(wrapper).props('manageOpen')).toBe(true);
    expect(manage(wrapper).props('org')).toMatchObject({ id: 'org-2' });
  });

  it('drops the key when it closes, so a refresh or Back does not open it again', async () => {
    fetchOrganizations.mockResolvedValue([OLD, NEW]);
    const { router, wrapper } = await mountAt('/organizations?manage=org-2');
    await flushPromises();

    manage(wrapper).vm.$emit('manageClose');
    await flushPromises();

    expect(manage(wrapper).props('manageOpen')).toBe(false);
    expect(router.currentRoute.value.query).toEqual({});
  });

  it("drops a key that names none of the reader's organizations, and opens nothing", async () => {
    fetchOrganizations.mockResolvedValueOnce([OLD]);
    const { router, wrapper } = await mountAt('/organizations?manage=org-9');
    await flushPromises();

    expect(manage(wrapper).props('manageOpen')).toBe(false);
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('keeps the key through a failed read, and opens it once Try again reads the list', async () => {
    fetchOrganizations.mockRejectedValueOnce({ isAxiosError: true, request: {} });
    const { router, wrapper } = await mountAt('/organizations?manage=org-1');
    await flushPromises();

    expect(manage(wrapper).props('manageOpen')).toBe(false);
    expect(router.currentRoute.value.query).toEqual({ manage: 'org-1' });

    fetchOrganizations.mockResolvedValueOnce([OLD]);
    await wrapper.get('[data-testid="organizations-retry"]').trigger('click');
    await flushPromises();

    expect(manage(wrapper).props('manageOpen')).toBe(true);
    expect(manage(wrapper).props('org')).toMatchObject({ id: 'org-1' });
  });

  it('drops the key once a read after a failed one names none of the reader’s', async () => {
    fetchOrganizations.mockRejectedValueOnce({ isAxiosError: true, request: {} });
    const { router, wrapper } = await mountAt('/organizations?manage=org-9');
    await flushPromises();

    fetchOrganizations.mockResolvedValueOnce([OLD]);
    await wrapper.get('[data-testid="organizations-retry"]').trigger('click');
    await flushPromises();

    expect(manage(wrapper).props('manageOpen')).toBe(false);
    expect(router.currentRoute.value.query).toEqual({});
  });

  /**
   * A create reads the list again without "Try again": until that read answers, the page has no
   * list, so it neither says there is none nor judges the key against one.
   */
  it('waits for the read a create sends after a failed one before it judges the key', async () => {
    fetchOrganizations.mockRejectedValueOnce({ isAxiosError: true, request: {} });
    post.mockReset().mockResolvedValue({ data: {} });
    const { router, wrapper } = await mountAt('/organizations?manage=org-1');
    await flushPromises();

    const again = deferred<unknown[]>();
    fetchOrganizations.mockReturnValueOnce(again.promise);
    await create(wrapper, 'Harbour Collective');

    expect(router.currentRoute.value.query).toEqual({ manage: 'org-1' });
    expect(wrapper.text()).not.toContain('No organizations found');
    expect(wrapper.find('[data-testid="organizations-read-failed"]').exists()).toBe(true);

    again.resolve([OLD, NEW]);
    await flushPromises();

    expect(wrapper.find('[data-testid="organizations-read-failed"]').exists()).toBe(false);
    expect(manage(wrapper).props('manageOpen')).toBe(true);
    expect(manage(wrapper).props('org')).toMatchObject({ id: 'org-1' });
  });
});

/**
 * New organization writes through its submission (T411): one organization however often Create is
 * pressed, the dialog held until it answers, and a refusal said in the opening it was sent from.
 */
describe('New organization', () => {
  const refused = (sentence: string) =>
    Object.assign(new Error('refused'), {
      isAxiosError: true,
      response: { status: 400, data: { error: sentence } },
    });

  async function openNew(wrapper: ReturnType<typeof mount>, name: string) {
    await wrapper.get('[data-testid="organizations-create-button"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="organizations-create-name-input"]').setValue(name);
  }

  const pressCreate = (wrapper: ReturnType<typeof mount>) =>
    (
      wrapper.get('[data-testid="organizations-create-window"] form').element as HTMLFormElement
    ).requestSubmit();
  const dialog = (wrapper: ReturnType<typeof mount>) =>
    wrapper.find('[data-testid="organizations-create-window"]');

  /** Every way a person closes the dialog. */
  async function tryEveryClose(wrapper: ReturnType<typeof mount>) {
    for (const part of ['close-button', 'cancel-button', 'background']) {
      await wrapper.get(`[data-testid="organizations-create-${part}"]`).trigger('click');
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
  }

  it('makes one organization for two presses, and nothing closes it until it lands', async () => {
    fetchOrganizations.mockResolvedValue([OLD]);
    const answer = deferred<unknown>();
    post.mockReset().mockReturnValue(answer.promise);
    const { wrapper } = await mountAt();
    await flushPromises();
    await openNew(wrapper, 'Harbour Collective');

    pressCreate(wrapper);
    pressCreate(wrapper);
    await flushPromises();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/organizations', { name: 'Harbour Collective' });
    expect(
      wrapper.get('[data-testid="organizations-create-submit-button"]').attributes('disabled'),
    ).toBeDefined();
    await tryEveryClose(wrapper);
    expect(dialog(wrapper).exists()).toBe(true);

    fetchOrganizations.mockResolvedValue([OLD, NEW]);
    answer.resolve({ data: {} });
    await flushPromises();
    expect(dialog(wrapper).exists()).toBe(false);
    expect(wrapper.text()).toContain('Harbour Collective');
    wrapper.unmount();
  });

  it('says a refusal until the name changes, and not in its next opening', async () => {
    fetchOrganizations.mockResolvedValue([OLD]);
    post.mockReset().mockRejectedValue(refused('That name is taken.'));
    const { wrapper } = await mountAt();
    await flushPromises();
    await openNew(wrapper, 'Riverside Makers');

    pressCreate(wrapper);
    await flushPromises();
    const error = () => wrapper.find('[data-testid="organizations-create-error"]');
    expect(error().text()).toBe('That name is taken.');

    await wrapper.get('[data-testid="organizations-create-name-input"]').setValue('Riverside Two');
    expect(error().exists()).toBe(false);

    pressCreate(wrapper);
    await flushPromises();
    expect(error().text()).toBe('That name is taken.');
    await wrapper.get('[data-testid="organizations-create-cancel-button"]').trigger('click');
    await flushPromises();
    await openNew(wrapper, 'Harbour Collective');

    expect(error().exists()).toBe(false);
    wrapper.unmount();
  });
});
