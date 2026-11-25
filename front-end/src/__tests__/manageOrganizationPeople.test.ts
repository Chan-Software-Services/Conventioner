/**
 * Manage organization's Admins and Members at 150 people (T204): each is a list frame, a find field
 * past 12 people, a count line, 50 rows and "Show N more", so the sections below stay near. A removal
 * or the re-read after it keeps the words and the rows shown; Remove after a search removes the
 * row's own person. A short list stays as simple as it was. Nobody is added from the dialog: an
 * invitation (`manageOrganizationInvites.test.ts`) places them only once they accept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import ManageOrgOverlay from '@/views/ManageOrgOverlay.vue';
import type { Organization, OrganizationPerson } from '@/assets/types/datatypes';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

enableAutoUnmount(afterEach);

const address = (n: number) => `person-${String(n).padStart(3, '0')}@people-at-scale.test`;
const person = (n: number): OrganizationPerson => ({ userId: `u-${n}`, email: address(n) });
const people = (count: number) => Array.from({ length: count }, (_, at) => person(at + 1));

function org(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org-1',
    name: 'Example People Org',
    owner: 'u-owner',
    admins: [],
    members: [],
    ownerEmail: 'owner@example.com',
    adminPeople: [],
    memberPeople: [],
    userRole: 'owner',
    marketCount: 2,
    marketsWithOwnRole: {},
    ...overrides,
  };
}

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [
  ...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];

const SECTIONS = [
  {
    section: 'Admins',
    people: 'adminPeople',
    group: 'manage-org-admins',
    frame: 'manage-org-admin-list',
    email: 'manage-org-admin-email',
    remove: 'manage-org-remove-user-button',
    add: 'add-admin',
    label: 'Find in admins',
    many: 'admins',
    one: 'admin',
    none: 'No admins',
  },
  {
    section: 'Members',
    people: 'memberPeople',
    group: 'manage-org-members',
    frame: 'manage-org-member-list',
    email: 'manage-org-member-email',
    remove: 'manage-org-remove-member-button',
    add: 'add-member',
    label: 'Find in members',
    many: 'members',
    one: 'member',
    none: 'No members',
  },
] as const;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe.each(SECTIONS)('Manage organization, $section at 150 people', (at) => {
  let served: Organization;

  function open(listed: OrganizationPerson[]): VueWrapper {
    served = org({ [at.people]: listed });
    api.get.mockImplementation(async (url: string) =>
      url === '/organizations'
        ? { data: { organizations: [served] } }
        : { data: { entries: [], next: null } },
    );
    return mount(ManageOrgOverlay, {
      props: { manageOpen: true, org: served },
      attachTo: document.body,
    });
  }

  /** The read answers with these people from now on. */
  const serves = (listed: OrganizationPerson[]) => {
    served = { ...served, [at.people]: listed };
  };

  const field = () => byTestId(`${at.frame}-find`) as HTMLInputElement | null;
  const count = () => byTestId(`${at.frame}-count`)?.textContent?.trim();
  const more = () => byTestId(`${at.frame}-more`);
  const addresses = () => allByTestId(at.email).map((cell) => cell.textContent);

  async function find(words: string) {
    const input = field()!;
    input.value = words;
    input.dispatchEvent(new Event('input'));
    await flushPromises();
  }

  async function removeFirstShown(next: OrganizationPerson[]) {
    allByTestId(at.remove)[0]!.click();
    await flushPromises();
    serves(next);
    byTestId('manage-org-remove-submit-button')!.click();
    await flushPromises();
  }

  it('draws the first 50, says how many, and shows more', async () => {
    open(people(150));
    await flushPromises();

    expect(count()).toBe('Showing 50 of 150');
    expect(addresses()).toHaveLength(50);
    expect(more()!.textContent?.trim()).toBe('Show 50 more');

    more()!.click();
    await flushPromises();
    expect(count()).toBe('Showing 100 of 150');
    expect(addresses()).toHaveLength(100);
    more()!.click();
    await flushPromises();
    expect(count()).toBe(`150 ${at.many}`);
    expect(more()).toBeNull();
  });

  it('finds by part of the address, capitals aside, under a field named for its section', async () => {
    open(people(150));
    await flushPromises();

    const label = document.body.querySelector(`label[for="${field()!.id}"]`);
    expect(label?.textContent?.trim()).toBe(at.label);

    await find('SON-077');
    expect(count()).toBe('1 of 150 matches "SON-077"');
    expect(addresses()).toEqual([address(77)]);

    await find('zzz');
    expect(count()).toBe('Nothing matches "zzz"');
    expect(addresses()).toEqual([]);
  });

  it('keeps the rows shown through a removal, and focus goes to the list', async () => {
    api.delete.mockResolvedValue({ data: {} });
    open(people(150));
    await flushPromises();
    more()!.click();
    await flushPromises();

    await removeFirstShown(people(150).slice(1));

    expect(api.delete).toHaveBeenCalledWith('/organizations/org-1/users/u-1');
    expect(count()).toBe('Showing 100 of 149');
    expect(addresses()).toHaveLength(100);
    expect(document.activeElement).toBe(byTestId(at.group));
  });

  it('keeps the words through a removal', async () => {
    api.delete.mockResolvedValue({ data: {} });
    open(people(150));
    await flushPromises();
    await find('person-07');

    await removeFirstShown(people(150).filter((p) => p.userId !== 'u-70'));

    expect(field()!.value).toBe('person-07');
    expect(count()).toBe('9 of 149 match "person-07"');
  });

  it('removes the row found by a search, by its own id', async () => {
    api.delete.mockResolvedValue({ data: {} });
    open(people(150));
    await flushPromises();
    await find('person-120');

    allByTestId(at.remove)[0]!.click();
    await flushPromises();
    expect(byTestId('manage-org-remove-window')!.getAttribute('aria-label')).toBe(
      `Remove ${address(120)} from Example People Org?`,
    );
    byTestId('manage-org-remove-submit-button')!.click();
    await flushPromises();

    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith('/organizations/org-1/users/u-120');
  });

  it('forgets the words when the dialog closes', async () => {
    const wrapper = open(people(150));
    await flushPromises();
    await find('person-077');

    await wrapper.setProps({ manageOpen: false });
    await flushPromises();
    await wrapper.setProps({ manageOpen: true });
    await flushPromises();

    expect(field()!.value).toBe('');
    expect(count()).toBe('Showing 50 of 150');
  });

  it('draws a short list with no field and no "Show N more"', async () => {
    open(people(3));
    await flushPromises();

    expect(field()).toBeNull();
    expect(more()).toBeNull();
    expect(count()).toBe(`3 ${at.many}`);
    expect(addresses()).toEqual(people(3).map((p) => p.email));
  });

  it('says the section is empty, until its add row opens', async () => {
    open([]);
    await flushPromises();

    const empty = () => byTestId(`${at.frame}-empty`)!.querySelector('p')!;
    expect(empty().textContent).toBe(at.none);
    expect(empty().style.display).toBe('');
    expect(byTestId(`${at.frame}-count`)).toBeNull();

    byTestId(`manage-org-${at.add}-button`)!.click();
    await flushPromises();
    expect(empty().style.display).toBe('none');
  });

  it('draws an address so it breaks only before its "@" or a dot', async () => {
    open([{ userId: 'u-long', email: 'a-long-address@people-at-scale.test' }]);
    await flushPromises();

    const cell = allByTestId(at.email)[0]!;
    expect(cell.textContent).toBe('a-long-address@people-at-scale.test');
    expect(cell.querySelectorAll('.email-address').length).toBeGreaterThan(0);
    expect(cell.querySelectorAll('.email-address-held').length).toBeGreaterThan(0);
  });

  it('counts a single person in the singular', async () => {
    open(people(1));
    await flushPromises();

    expect(count()).toBe(`1 ${at.one}`);
  });
});

