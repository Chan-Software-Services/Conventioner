/**
 * Manage organization adds an admin or a member by inviting them (T538, ADR 0047): "Invite admin"
 * and "Invite member" send an invitation and answer alike for every address, "Invited" lists what
 * waits with a Withdraw that asks first, and nobody is under Admins or Members until they accept.
 * Its owner reads and withdraws every invitation; an admin reads every one and withdraws the member
 * ones; a member sees no "Invited" and makes no read of it.
 *
 * Each write is held while it is out and kept to its opening, as Manage organization's other writes
 * are: two presses send once, and an answer that lands after the dialog was opened on another
 * organization writes nothing into it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { AxiosError } from 'axios';
import { createPinia, setActivePinia } from 'pinia';

import ManageOrgOverlay from '@/views/ManageOrgOverlay.vue';
import type { Organization, SentInvitation } from '@/assets/types/datatypes';
import { tryEveryClose } from './support/dialogCloses';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

function org(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org-1',
    name: 'Ember Makers',
    ownerEmail: 'owner@example.com',
    adminPeople: [{ userId: 'u-admin', email: 'admin@example.com' }],
    memberPeople: [{ userId: 'u-member', email: 'member@example.com' }],
    userRole: 'owner',
    marketCount: 2,
    marketsWithOwnRole: {},
    ...overrides,
  };
}

const OTHER = org({ id: 'org-2', name: 'Lakeside Collective' });

/** Ends in the reader's zone at 16:44 on 8 December, whatever zone the test runs in. */
const ENDS_AT = new Date(2026, 11, 8, 16, 44).toISOString();

function invitation(overrides: Partial<SentInvitation> = {}): SentInvitation {
  return {
    id: 'inv-1',
    email: 'newcomer@example.test',
    role: 'member',
    invitedBy: 'owner@example.com',
    sentAt: new Date(2026, 10, 24, 16, 44).toISOString(),
    endsAt: ENDS_AT,
    ...overrides,
  };
}

function held<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function refusing(status: number, error: string) {
  return Object.assign(new AxiosError('refused'), { response: { status, data: { error } } });
}

let served: Organization;
/** What the invitations read answers: the list, or a function that answers or throws. */
let invited: SentInvitation[] | (() => Promise<{ data: { invitations: SentInvitation[] } }>);

const invitationReads = (id = 'org-1') =>
  api.get.mock.calls.filter(([url]) => url === `/organizations/${id}/invitations`).length;

beforeEach(() => {
  setActivePinia(createPinia());
  api.get.mockReset();
  api.post.mockReset();
  api.put.mockReset();
  api.delete.mockReset();
  document.body.innerHTML = '';
  served = org();
  invited = [];
  api.get.mockImplementation(async (url: string) => {
    if (url === '/organizations') return { data: { organizations: [served, OTHER] } };
    if (url === '/organizations/org-1/invitations') {
      return typeof invited === 'function' ? invited() : { data: { invitations: invited } };
    }
    if (url === '/organizations/org-2/invitations') return { data: { invitations: [] } };
    return { data: { entries: [], next: null } };
  });
});

enableAutoUnmount(afterEach);

