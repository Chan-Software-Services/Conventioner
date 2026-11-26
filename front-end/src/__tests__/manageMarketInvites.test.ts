/**
 * Manage market adds a person by inviting them (T538, ADR 0047): "Invite someone" sends an
 * invitation and answers alike for every address, "Invited" lists what waits with a Withdraw that
 * asks first, and nobody is under "Users with access", in the transfer's choices or in a count until
 * they accept.
 *
 * Each write is held while it is out and kept to its opening, as Manage market's other writes are:
 * two presses send once, and an answer that lands after the dialog was opened on another market
 * writes nothing into it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { AxiosError } from 'axios';
import { createPinia, setActivePinia } from 'pinia';

import ManageMarketOverlay from '@/views/ManageMarketOverlay.vue';
import {
  MarketPhase,
  MarketRole,
  type Market,
  type PersonWithAccess,
  type SentInvitation,
} from '@/assets/types/datatypes';
import { MarketAction } from '@/utils/marketActions';
import { answersRefusing, EDITOR_ANSWERS, VIEWER_ANSWERS } from './support/servedAnswers';
import { tryEveryClose } from './support/dialogCloses';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

const OWNER: PersonWithAccess = {
  userId: 'u-owner',
  email: 'owner@example.com',
  role: MarketRole.Owner,
  marketRole: MarketRole.Owner,
  organizationRole: null,
  fromOrganization: false,
};
const EDITOR: PersonWithAccess = {
  userId: 'u-editor',
  email: 'editor@example.com',
  role: MarketRole.Editor,
  marketRole: MarketRole.Editor,
  organizationRole: null,
  fromOrganization: false,
};

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: 'market-1',
    name: 'Riverside',
    phase: MarketPhase.Applications,
    organizationId: 'org-1',
    organizationName: 'Seed Test Org',
    roles: {},
    inOrganization: true,
    actionRefusals: answersRefusing(),
    permissionTable: [],
    peopleWithAccess: [OWNER, EDITOR],
    ...overrides,
  } as unknown as Market;
}

const OTHER = market({ id: 'market-2', name: 'Lakeside' });

/** Ends in the reader's zone at 16:44 on 8 December, whatever zone the test runs in. */
const ENDS_AT = new Date(2026, 11, 8, 16, 44).toISOString();

