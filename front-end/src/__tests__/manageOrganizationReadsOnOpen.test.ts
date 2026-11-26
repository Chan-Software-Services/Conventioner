/**
 * Manage organization reads the organization as it opens: the organizations list's copy it is opened
 * with can be older than what is true, as it is reopened before the list's read again has answered.
 * Until that first read answers, Admins and Members say they are loading and list nobody of the
 * copy; a read that fails leaves the copy, with the failure said; a reader the list no longer holds
 * it for is told so; and a change made in the dialog while the read is out is not undone by it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import ManageOrgOverlay from '@/views/ManageOrgOverlay.vue';
import type { Organization, OrganizationPerson } from '@/assets/types/datatypes';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

enableAutoUnmount(afterEach);

const person = (name: string): OrganizationPerson => ({
  userId: `u-${name}`,
  email: `${name}@example.com`,
});

function org(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org-1',
    name: 'Seed Test Org',
    ownerEmail: 'owner@example.com',
    adminPeople: [],
    memberPeople: [],
    userRole: 'owner',
    marketCount: 0,
    marketsWithOwnRole: {},
    ...overrides,
  };
}

/** What the list opened it with, and what is true by the time it is opened. */
const COPY = org({ memberPeople: [person('left')] });
const TRUE_NOW = org({ adminPeople: [person('joined')] });

function held<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const failure = (status: number) =>
  Object.assign(new Error('failed'), { isAxiosError: true, response: { status, data: {} } });

/** Each read of the organizations list, in the order asked, answered by the test. */
let reads: Array<ReturnType<typeof held<{ data: { organizations: Organization[] } }>>> = [];
const answers = (at: number, ...organizations: Organization[]) =>
  reads[at]!.resolve({ data: { organizations } });

beforeEach(() => {
  setActivePinia(createPinia());
  for (const call of Object.values(api)) call.mockReset();
  document.body.innerHTML = '';
  reads = [];
  api.get.mockImplementation((url: string) => {
    if (url !== '/organizations') {
      return Promise.resolve({ data: { entries: [], next: null, invitations: [] } });
    }
    const read = held<{ data: { organizations: Organization[] } }>();
    reads.push(read);
    return read.promise;
  });
});

function open(on: Organization = COPY) {
  return mount(ManageOrgOverlay, {
    props: { manageOpen: true, org: on },
    attachTo: document.body,
  });
}

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const emails = (id: string) =>
  [...document.body.querySelectorAll(`[data-testid="${id}"]`)].map((cell) => cell.textContent);
const admins = () => emails('manage-org-admin-email');
const members = () => emails('manage-org-member-email');
const shownName = () => document.body.querySelector('.org-name')?.textContent;
const renameField = () => byTestId('manage-org-rename-input') as HTMLInputElement;
const renameSave = () => byTestId('manage-org-rename-save-button') as HTMLButtonElement;

async function rename(name: string) {
  renameField().value = name;
  renameField().dispatchEvent(new Event('input'));
  await flushPromises();
  renameField().form!.requestSubmit();
  await flushPromises();
}