describe('Manage organization, the two sections', () => {
  it('finds in each on its own: the words in one leave the other whole', async () => {
    const served = org({ adminPeople: people(20), memberPeople: people(150) });
    api.get.mockImplementation(async (url: string) =>
      url === '/organizations'
        ? { data: { organizations: [served] } }
        : { data: { entries: [], next: null } },
    );
    mount(ManageOrgOverlay, {
      props: { manageOpen: true, org: served },
      attachTo: document.body,
    });
    await flushPromises();

    const input = byTestId('manage-org-admin-list-find') as HTMLInputElement;
    input.value = 'person-007';
    input.dispatchEvent(new Event('input'));
    await flushPromises();

    expect(allByTestId('manage-org-admin-email')).toHaveLength(1);
    expect(byTestId('manage-org-member-list-count')!.textContent?.trim()).toBe('Showing 50 of 150');
  });

  it('draws the owner whole too', async () => {
    const served = org({ ownerEmail: 'a-long-owner@people-at-scale.test' });
    api.get.mockResolvedValue({ data: { organizations: [served], entries: [], next: null } });
    mount(ManageOrgOverlay, {
      props: { manageOpen: true, org: served },
      attachTo: document.body,
    });
    await flushPromises();

    const owner = document.body.querySelector('.user-card .user-email')!;
    expect(owner.textContent).toBe('a-long-owner@people-at-scale.test');
    expect(owner.querySelectorAll('.email-address-held').length).toBeGreaterThan(0);
  });
});

/**
 * Manage organization's own writes, Invite admin, Invite member, Rename and Remove, belong to the
 * opening they were sent from (T411): a press while one is out sends nothing, nothing closes Manage
 * organization while one is out, and an answer that lands after it was opened on another
 * organization leaves that organization's dialog alone. The invitations' own cases, a press sent
 * once and a success kept to its opening, are `manageOrganizationInvites.test.ts`'s.
 */