async function open(on: Organization = served) {
  const wrapper = mount(ManageOrgOverlay, {
    props: { manageOpen: true, org: on },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const text = (id: string) => byTestId(id)?.textContent?.replace(/\s+/g, ' ').trim();
const invitedRows = () => allByTestId('manage-org-invited-row');
const shown = (id: string) => allByTestId(id).map((cell) => cell.textContent?.trim());

type Row = 'admin' | 'member';
const field = (row: Row) => byTestId(`manage-org-add-${row}-input`) as HTMLInputElement;

async function openTheRow(row: Row) {
  byTestId(`manage-org-add-${row}-button`)!.click();
  await flushPromises();
}

async function type(row: Row, address: string) {
  field(row).value = address;
  field(row).dispatchEvent(new Event('input'));
  await flushPromises();
}

function send(row: Row) {
  field(row).form!.requestSubmit();
}

/** The invite answers with the invitation made, and the invitations read the list as it then stands. */
function invites(emailed = true) {
  api.post.mockImplementation(async (_url: string, body: { email: string; place: string }) => {
    const made = invitation({
      id: `inv-${body.email}`,
      email: body.email.trim().toLowerCase(),
      role: body.place,
    });
    invited = [made, ...(invited as SentInvitation[])];
    return { data: { invitation: made, emailed } };
  });
}

describe.each([
  { row: 'admin' as const, opener: 'Invite admin', label: 'Email of the admin to invite' },
  { row: 'member' as const, opener: 'Invite member', label: 'Email of the member to invite' },
])('$opener', ({ row, opener, label }) => {
  it('names the row for inviting, with the hint beneath it', async () => {
    await open();
    expect(text(`manage-org-add-${row}-button`)).toBe(opener);
    await openTheRow(row);

    expect(field(row).placeholder).toBe('Email address');
    expect(field(row).getAttribute('aria-label')).toBe(label);
    expect(text(`manage-org-add-${row}-submit`)).toBe('Send invitation');
    expect(text(`manage-org-add-${row}-cancel`)).toBe('Cancel');
    expect(text(`manage-org-add-${row}-hint`)).toBe(
      'They get an email, and join once they accept it signed in with this address.',
    );
  });

  it('sends the invitation, says so, empties the field and keeps the row open', async () => {
    invites();
    await open();
    await openTheRow(row);
    await type(row, ' Newcomer@Example.test ');

    send(row);
    await flushPromises();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/organizations/org-1/invitations', {
      email: 'Newcomer@Example.test',
      place: row,
    });
    expect(text(`manage-org-add-${row}-sent`)).toBe('Invitation sent to newcomer@example.test.');
    expect(byTestId(`manage-org-add-${row}-said`)!.getAttribute('aria-live')).toBe('polite');
    expect(field(row).value).toBe('');
    expect(byTestId(`manage-org-add-${row}-error`)).toBeNull();
  });

  it('lists the invitation under Invited, and nobody new under Admins or Members', async () => {
    invites();
    await open();
    expect(byTestId('manage-org-invited')).toBeNull();
    await openTheRow(row);
    await type(row, 'newcomer@example.test');

    send(row);
    await flushPromises();

    expect(invitedRows()).toHaveLength(1);
    expect(invitedRows()[0]!.textContent).toContain('newcomer@example.test');
    expect(invitedRows()[0]!.textContent).toContain(`Invited as ${row}, until 8 December, 16:44`);
    expect(shown('manage-org-admin-email')).toEqual(['admin@example.com']);
    expect(shown('manage-org-member-email')).toEqual(['member@example.com']);
  });

  it('says the email could not be sent in the sent line’s place', async () => {
    invites(false);
    await open();
    await openTheRow(row);
    await type(row, 'newcomer@example.test');

    send(row);
    await flushPromises();

    expect(byTestId(`manage-org-add-${row}-sent`)).toBeNull();
    expect(text(`manage-org-add-${row}-not-emailed`)).toBe(
      'newcomer@example.test is invited, but the email could not be sent. Invite them again to send it.',
    );
  });

  it('says the limit’s sentence when too many were sent, the address kept', async () => {
    const sentence = 'You have sent many invitations. Try again in 12 minutes.';
    api.post.mockRejectedValue(refusing(429, sentence));
    await open();
    await openTheRow(row);
    await type(row, 'newcomer@example.test');
    const reads = invitationReads();

    send(row);
    await flushPromises();

    expect(text(`manage-org-add-${row}-error`)).toBe(sentence);
    expect(byTestId(`manage-org-add-${row}-sent`)).toBeNull();
    expect(field(row).value).toBe('newcomer@example.test');
    expect(invitationReads()).toBe(reads);
  });

  it('takes the last sent line away when the next is sent, and when the row closes', async () => {
    invites();
    await open();
    await openTheRow(row);
    await type(row, 'first@example.test');
    send(row);
    await flushPromises();
    const sentence = 'You have sent many invitations. Try again in 12 minutes.';
    api.post.mockRejectedValue(refusing(429, sentence));
    await type(row, 'second@example.test');

    send(row);
    await flushPromises();
    expect(byTestId(`manage-org-add-${row}-sent`)).toBeNull();
    expect(text(`manage-org-add-${row}-error`)).toBe(sentence);

    invites();
    await type(row, 'third@example.test');
    send(row);
    await flushPromises();
    byTestId(`manage-org-add-${row}-cancel`)!.click();
    await flushPromises();
    await openTheRow(row);
    expect(byTestId(`manage-org-add-${row}-sent`)).toBeNull();
  });

  it('sends once for two presses, and holds Manage organization until the list shows it', async () => {
    const answer = held();
    api.post.mockReturnValue(answer.promise);
    const wrapper = await open();
    await openTheRow(row);
    await type(row, 'newcomer@example.test');

    send(row);
    send(row);
    await flushPromises();
    // Manage organization has no Cancel of its own: its close control, its scrim and Escape.
    byTestId('manage-org-close-button')!.click();
    byTestId('manage-org-background')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('manageClose')).toBeUndefined();
    expect(byTestId('manage-org-close-button')!.hasAttribute('disabled')).toBe(true);

    invited = [invitation({ role: row })];
    answer.resolve({ data: { invitation: invitation({ role: row }), emailed: true } });
    await flushPromises();
    expect(invitedRows()).toHaveLength(1);
    expect(byTestId('manage-org-close-button')!.hasAttribute('disabled')).toBe(false);
    // Nothing about the organization changed, so the list behind is not told of anything.
    expect(wrapper.emitted('changed')).toBeUndefined();
  });

  it('keeps an invitation’s answer and its re-read out of Manage organization opened on another', async () => {
    const answer = held();
    api.post.mockReturnValue(answer.promise);
    const wrapper = await open();
    await openTheRow(row);
    await type(row, 'newcomer@example.test');
    send(row);
    await flushPromises();

    await wrapper.setProps({ org: OTHER });
    await flushPromises();
    await openTheRow(row);
    await type(row, 'typed-here@example.test');
    const reads = invitationReads();
    invited = [invitation({ role: row })];
    answer.resolve({ data: { invitation: invitation({ role: row }), emailed: true } });
    await flushPromises();

    expect(invitationReads()).toBe(reads);
    expect(invitedRows()).toHaveLength(0);
    expect(byTestId(`manage-org-add-${row}-sent`)).toBeNull();
    expect(field(row).value).toBe('typed-here@example.test');
    expect(document.querySelector('.org-name')!.textContent).toBe('Lakeside Collective');
  });
});