describe('Manage organization reads the organization as it opens', () => {
  it('lists nobody of the copy while it reads, then the people as they are', async () => {
    open();
    await flushPromises();

    expect(reads).toHaveLength(1);
    expect(byTestId('manage-org-admin-list-loading')!.textContent?.trim()).toBe('Loading admins…');
    expect(byTestId('manage-org-member-list-loading')!.textContent?.trim()).toBe(
      'Loading members…',
    );
    expect(admins()).toEqual([]);
    expect(members()).toEqual([]);
    expect(byTestId('manage-org-admin-list-empty')).toBeNull();
    // The copy names it, and Invite admin is there to open on.
    expect(shownName()).toBe('Seed Test Org');
    expect(byTestId('manage-org-add-admin-button')).not.toBeNull();

    answers(0, TRUE_NOW);
    await flushPromises();

    expect(admins()).toEqual(['joined@example.com']);
    expect(members()).toEqual([]);
    expect(byTestId('manage-org-member-list-empty')).not.toBeNull();
  });

  it('reads it again at each opening', async () => {
    const wrapper = open();
    answers(0, COPY);
    await flushPromises();
    await wrapper.setProps({ manageOpen: false, org: null });
    await wrapper.setProps({ manageOpen: true, org: COPY });
    await flushPromises();

    expect(reads).toHaveLength(2);
    expect(members()).toEqual([]);
    answers(1, TRUE_NOW);
    await flushPromises();

    expect(admins()).toEqual(['joined@example.com']);
  });

  it('takes the name the read brings, in its field too, with nothing to save', async () => {
    open();
    answers(0, { ...COPY, name: 'Renamed Elsewhere' });
    await flushPromises();

    expect(shownName()).toBe('Renamed Elsewhere');
    expect(renameField().value).toBe('Renamed Elsewhere');
    expect(renameSave().disabled).toBe(true);
  });

  it('leaves a name being typed alone when the read brings the same name', async () => {
    open();
    await flushPromises();
    renameField().value = 'Half typ';
    renameField().dispatchEvent(new Event('input'));
    answers(0, TRUE_NOW);
    await flushPromises();

    expect(renameField().value).toBe('Half typ');
  });

  it("shows the list's copy and says so when the read fails", async () => {
    open();
    reads[0]!.reject(failure(502));
    await flushPromises();

    expect(byTestId('manage-org-error')!.textContent?.trim()).not.toBe('');
    expect(members()).toEqual(['left@example.com']);
    expect(byTestId('manage-org-member-list-loading')).toBeNull();
  });

  it('keeps the copy listed while a write after a failed read reads again', async () => {
    api.delete.mockResolvedValue({ data: {} });
    open();
    reads[0]!.reject(failure(502));
    await flushPromises();
    byTestId('manage-org-remove-member-button')!.click();
    await flushPromises();
    byTestId('manage-org-remove-submit-button')!.click();
    await flushPromises();

    expect(reads).toHaveLength(2);
    expect(members()).toEqual(['left@example.com']);
    answers(1, org());
    await flushPromises();

    expect(members()).toEqual([]);
    expect(byTestId('manage-org-error')).toBeNull();
  });

  it('shows nothing of an organization the list no longer holds, and says so', async () => {
    open();
    answers(0, org({ id: 'org-2', name: 'Another Org' }));
    await flushPromises();

    expect(byTestId('manage-org-error')!.textContent?.trim()).toBe(
      'You are no longer in this organization, or it has been deleted.',
    );
    expect(members()).toEqual([]);
    expect(byTestId('manage-org-add-member-button')).toBeNull();
    expect(shownName()).toBeUndefined();
  });

  it('drops a read for an opening that has closed', async () => {
    const wrapper = open();
    await wrapper.setProps({ manageOpen: false, org: null });
    await wrapper.setProps({ manageOpen: true, org: COPY });
    await flushPromises();
    answers(1, COPY);
    answers(0, TRUE_NOW);
    await flushPromises();

    expect(members()).toEqual(['left@example.com']);
    expect(admins()).toEqual([]);
  });

  it.each([
    ['is still out', async () => {}],
    [
      'has failed',
      async () => {
        reads[0]!.reject(failure(502));
        await flushPromises();
      },
    ],
  ])('keeps a new name saved while the first read %s', async (_, before) => {
    api.put.mockResolvedValue({ data: {} });
    open();
    await flushPromises();
    await before();
    await rename('Autumn Makers');

    expect(reads).toHaveLength(2);
    // A read still out from before the rename answers last, with the old name: it is dropped.
    answers(1, { ...TRUE_NOW, name: 'Autumn Makers' });
    await flushPromises();
    reads[0]!.resolve({ data: { organizations: [COPY] } });
    await flushPromises();

    expect(shownName()).toBe('Autumn Makers');
    expect(renameField().value).toBe('Autumn Makers');
    expect(admins()).toEqual(['joined@example.com']);
  });

  it('shows a name saved before any read has answered at once', async () => {
    api.put.mockResolvedValue({ data: {} });
    open();
    await flushPromises();
    await rename('Autumn Makers');

    expect(shownName()).toBe('Autumn Makers');
    expect(renameSave().disabled).toBe(true);
  });
});