describe("Manage organization's writes belong to their opening", () => {
  function held<T = unknown>() {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const refused = (sentence: string) =>
    Object.assign(new Error('refused'), {
      isAxiosError: true,
      response: { status: 400, data: { error: sentence } },
    });

  const FIRST = org({ members: ['u-1'], memberPeople: [person(1)] });
  const OTHER = org({ id: 'org-2', name: 'Lakeside Collective' });

  function openOn(first: Organization) {
    api.get.mockImplementation(async (url: string) =>
      url === '/organizations'
        ? { data: { organizations: [FIRST, OTHER] } }
        : { data: { entries: [], next: null } },
    );
    return mount(ManageOrgOverlay, {
      props: { manageOpen: true, org: first },
      attachTo: document.body,
    });
  }

  /** Every way a person closes Manage organization, which has no Cancel of its own. */
  async function tryToCloseManageOrganization() {
    byTestId('manage-org-close-button')!.click();
    byTestId('manage-org-background')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
  }

  async function typeAnAddress(wrapper: VueWrapper, row: 'admin' | 'member', email: string) {
    await wrapper.get(`[data-testid="manage-org-add-${row}-button"]`).trigger('click');
    await flushPromises();
    await wrapper.get(`[data-testid="manage-org-add-${row}-input"]`).setValue(email);
  }

  const addForm = (wrapper: VueWrapper, row: 'admin' | 'member') =>
    wrapper.get(`[data-testid="manage-org-add-${row}-input"]`).element.closest('form')!;

  async function reopenOnTheOther(wrapper: VueWrapper) {
    await wrapper.setProps({ org: OTHER });
    await flushPromises();
  }

  it.each(['admin', 'member'] as const)(
    "keeps an invitation to %s's refusal out of Manage organization opened on another organization",
    async (row) => {
      const wrapper = openOn(FIRST);
      await flushPromises();
      await typeAnAddress(wrapper, row, 'newcomer@example.com');
      const answer = held();
      api.post.mockReturnValue(answer.promise);
      addForm(wrapper, row).requestSubmit();
      await flushPromises();

      await reopenOnTheOther(wrapper);
      await typeAnAddress(wrapper, row, 'typed-here@example.com');
      answer.reject(refused('You have sent many invitations. Try again in 12 minutes.'));
      await flushPromises();

      expect(byTestId(`manage-org-add-${row}-error`)).toBeNull();
      expect(wrapper.text()).not.toContain('You have sent many invitations');
      expect(wrapper.get('.org-name').text()).toBe('Lakeside Collective');
    },
  );

  it('drops a re-read of the organization it was open on once it is open on another', async () => {
    const wrapper = openOn(FIRST);
    await flushPromises();
    const reread = held<unknown[]>();
    api.get.mockImplementation(async (url: string) =>
      url === '/organizations'
        ? { data: { organizations: await reread.promise } }
        : { data: { entries: [], next: null, invitations: [] } },
    );
    api.delete.mockResolvedValue({ data: {} });
    byTestId('manage-org-remove-member-button')!.click();
    await flushPromises();
    byTestId('manage-org-remove-submit-button')!.click();
    await flushPromises();

    await reopenOnTheOther(wrapper);
    reread.resolve([{ ...FIRST, memberPeople: [person(1), person(2)] }, OTHER]);
    await flushPromises();

    expect(wrapper.get('.org-name').text()).toBe('Lakeside Collective');
    expect(allByTestId('manage-org-member-email')).toHaveLength(0);
  });

  it('Rename sends once for two presses and holds Manage organization until it lands', async () => {
    const wrapper = openOn(FIRST);
    await flushPromises();
    await wrapper.get('[data-testid="manage-org-rename-input"]').setValue('Autumn Makers');
    const answer = held();
    api.put.mockReturnValue(answer.promise);

    await wrapper.get('.rename-row').trigger('submit');
    await wrapper.get('.rename-row').trigger('submit');
    await flushPromises();
    await tryToCloseManageOrganization();

    expect(api.put).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('manageClose')).toBeUndefined();

    answer.reject(refused('An organization with this name already exists.'));
    await flushPromises();
    expect(wrapper.get('[data-testid="manage-org-rename-error"]').text()).toBe(
      'An organization with this name already exists.',
    );
    await tryToCloseManageOrganization();
    expect(wrapper.emitted('manageClose')).not.toBeUndefined();
  });

  it.each([
    ['refusal', (answer: ReturnType<typeof held>) => answer.reject(refused('Name taken.'))],
    ['success', (answer: ReturnType<typeof held>) => answer.resolve({ data: {} })],
  ])(
    "keeps a rename's %s out of Manage organization opened on another organization",
    async (_, land) => {
      const wrapper = openOn(FIRST);
      await flushPromises();
      await wrapper.get('[data-testid="manage-org-rename-input"]').setValue('Autumn Makers');
      const answer = held();
      api.put.mockReturnValue(answer.promise);
      await wrapper.get('.rename-row').trigger('submit');
      await flushPromises();

      await reopenOnTheOther(wrapper);
      land(answer);
      await flushPromises();

      expect(byTestId('manage-org-rename-error')).toBeNull();
      expect(
        (wrapper.get('[data-testid="manage-org-rename-input"]').element as HTMLInputElement).value,
      ).toBe('Lakeside Collective');
      expect(wrapper.get('.org-name').text()).toBe('Lakeside Collective');
    },
  );
});