describe('Invite admin, refused', () => {
  it('points a member invited as an admin at their row, in the server’s words', async () => {
    const sentence =
      'member@example.com is already a member of this organization. Make them an admin from their row.';
    api.post.mockRejectedValue(refusing(400, sentence));
    await open();
    await openTheRow('admin');
    await type('admin', 'member@example.com');

    send('admin');
    await flushPromises();

    expect(text('manage-org-add-admin-error')).toBe(sentence);
    expect(field('admin').value).toBe('member@example.com');
    expect(shown('manage-org-member-email')).toEqual(['member@example.com']);
  });
});

describe('Invited', () => {
  it('lists each invitation with its place and when it ends, newest first', async () => {
    invited = [
      invitation({ id: 'inv-2', email: 'second@example.test', role: 'admin' }),
      invitation({ id: 'inv-1', email: 'first@example.test', role: 'member' }),
    ];
    await open();

    expect(text('manage-org-invited-heading')).toBe('Invited');
    const part = (row: HTMLElement, selector: string) =>
      row.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
    expect(
      invitedRows().map((row) => [
        part(row, '.user-email'),
        part(row, '[data-testid="manage-org-invited-as"]'),
        part(row, '[data-testid="manage-org-invited-withdraw"] .visually-hidden'),
      ]),
    ).toEqual([
      ['second@example.test', 'Invited as admin, until 8 December, 16:44', 'second@example.test'],
      ['first@example.test', 'Invited as member, until 8 December, 16:44', 'first@example.test'],
    ]);
  });

  it('stands after Members and before the default permissions', async () => {
    invited = [invitation()];
    await open();

    const members = byTestId('manage-org-members')!;
    const invitedList = byTestId('manage-org-invited')!;
    const defaults = byTestId('manage-org-permissions-open')!;
    expect(
      members.compareDocumentPosition(invitedList) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      invitedList.compareDocumentPosition(defaults) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('offers its owner Withdraw on every invitation', async () => {
    invited = [
      invitation({ id: 'inv-2', email: 'admin-to-be@example.test', role: 'admin' }),
      invitation({ id: 'inv-1', email: 'member-to-be@example.test', role: 'member' }),
    ];
    await open();

    expect(
      invitedRows().map(
        (row) => !!row.querySelector('[data-testid="manage-org-invited-withdraw"]'),
      ),
    ).toEqual([true, true]);
  });

  it('shows an admin every invitation, with Withdraw only on the member ones', async () => {
    served = org({ userRole: 'admin' });
    invited = [
      invitation({ id: 'inv-2', email: 'admin-to-be@example.test', role: 'admin' }),
      invitation({ id: 'inv-1', email: 'member-to-be@example.test', role: 'member' }),
    ];
    await open();

    expect(invitationReads()).toBe(1);
    expect(
      invitedRows().map(
        (row) => !!row.querySelector('[data-testid="manage-org-invited-withdraw"]'),
      ),
    ).toEqual([false, true]);
    expect(byTestId('manage-org-add-admin-button')).toBeNull();
    expect(byTestId('manage-org-add-member-button')).not.toBeNull();
  });

  it('is neither read nor drawn for a member', async () => {
    served = org({ userRole: 'member' });
    invited = [invitation()];
    await open();

    expect(invitationReads()).toBe(0);
    expect(byTestId('manage-org-invited')).toBeNull();
    expect(byTestId('manage-org-invited-read-failed')).toBeNull();
  });

  it('draws no section while nothing waits', async () => {
    await open();

    expect(invitationReads()).toBe(1);
    expect(byTestId('manage-org-invited-heading')).toBeNull();
    expect(byTestId('manage-org-invited')).toBeNull();
  });

  it('says a failed read with Try again in the section’s place, the rest of the dialog working', async () => {
    let fails = true;
    invited = async () => {
      if (fails) throw refusing(500, '');
      return { data: { invitations: [invitation()] } };
    };
    await open();

    expect(text('manage-org-invited-read-failed')).toBe(
      'Could not read the invitations. Try again',
    );
    expect(byTestId('manage-org-error')).toBeNull();
    expect(shown('manage-org-member-email')).toEqual(['member@example.com']);
    expect(byTestId('manage-org-add-member-button')).not.toBeNull();

    fails = false;
    byTestId('manage-org-invited-retry')!.click();
    await flushPromises();

    expect(byTestId('manage-org-invited-read-failed')).toBeNull();
    expect(invitedRows()).toHaveLength(1);
  });

  it('pages 150 invitations and finds one by its address', async () => {
    invited = Array.from({ length: 150 }, (_, at) =>
      invitation({ id: `inv-${at}`, email: `person-${String(at).padStart(3, '0')}@example.test` }),
    );
    await open();

    expect(invitedRows()).toHaveLength(50);
    expect(text('manage-org-invited-list-count')).toBe('Showing 50 of 150');
    const find = byTestId('manage-org-invited-list-find') as HTMLInputElement;
    expect(document.querySelector(`label[for="${find.id}"]`)?.textContent?.trim()).toBe(
      'Find in invited',
    );
    find.value = 'PERSON-149';
    find.dispatchEvent(new Event('input'));
    await flushPromises();

    expect(invitedRows()).toHaveLength(1);
    expect(invitedRows()[0]!.textContent).toContain('person-149@example.test');
  });

  it('drops a read of the organization it was open on once it is open on another', async () => {
    const answer = held<{ data: { invitations: SentInvitation[] } }>();
    invited = () => answer.promise;
    const wrapper = await open();

    await wrapper.setProps({ org: OTHER });
    await flushPromises();
    answer.resolve({ data: { invitations: [invitation()] } });
    await flushPromises();

    expect(invitedRows()).toHaveLength(0);
    expect(document.querySelector('.org-name')!.textContent).toBe('Lakeside Collective');
  });
});

describe('Withdraw', () => {
  async function askToWithdraw(at = 0) {
    invitedRows()
      [at]!.querySelector<HTMLElement>('[data-testid="manage-org-invited-withdraw"]')!
      .click();
    await flushPromises();
  }

  function confirm() {
    byTestId('manage-org-withdraw-window')!.querySelector('form')!.requestSubmit();
  }

  it('asks first, naming the address, and opens on Cancel', async () => {
    invited = [invitation()];
    await open();

    await askToWithdraw();

    expect(api.delete).not.toHaveBeenCalled();
    expect(text('manage-org-withdraw-window')).toContain(
      'Withdraw the invitation to newcomer@example.test?',
    );
    expect(text('manage-org-withdraw-consequence')).toBe('They can no longer accept it.');
    expect(text('manage-org-withdraw-submit-button')).toBe('Withdraw');
    expect(document.activeElement).toBe(byTestId('manage-org-withdraw-cancel-button'));
  });

  it('changes nothing on Cancel, and gives focus back to that Withdraw', async () => {
    invited = [invitation()];
    await open();
    const withdraw = invitedRows()[0]!.querySelector<HTMLElement>(
      '[data-testid="manage-org-invited-withdraw"]',
    )!;
    withdraw.focus();
    withdraw.click();
    await flushPromises();

    byTestId('manage-org-withdraw-cancel-button')!.click();
    await flushPromises();

    expect(byTestId('manage-org-withdraw-window')).toBeNull();
    expect(api.delete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(withdraw);
  });

  it('withdraws it, re-reads the list with Manage organization open, and focus goes to the list', async () => {
    invited = [invitation(), invitation({ id: 'inv-0', email: 'kept@example.test' })];
    api.delete.mockImplementation(async () => {
      invited = (invited as SentInvitation[]).filter((one) => one.id !== 'inv-1');
      return { data: { message: 'Invitation withdrawn' } };
    });
    const wrapper = await open();
    await askToWithdraw();

    confirm();
    await flushPromises();

    expect(api.delete).toHaveBeenCalledWith('/organizations/org-1/invitations/inv-1');
    expect(byTestId('manage-org-withdraw-window')).toBeNull();
    expect(byTestId('manage-org-window')).not.toBeNull();
    expect(invitedRows()).toHaveLength(1);
    expect(invitedRows()[0]!.textContent).toContain('kept@example.test');
    expect(document.activeElement).toBe(byTestId('manage-org-invited'));
    expect(wrapper.emitted('changed')).toBeUndefined();
  });

  it('gives focus to Members once the last invitation is withdrawn', async () => {
    invited = [invitation()];
    api.delete.mockImplementation(async () => {
      invited = [];
      return { data: { message: 'Invitation withdrawn' } };
    });
    await open();
    await askToWithdraw();

    confirm();
    await flushPromises();

    expect(byTestId('manage-org-invited')).toBeNull();
    expect(document.activeElement).toBe(byTestId('manage-org-members'));
  });

  it('reads an invitation already ended as withdrawn', async () => {
    invited = [invitation()];
    api.delete.mockImplementation(async () => {
      invited = [];
      throw refusing(404, 'That invitation has already ended.');
    });
    await open();
    await askToWithdraw();

    confirm();
    await flushPromises();

    expect(byTestId('manage-org-withdraw-window')).toBeNull();
    expect(byTestId('manage-org-invited')).toBeNull();
    expect(document.body.textContent).not.toContain('That invitation has already ended.');
  });

  it('says an invitation sent again meanwhile under the confirmation, and re-reads the list', async () => {
    const sentence =
      'That invitation was sent again meanwhile. Read the invitations again, and withdraw it if you still mean to.';
    invited = [invitation()];
    api.delete.mockImplementation(async () => {
      invited = [invitation({ role: 'admin', endsAt: new Date(2026, 11, 9, 10, 5).toISOString() })];
      throw refusing(409, sentence);
    });
    await open();
    await askToWithdraw();
    const reads = invitationReads();

    confirm();
    await flushPromises();

    expect(text('manage-org-withdraw-error')).toBe(sentence);
    expect(invitationReads()).toBe(reads + 1);
    expect(invitedRows()[0]!.textContent).toContain('Invited as admin, until 9 December, 10:05');
  });

  it('sends once for two presses, and holds its confirmation until the list is read again', async () => {
    invited = [invitation()];
    const answer = held();
    api.delete.mockReturnValue(answer.promise);
    await open();
    await askToWithdraw();

    confirm();
    confirm();
    await flushPromises();
    await tryEveryClose('manage-org-withdraw');

    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(byTestId('manage-org-withdraw-window')).not.toBeNull();

    invited = [];
    answer.resolve({ data: { message: 'Invitation withdrawn' } });
    await flushPromises();
    expect(byTestId('manage-org-withdraw-window')).toBeNull();
  });

  it('keeps a withdrawal’s answer out of Manage organization opened on another', async () => {
    invited = [invitation()];
    const answer = held();
    api.delete.mockReturnValue(answer.promise);
    const wrapper = await open();
    await askToWithdraw();
    confirm();
    await flushPromises();

    await wrapper.setProps({ org: OTHER });
    await flushPromises();
    const reads = invitationReads();
    answer.reject(refusing(409, 'That invitation was sent again meanwhile.'));
    await flushPromises();

    expect(invitationReads()).toBe(reads);
    expect(byTestId('manage-org-withdraw-window')).toBeNull();
    expect(document.body.textContent).not.toContain('sent again meanwhile');
  });
});
