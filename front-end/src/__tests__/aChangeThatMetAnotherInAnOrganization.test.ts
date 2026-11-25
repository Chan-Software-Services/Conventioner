/**
 * A change to an organization's people that met someone else's change (T283).
 *
 * The server writes a person's place only while the places it judged still stand, and answers a
 * change that met another with one 409, `{"error": <the sentence>, "code": "organization_changed"}`,
 * having stored nothing. Manage organization shows that sentence where the control's refusal
 * shows today (in the Remove or the place change's confirmation, which stays open) and reads the
 * organization again behind it, so the rows it shows are the ones the sentence asks the person to
 * check. Any other refusal is shown as before, with no re-read. An invitation writes none of the
 * organization's people, so it never meets that 409; its refusals are said under its row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AxiosError } from 'axios';
import { createPinia, setActivePinia } from 'pinia';

import ManageOrgOverlay from '@/views/ManageOrgOverlay.vue';
import { type Organization } from '@/assets/types/datatypes';
import { isOrganizationChanged, ORGANIZATION_CHANGED_CODE } from '@/utils/api';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

const CHANGED =
  'This organization changed while you were working on it, so your change was not saved. ' +
  'Check its people as they are now, then make your change again.';

function failure(status: number, data: unknown): AxiosError {
  return Object.assign(new AxiosError('refused'), { response: { status, data } });
}

const changed = () => failure(409, { error: CHANGED, code: ORGANIZATION_CHANGED_CODE });

function org(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org-1',
    name: 'Seed Test Org',
    owner: 'u-owner',
    admins: ['u-admin'],
    members: ['u-member'],
    ownerEmail: 'owner@example.com',
    adminPeople: [{ userId: 'u-admin', email: 'admin@example.com' }],
    memberPeople: [{ userId: 'u-member', email: 'member@example.com' }],
    userRole: 'owner',
    marketCount: 2,
    marketsWithOwnRole: {},
    ...overrides,
  };
}

/** The organization as someone else's change left it: the member is now an admin. */
const AFTER_THE_OTHER_CHANGE = {
  admins: ['u-admin', 'u-member'],
  members: [],
  adminPeople: [
    { userId: 'u-admin', email: 'admin@example.com' },
    { userId: 'u-member', email: 'member@example.com' },
  ],
  memberPeople: [],
};

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) =>
  [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)].map((element) =>
    element.textContent?.trim(),
  );

describe('isOrganizationChanged', () => {
  it("reads the server's 409 for a change that met another", () => {
    expect(isOrganizationChanged(changed())).toBe(true);
  });

  it.each([
    ['another 409', failure(409, { error: 'Something else.' })],
    ["a market's 409", failure(409, { error: 'x', code: 'market_changed' })],
    ['the same code on another status', failure(400, { code: ORGANIZATION_CHANGED_CODE })],
    ['a 409 with no body', failure(409, undefined)],
    ['something that is not a request', new Error(ORGANIZATION_CHANGED_CODE)],
  ])('reads %s as something else', (_name, err) => {
    expect(isOrganizationChanged(err)).toBe(false);
  });
});

describe('Manage organization, when a change met another', () => {
  let served: Organization;

  beforeEach(() => {
    setActivePinia(createPinia());
    for (const call of Object.values(api)) call.mockReset();
    document.body.innerHTML = '';
  });

  function mountDialog(): VueWrapper {
    served = org();
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

  /** Someone else's change lands on the server as this request is refused. */
  function refusedAsChanged(call: typeof api.post) {
    call.mockImplementation(async () => {
      served = { ...served, ...AFTER_THE_OTHER_CHANGE };
      throw changed();
    });
  }

  async function invite(which: 'admin' | 'member', email: string) {
    byTestId(`manage-org-add-${which}-button`)!.click();
    await flushPromises();
    const input = byTestId(`manage-org-add-${which}-input`) as HTMLInputElement;
    input.value = email;
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    api.get.mockClear();
    byTestId(`manage-org-add-${which}-submit`)!.click();
    await flushPromises();
  }

  it('Remove keeps its confirmation open with the sentence, the people read again behind it', async () => {
    refusedAsChanged(api.delete);
    const wrapper = mountDialog();
    await flushPromises();

    byTestId('manage-org-remove-member-button')!.click();
    await flushPromises();
    api.get.mockClear();
    byTestId('manage-org-remove-submit-button')!.click();
    await flushPromises();

    expect(byTestId('manage-org-remove-window')).not.toBeNull();
    expect(byTestId('manage-org-remove-error')?.textContent?.trim()).toBe(CHANGED);
    expect(api.get).toHaveBeenCalledWith('/organizations');
    expect(allByTestId('manage-org-admin-email')).toEqual([
      'admin@example.com',
      'member@example.com',
    ]);
    // Refused, it may be asked again.
    expect(byTestId('manage-org-remove-submit-button')!.hasAttribute('disabled')).toBe(false);
    expect(wrapper.emitted('changed')).toHaveLength(1);
    wrapper.unmount();
  });

  it('a re-read that fails after the refusal never says the change was saved', async () => {
    api.put.mockRejectedValue(changed());
    const wrapper = mountDialog();
    await flushPromises();

    api.get.mockImplementation(async (url: string) => {
      if (url === '/organizations') throw failure(404, undefined);
      return { data: { entries: [], next: null } };
    });
    byTestId('manage-org-make-member-button')!.click();
    await flushPromises();
    byTestId('manage-org-place-change-submit-button')!.click();
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/organizations');
    expect(byTestId('manage-org-place-change-error')?.textContent?.trim()).toBe(CHANGED);
    expect(byTestId('manage-org-error')?.textContent?.trim()).toBe(
      'Could not re-read the organization',
    );
    expect(document.body.textContent).not.toContain('Saved');
    wrapper.unmount();
  });

  it('any other refusal is shown as before, with no re-read', async () => {
    api.post.mockRejectedValue(
      failure(400, { error: 'admin@example.com is already an admin of this organization.' }),
    );
    const wrapper = mountDialog();
    await flushPromises();

    await invite('admin', 'admin@example.com');

    expect(api.post).toHaveBeenCalledWith('/organizations/org-1/invitations', {
      email: 'admin@example.com',
      place: 'admin',
    });
    expect(byTestId('manage-org-add-admin-error')?.textContent?.trim()).toBe(
      'admin@example.com is already an admin of this organization.',
    );
    expect(api.get).not.toHaveBeenCalledWith('/organizations');
    expect(wrapper.emitted('changed')).toBeUndefined();
    wrapper.unmount();
  });
});