function invitation(overrides: Partial<SentInvitation> = {}): SentInvitation {
  return {
    id: 'inv-1',
    email: 'newcomer@example.test',
    role: 'editor',
    invitedBy: OWNER.email,
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

let served: Market;
/** What the invitations read answers: the list, or a function that answers or throws. */
let invited: SentInvitation[] | (() => Promise<{ data: { invitations: SentInvitation[] } }>);

const invitationReads = (id = 'market-1') =>
  api.get.mock.calls.filter(([url]) => url === `/markets/${id}/invitations`).length;

beforeEach(() => {
  setActivePinia(createPinia());
  api.get.mockReset();
  api.post.mockReset();
  api.put.mockReset();
  api.delete.mockReset();
  document.body.innerHTML = '';
  served = market();
  invited = [];
  api.get.mockImplementation(async (url: string) => {
    if (url === '/markets/market-1') return { data: { market: served } };
    if (url === '/markets/market-2') return { data: { market: OTHER } };
    if (url === '/markets/market-1/invitations') {
      return typeof invited === 'function' ? invited() : { data: { invitations: invited } };
    }
    if (url === '/markets/market-2/invitations') return { data: { invitations: [] } };
    return { data: { entries: [], next: null, vendorNames: {}, actors: [], groups: [] } };
  });
});

enableAutoUnmount(afterEach);

async function open(on: Market = served) {
  const wrapper = mount(ManageMarketOverlay, {
    props: { manageOpen: true, market: on },
    attachTo: document.body,
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  await flushPromises();
  return wrapper;
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const text = (id: string) => byTestId(id)?.textContent?.replace(/\s+/g, ' ').trim();
const field = () => byTestId('manage-market-add-user-input') as HTMLInputElement;
const roleSelect = () => byTestId('manage-market-add-user-select') as HTMLSelectElement;
const invitedRows = () => allByTestId('manage-market-invited-row');
const peopleShown = () =>
  allByTestId('manage-market-person').map((row) =>
    row.querySelector('.user-email')?.textContent?.trim(),
  );

async function openTheRow() {
  byTestId('manage-market-add-user-button')!.click();
  await flushPromises();
}

async function type(address: string, role?: MarketRole) {
  field().value = address;
  field().dispatchEvent(new Event('input'));
  if (role) {
    roleSelect().value = role;
    roleSelect().dispatchEvent(new Event('change'));
  }
  await flushPromises();
}

function send() {
  field().form!.requestSubmit();
}

/** The invite answers `answer`, and the invitations read the list as it then stands. */
function invites(answer: (email: string, role: string) => SentInvitation, emailed = true) {
  api.post.mockImplementation(async (_url: string, body: { email: string; role: string }) => {
    const made = answer(body.email.trim().toLowerCase(), body.role);
    invited = [made, ...(invited as SentInvitation[])];
    return { data: { invitation: made, emailed } };
  });
}

describe('Invite someone', () => {
  it('names the row for inviting, with the hint beneath it', async () => {
    await open();
    expect(text('manage-market-add-user-button')).toBe('Invite someone');
    await openTheRow();

    expect(field().placeholder).toBe('Email address');
    expect(field().getAttribute('aria-label')).toBe('Email of the person to invite');
    expect(text('manage-market-add-user-submit')).toBe('Send invitation');
    expect(text('manage-market-add-user-cancel')).toBe('Cancel');
    expect(text('manage-market-add-user-hint')).toBe(
      'They get an email, and join once they accept it signed in with this address.',
    );
  });

  it('sends the invitation, says so, empties the field and keeps the row open', async () => {
    invites((email, role) => invitation({ email, role }));
    await open();
    await openTheRow();
    await type(' Newcomer@Example.test ', MarketRole.Viewer);

    send();
    await flushPromises();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/markets/market-1/invitations', {
      email: 'Newcomer@Example.test',
      role: MarketRole.Viewer,
    });
    expect(text('manage-market-add-user-sent')).toBe('Invitation sent to newcomer@example.test.');
    expect(byTestId('manage-market-add-user-said')!.getAttribute('aria-live')).toBe('polite');
    expect(field().value).toBe('');
    expect(roleSelect().value).toBe(MarketRole.Editor);
    expect(byTestId('manage-market-add-user-error')).toBeNull();
  });

  it('lists the invitation under Invited, and nobody new under Users with access', async () => {
    invites((email, role) => invitation({ email, role }));
    await open();
    expect(byTestId('manage-market-invited')).toBeNull();
    await openTheRow();
    await type('newcomer@example.test');

    send();
    await flushPromises();

    expect(invitedRows()).toHaveLength(1);
    expect(invitedRows()[0]!.textContent).toContain('newcomer@example.test');
    expect(peopleShown()).toEqual([OWNER.email, EDITOR.email]);
  });

  it('says the email could not be sent in the sent line’s place', async () => {
    invites((email, role) => invitation({ email, role }), false);
    await open();
    await openTheRow();
    await type('newcomer@example.test');

    send();
    await flushPromises();

    expect(byTestId('manage-market-add-user-sent')).toBeNull();
    expect(text('manage-market-add-user-not-emailed')).toBe(
      'newcomer@example.test is invited, but the email could not be sent. Invite them again to send it.',
    );
    // A warning, in its own ink, never the sent line's success (`aRefusalReadsRed.test.ts`).
    expect([...byTestId('manage-market-add-user-not-emailed')!.classList]).toEqual([
      'invite-not-emailed',
    ]);
  });

  it('says a refusal in the server’s words under the row, the address kept', async () => {
    const sentence =
      'editor@example.com already has a role on this market. Change it in their row under Users with access.';
    api.post.mockRejectedValue(refusing(400, sentence));
    await open();
    await openTheRow();
    await type('editor@example.com');
    const reads = invitationReads();

    send();
    await flushPromises();

    expect(text('manage-market-add-user-error')).toBe(sentence);
    expect(byTestId('manage-market-add-user-sent')).toBeNull();
    expect(field().value).toBe('editor@example.com');
    expect(invitationReads()).toBe(reads);
  });

  it('says the limit’s sentence when too many were sent', async () => {
    const sentence = 'You have sent many invitations. Try again in 12 minutes.';
    api.post.mockRejectedValue(refusing(429, sentence));
    await open();
    await openTheRow();
    await type('newcomer@example.test');

    send();
    await flushPromises();

    expect(text('manage-market-add-user-error')).toBe(sentence);
  });

  it('takes the last sent line away when the next is sent', async () => {
    invites((email, role) => invitation({ email, role }));
    await open();
    await openTheRow();
    await type('first@example.test');
    send();
    await flushPromises();
    const sentence = 'You have sent many invitations. Try again in 12 minutes.';
    api.post.mockRejectedValue(refusing(429, sentence));
    await type('second@example.test');

    send();
    await flushPromises();

    expect(byTestId('manage-market-add-user-sent')).toBeNull();
    expect(text('manage-market-add-user-error')).toBe(sentence);
  });

  it('sends once for two presses, and holds Manage market until the list shows it', async () => {
    const answer = held();
    api.post.mockReturnValue(answer.promise);
    const wrapper = await open();
    await openTheRow();
    await type('newcomer@example.test');

    send();
    send();
    await flushPromises();
    byTestId('manage-market-close-button')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('manageClose')).toBeUndefined();
    expect(byTestId('manage-market-close-button')!.hasAttribute('disabled')).toBe(true);

    invited = [invitation()];
    answer.resolve({ data: { invitation: invitation(), emailed: true } });
    await flushPromises();
    expect(invitedRows()).toHaveLength(1);
    expect(byTestId('manage-market-close-button')!.hasAttribute('disabled')).toBe(false);
  });

  it.each([
    ['another market', OTHER],
    ['the same market', market()],
  ])('starts the row empty at Editor when Manage market is opened on %s', async (_, next) => {
    const wrapper = await open();
    await openTheRow();
    await type('someone.new@example.com', MarketRole.Viewer);

    await wrapper.setProps({ manageOpen: false, market: null });
    await wrapper.setProps({ manageOpen: true, market: next });
    await flushPromises();
    expect(byTestId('manage-market-add-user-input')).toBeNull();
    await openTheRow();

    expect(field().value).toBe('');
    expect(roleSelect().value).toBe(MarketRole.Editor);
  });

  it('starts the row empty at Editor after Cancel', async () => {
    await open();
    await openTheRow();
    await type('someone.new@example.com', MarketRole.Viewer);

    byTestId('manage-market-add-user-cancel')!.click();
    await flushPromises();
    await openTheRow();

    expect(field().value).toBe('');
    expect(roleSelect().value).toBe(MarketRole.Editor);
  });
});

describe('Invited', () => {
  it('lists each invitation with its role and when it ends, newest first', async () => {
    invited = [
      invitation({ id: 'inv-2', email: 'second@example.test', role: 'admin' }),
      invitation({ id: 'inv-1', email: 'first@example.test', role: 'viewer' }),
    ];
    await open();

    expect(text('manage-market-invited-heading')).toBe('Invited');
    const part = (row: HTMLElement, selector: string) =>
      row.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
    expect(
      invitedRows().map((row) => [
        part(row, '.invited-email'),
        part(row, '[data-testid="manage-market-invited-as"]'),
        part(row, '[data-testid="manage-market-invited-withdraw"] .visually-hidden'),
      ]),
    ).toEqual([
      ['second@example.test', 'Invited as Admin, until 8 December, 16:44', 'second@example.test'],
      ['first@example.test', 'Invited as Viewer, until 8 December, 16:44', 'first@example.test'],
    ]);
  });

  it('stands after Users with access and before the invite row', async () => {
    invited = [invitation()];
    await open();

    const section = byTestId('manage-market-people')!.closest('section')!;
    const parts = [
      byTestId('manage-market-people')!,
      byTestId('manage-market-invited')!,
      byTestId('manage-market-add-user-button')!,
    ];
    expect(parts.every((part) => section.contains(part))).toBe(true);
    expect(
      parts[0]!.compareDocumentPosition(parts[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      parts[1]!.compareDocumentPosition(parts[2]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('offers Withdraw only on the invitations whose role the reader may give', async () => {
    served = market({
      actionRefusals: answersRefusing(
        MarketAction.ManageAdmins,
        MarketAction.HandOnMarket,
        MarketAction.DeleteMarket,
      ),
    });
    invited = [
      invitation({ id: 'inv-2', email: 'admin-to-be@example.test', role: 'admin' }),
      invitation({ id: 'inv-1', email: 'editor-to-be@example.test', role: 'editor' }),
    ];
    await open();

    expect(
      invitedRows().map(
        (row) => !!row.querySelector('[data-testid="manage-market-invited-withdraw"]'),
      ),
    ).toEqual([false, true]);
  });

  it('is neither read nor drawn for a reader who may give no role', async () => {
    served = market({ actionRefusals: VIEWER_ANSWERS });
    invited = [invitation()];
    await open();

    expect(invitationReads()).toBe(0);
    expect(byTestId('manage-market-invited')).toBeNull();
  });

  it('is read for an Editor the table lets give Editor and Viewer roles', async () => {
    served = market({
      actionRefusals: { ...EDITOR_ANSWERS, [MarketAction.ManageEditorsAndViewers]: null },
    });
    invited = [invitation()];
    await open();

    expect(invitationReads()).toBe(1);
    expect(invitedRows()).toHaveLength(1);
  });

  it('says a failed read with Try again in the section’s place, the rest of the dialog working', async () => {
    let fails = true;
    invited = async () => {
      if (fails) throw refusing(500, '');
      return { data: { invitations: [invitation()] } };
    };
    await open();

    expect(text('manage-market-invited-read-failed')).toBe(
      'Could not read the invitations. Try again',
    );
    expect(byTestId('manage-market-error')).toBeNull();
    expect(peopleShown()).toEqual([OWNER.email, EDITOR.email]);
    expect(byTestId('manage-market-add-user-button')).not.toBeNull();

    fails = false;
    byTestId('manage-market-invited-retry')!.click();
    await flushPromises();

    expect(byTestId('manage-market-invited-read-failed')).toBeNull();
    expect(invitedRows()).toHaveLength(1);
  });

  it('pages 150 invitations and finds one by its address', async () => {
    invited = Array.from({ length: 150 }, (_, at) =>
      invitation({ id: `inv-${at}`, email: `person-${String(at).padStart(3, '0')}@example.test` }),
    );
    await open();

    expect(invitedRows()).toHaveLength(50);
    expect(text('manage-market-invited-list-count')).toBe('Showing 50 of 150');
    const find = byTestId('manage-market-invited-list-find') as HTMLInputElement;
    expect(document.querySelector(`label[for="${find.id}"]`)?.textContent?.trim()).toBe(
      'Find in invited',
    );
    find.value = 'PERSON-149';
    find.dispatchEvent(new Event('input'));
    await flushPromises();

    expect(invitedRows()).toHaveLength(1);
    expect(invitedRows()[0]!.textContent).toContain('person-149@example.test');
  });

  it('holds no invited person in the transfer’s choices or the people count', async () => {
    invited = [invitation()];
    await open();

    byTestId('manage-market-hand-on-button')!.click();
    await flushPromises();
    (byTestId('hand-on-market-picker-input') as HTMLInputElement).click();
    await flushPromises();

    const choices = allByTestId('hand-on-market-picker-option').map((o) => o.dataset.value);
    expect(choices).toContain(EDITOR.email);
    expect(choices).not.toContain('newcomer@example.test');
    expect(allByTestId('manage-market-person')).toHaveLength(2);
  });
});

describe('Withdraw', () => {
  async function askToWithdraw(at = 0) {
    invitedRows()
      [at]!.querySelector<HTMLElement>('[data-testid="manage-market-invited-withdraw"]')!
      .click();
    await flushPromises();
  }

  function confirm() {
    byTestId('manage-market-withdraw-window')!.querySelector('form')!.requestSubmit();
  }

  it('asks first, naming the address, and opens on Cancel', async () => {
    invited = [invitation()];
    await open();

    await askToWithdraw();

    expect(api.delete).not.toHaveBeenCalled();
    expect(text('manage-market-withdraw-window')).toContain(
      'Withdraw the invitation to newcomer@example.test?',
    );
    expect(text('manage-market-withdraw-consequence')).toBe('They can no longer accept it.');
    expect(text('manage-market-withdraw-submit-button')).toBe('Withdraw');
    expect(document.activeElement).toBe(byTestId('manage-market-withdraw-cancel-button'));
  });

  it('changes nothing on Cancel, and gives focus back to that Withdraw', async () => {
    invited = [invitation()];
    await open();
    const withdraw = invitedRows()[0]!.querySelector<HTMLElement>(
      '[data-testid="manage-market-invited-withdraw"]',
    )!;
    withdraw.focus();
    withdraw.click();
    await flushPromises();

    byTestId('manage-market-withdraw-cancel-button')!.click();
    await flushPromises();

    expect(byTestId('manage-market-withdraw-window')).toBeNull();
    expect(api.delete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(withdraw);
  });

  it('withdraws it, and re-reads the list with Manage market open', async () => {
    invited = [invitation(), invitation({ id: 'inv-0', email: 'kept@example.test' })];
    api.delete.mockImplementation(async () => {
      invited = (invited as SentInvitation[]).filter((one) => one.id !== 'inv-1');
      return { data: { message: 'Invitation withdrawn' } };
    });
    await open();
    await askToWithdraw();

    confirm();
    await flushPromises();

    expect(api.delete).toHaveBeenCalledWith('/markets/market-1/invitations/inv-1', {
      params: { sentAt: invitation().sentAt },
    });
    expect(byTestId('manage-market-withdraw-window')).toBeNull();
    expect(byTestId('manage-market-window')).not.toBeNull();
    expect(invitedRows()).toHaveLength(1);
    expect(invitedRows()[0]!.textContent).toContain('kept@example.test');
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

    expect(byTestId('manage-market-withdraw-window')).toBeNull();
    expect(byTestId('manage-market-invited')).toBeNull();
    expect(document.body.textContent).not.toContain('That invitation has already ended.');
  });

  it('reads the market again when the invitation was accepted meanwhile, so its person shows', async () => {
    const NEWCOMER: PersonWithAccess = {
      ...EDITOR,
      userId: 'u-newcomer',
      email: 'newcomer@example.test',
    };
    invited = [invitation()];
    api.delete.mockImplementation(async () => {
      invited = [];
      served = market({ peopleWithAccess: [OWNER, EDITOR, NEWCOMER] });
      throw refusing(404, 'That invitation has already ended.');
    });
    await open();
    await askToWithdraw();

    confirm();
    await flushPromises();

    expect(byTestId('manage-market-withdraw-window')).toBeNull();
    expect(byTestId('manage-market-window')).not.toBeNull();
    expect(peopleShown()).toContain('newcomer@example.test');
  });

  it('says an invitation sent again meanwhile under the confirmation, and re-reads the list', async () => {
    const sentence =
      'That invitation was sent again meanwhile. Read the invitations again, and withdraw it if you still mean to.';
    invited = [invitation()];
    api.delete.mockImplementation(async () => {
      invited = [
        invitation({ role: 'viewer', endsAt: new Date(2026, 11, 9, 10, 5).toISOString() }),
      ];
      throw refusing(409, sentence);
    });
    await open();
    await askToWithdraw();
    const reads = invitationReads();

    confirm();
    await flushPromises();

    expect(text('manage-market-withdraw-error')).toBe(sentence);
    expect(invitationReads()).toBe(reads + 1);
    expect(invitedRows()[0]!.textContent).toContain('Invited as Viewer, until 9 December, 10:05');
  });

  it('names the send its confirmation opened on, though the list behind is read again', async () => {
    const sentAgain = new Date(2026, 10, 25, 9, 30).toISOString();
    invited = [invitation()];
    api.delete.mockImplementation(async () => {
      invited = [invitation({ sentAt: sentAgain })];
      throw refusing(409, 'That invitation was sent again meanwhile.');
    });
    await open();
    await askToWithdraw();

    confirm();
    await flushPromises();
    confirm();
    await flushPromises();

    const confirmed = [
      '/markets/market-1/invitations/inv-1',
      { params: { sentAt: invitation().sentAt } },
    ];
    expect(api.delete.mock.calls).toEqual([confirmed, confirmed]);

    byTestId('manage-market-withdraw-cancel-button')!.click();
    await flushPromises();
    await askToWithdraw();
    confirm();
    await flushPromises();

    expect(api.delete).toHaveBeenLastCalledWith('/markets/market-1/invitations/inv-1', {
      params: { sentAt: sentAgain },
    });
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
    await tryEveryClose('manage-market-withdraw');

    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(byTestId('manage-market-withdraw-window')).not.toBeNull();

    invited = [];
    answer.resolve({ data: { message: 'Invitation withdrawn' } });
    await flushPromises();
    expect(byTestId('manage-market-withdraw-window')).toBeNull();
  });

  it('keeps a withdrawal’s answer out of Manage market opened on another market', async () => {
    invited = [invitation()];
    const answer = held();
    api.delete.mockReturnValue(answer.promise);
    const wrapper = await open();
    await askToWithdraw();
    confirm();
    await flushPromises();

    await wrapper.setProps({ market: OTHER });
    await flushPromises();
    const reads = invitationReads();
    answer.reject(refusing(409, 'That invitation was sent again meanwhile.'));
    await flushPromises();

    expect(invitationReads()).toBe(reads);
    expect(byTestId('manage-market-withdraw-window')).toBeNull();
    expect(document.body.textContent).not.toContain('sent again meanwhile');
  });
});
