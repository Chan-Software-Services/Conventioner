// @vitest-environment happy-dom
/**
 * The Invitations page (T538, ADR 0047): every invitation waiting for the signed-in address, each
 * answered in its own row, which keeps its place and says what came of it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { AxiosError } from 'axios';

const fetchInvitations = vi.fn();
const acceptInvitation = vi.fn();
const declineInvitation = vi.fn();
vi.mock('@/utils/invitations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/invitations')>()),
  fetchInvitations: () => fetchInvitations(),
  acceptInvitation: (id: string) => acceptInvitation(id),
  declineInvitation: (id: string) => declineInvitation(id),
}));

import router, { requireSignIn } from '@/router';
import { loginAddress } from '@/utils/signInNext';
import InvitationsView from '@/views/InvitationsView.vue';
import type { Invitation } from '@/assets/types/datatypes';

const TO_A_MARKET: Invitation = {
  id: 'inv-1',
  kind: 'market',
  targetId: 'market-1',
  targetName: 'Riverside Spring Market',
  role: 'editor',
  invitedBy: 'dana@ember.test',
  sentAt: '2026-11-24T12:00:00+00:00',
  endsAt: '2026-12-08T12:00:00+00:00',
};
const TO_AN_ORGANIZATION: Invitation = {
  id: 'inv-2',
  kind: 'organization',
  targetId: 'org-1',
  targetName: 'Ember Makers',
  role: 'member',
  invitedBy: 'olive@ember.test',
  sentAt: '2026-11-23T12:00:00+00:00',
  endsAt: '2026-12-07T12:00:00+00:00',
};

const ENDED =
  'This invitation has ended: it was withdrawn, it ran out, or whoever sent it can no longer ' +
  'give it. Ask them to invite you again.';
const MARKET_CHANGED =
  'This market changed while you were working on it, so your change was not saved. Reload to ' +
  'see the latest, then make your change again.';

function refusal(status: number, data: unknown) {
  return Object.assign(new AxiosError('refused'), { response: { status, data } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mountPage() {
  const wrapper = mount(InvitationsView, {
    attachTo: document.body,
    global: { stubs: { RouterLink: RouterLinkStub } },
  });
  await flushPromises();
  return wrapper;
}

type Page = Awaited<ReturnType<typeof mountPage>>;

const rows = (wrapper: Page) => wrapper.findAll('[data-testid="invitation-row"]');
const row = (wrapper: Page, index = 0) => rows(wrapper)[index]!;
const press = async (wrapper: Page, which: 'accept' | 'decline', index = 0) => {
  await row(wrapper, index).get(`[data-testid="invitation-${which}"]`).trigger('click');
  await flushPromises();
};

afterEach(() => {
  fetchInvitations.mockReset();
  acceptInvitation.mockReset();
  declineInvitation.mockReset();
  document.body.innerHTML = '';
});

describe('the Invitations page’s address', () => {
  it('is a page of its own, never read as a market’s slug', () => {
    expect(router.resolve('/invitations').name).toBe('invitations');
  });

  it('is signed in: a signed-out person goes to sign in, and comes back to it', () => {
    const to = router.resolve('/invitations');
    expect(to.matched.some((record) => record.meta.public === true)).toBe(false);
    const guard = requireSignIn as (to: unknown, from: unknown) => unknown;
    expect(guard(to, router.resolve('/'))).toEqual(loginAddress('/invitations'));
  });
});

describe('the Invitations page, as it reads', () => {
  it('says it is loading while it first reads', async () => {
    fetchInvitations.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(InvitationsView, { global: { stubs: { RouterLink: RouterLinkStub } } });
    await flushPromises();
    expect(wrapper.get('h1').text()).toBe('Invitations');
    expect(wrapper.get('[data-testid="invitations-loading"]').text()).toBe('Loading invitations…');
  });

  it('says so when none wait', async () => {
    fetchInvitations.mockResolvedValue([]);
    const wrapper = await mountPage();
    expect(wrapper.get('[data-testid="invitations-none"]').text()).toBe(
      'No invitations are waiting for you.',
    );
    expect(rows(wrapper)).toHaveLength(0);
  });

  it('says a failed read, and reads again on Try again', async () => {
    // A refusal with no sentence of its own reads as the page's; a server fault or no connection
    // would say so instead, as every page's read does.
    fetchInvitations.mockRejectedValueOnce(refusal(403, {}));
    fetchInvitations.mockResolvedValueOnce([TO_A_MARKET]);
    const wrapper = await mountPage();
    expect(wrapper.get('[data-testid="invitations-read-failed"]').text()).toContain(
      'Could not read your invitations.',
    );
    await wrapper.get('[data-testid="invitations-retry"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="invitations-read-failed"]').exists()).toBe(false);
    expect(rows(wrapper)).toHaveLength(1);
  });

  it('words each invitation: who, to what, as what, and until when', async () => {
    fetchInvitations.mockResolvedValue([TO_A_MARKET, TO_AN_ORGANIZATION]);
    const wrapper = await mountPage();
    expect(row(wrapper, 0).get('[data-testid="invitation-sentence"]').text()).toBe(
      'dana@ember.test invited you to Riverside Spring Market as an Editor.',
    );
    expect(row(wrapper, 0).get('[data-testid="invitation-until"]').text()).toBe(
      'Until 8 December.',
    );
    expect(row(wrapper, 1).get('[data-testid="invitation-sentence"]').text()).toBe(
      'olive@ember.test invited you to the organization Ember Makers as a member.',
    );
    expect(row(wrapper, 1).get('[data-testid="invitation-until"]').text()).toBe(
      'Until 7 December.',
    );
    for (const role of ['admin', 'viewer'] as const) {
      fetchInvitations.mockResolvedValue([{ ...TO_A_MARKET, role }]);
      const again = await mountPage();
      expect(row(again).get('[data-testid="invitation-sentence"]').text()).toBe(
        `dana@ember.test invited you to Riverside Spring Market as ${
          role === 'admin' ? 'an Admin' : 'a Viewer'
        }.`,
      );
      again.unmount();
    }
    expect(row(wrapper, 0).get('[data-testid="invitation-accept"]').classes()).toContain(
      'btn--primary',
    );
    expect(row(wrapper, 0).get('[data-testid="invitation-decline"]').classes()).toContain(
      'btn--secondary',
    );
  });
});

describe('answering an invitation', () => {
  it('says what accepting a market invitation made them, links the market, and takes the focus there', async () => {
    fetchInvitations.mockResolvedValue([TO_A_MARKET, TO_AN_ORGANIZATION]);
    acceptInvitation.mockResolvedValue({
      kind: 'market',
      targetId: 'market-1',
      targetName: 'Riverside Spring Market',
      role: 'editor',
    });
    const wrapper = await mountPage();
    await press(wrapper, 'accept');
    expect(acceptInvitation).toHaveBeenCalledWith('inv-1');
    const outcome = row(wrapper).get('[data-testid="invitation-outcome"]');
    expect(outcome.text()).toBe('You are now an Editor on Riverside Spring Market.');
    expect(document.activeElement).toBe(outcome.element);
    const link = row(wrapper).getComponent(RouterLinkStub);
    expect(link.props('to')).toBe('/markets/market-1');
    expect(link.text()).toBe('Open Riverside Spring Market');
    expect(row(wrapper).find('[data-testid="invitation-accept"]').exists()).toBe(false);
    // The row keeps its place, and the next one still waits.
    expect(rows(wrapper)).toHaveLength(2);
    expect(row(wrapper, 1).find('[data-testid="invitation-accept"]').exists()).toBe(true);
  });

  it('says what accepting an organization invitation made them, and links Organizations', async () => {
    fetchInvitations.mockResolvedValue([TO_AN_ORGANIZATION]);
    acceptInvitation.mockResolvedValue({
      kind: 'organization',
      targetId: 'org-1',
      targetName: 'Ember Makers',
      role: 'member',
    });
    const wrapper = await mountPage();
    await press(wrapper, 'accept');
    expect(row(wrapper).get('[data-testid="invitation-outcome"]').text()).toBe(
      'You are now a member of Ember Makers.',
    );
    const link = row(wrapper).getComponent(RouterLinkStub);
    expect(link.props('to')).toBe('/organizations');
    expect(link.text()).toBe('Open Organizations');
  });

  it('says a decline, and takes the focus there', async () => {
    fetchInvitations.mockResolvedValue([TO_AN_ORGANIZATION]);
    declineInvitation.mockResolvedValue(undefined);
    const wrapper = await mountPage();
    await press(wrapper, 'decline');
    expect(declineInvitation).toHaveBeenCalledWith('inv-2');
    const outcome = row(wrapper).get('[data-testid="invitation-outcome"]');
    expect(outcome.text()).toBe('You declined the invitation to Ember Makers.');
    expect(document.activeElement).toBe(outcome.element);
    expect(row(wrapper).find('[data-testid="invitation-decline"]').exists()).toBe(false);
  });

  it('holds both buttons while an answer is out, and a second press sends nothing', async () => {
    fetchInvitations.mockResolvedValue([TO_A_MARKET]);
    const answer = deferred<unknown>();
    acceptInvitation.mockReturnValue(answer.promise);
    const wrapper = await mountPage();
    await press(wrapper, 'accept');
    expect(row(wrapper).get('[data-testid="invitation-accept"]').attributes('disabled')).toBe('');
    expect(row(wrapper).get('[data-testid="invitation-decline"]').attributes('disabled')).toBe('');
    await press(wrapper, 'accept');
    await press(wrapper, 'decline');
    expect(acceptInvitation).toHaveBeenCalledTimes(1);
    expect(declineInvitation).not.toHaveBeenCalled();
    answer.resolve({ kind: 'market', targetId: 'market-1', targetName: 'R', role: 'editor' });
    await flushPromises();
    expect(row(wrapper).get('[data-testid="invitation-outcome"]').text()).toBe(
      'You are now an Editor on R.',
    );
  });

  it('says an ended invitation in the server’s words, and takes its buttons away', async () => {
    fetchInvitations.mockResolvedValue([TO_A_MARKET]);
    acceptInvitation.mockRejectedValue(refusal(404, { error: ENDED, code: 'invitation_ended' }));
    const wrapper = await mountPage();
    await press(wrapper, 'accept');
    const outcome = row(wrapper).get('[data-testid="invitation-outcome"]');
    expect(outcome.text()).toBe(ENDED);
    expect(document.activeElement).toBe(outcome.element);
    expect(row(wrapper).find('[data-testid="invitation-accept"]').exists()).toBe(false);
    expect(row(wrapper).find('[data-testid="invitation-decline"]').exists()).toBe(false);
  });

  it.each([
    [
      'a market',
      'You already have a role on this market, so this invitation has ended. Ask its owner or an Admin to change your role.',
    ],
    ['an organization', 'You are already in this organization, so this invitation has ended.'],
  ])(
    'says the invitation to %s they are already in has ended, its buttons gone',
    async (_, words) => {
      fetchInvitations.mockResolvedValue([TO_A_MARKET]);
      acceptInvitation.mockRejectedValue(refusal(400, { error: words }));
      const wrapper = await mountPage();
      await press(wrapper, 'accept');
      expect(row(wrapper).get('[data-testid="invitation-outcome"]').text()).toBe(words);
      expect(row(wrapper).find('[data-testid="invitation-accept"]').exists()).toBe(false);
    },
  );

  it('says a change that met another in its row, and keeps the buttons to answer again', async () => {
    fetchInvitations.mockResolvedValue([TO_A_MARKET]);
    acceptInvitation
      .mockRejectedValueOnce(refusal(409, { error: MARKET_CHANGED, code: 'market_changed' }))
      .mockResolvedValueOnce({
        kind: 'market',
        targetId: 'market-1',
        targetName: 'Riverside Spring Market',
        role: 'editor',
      });
    const wrapper = await mountPage();
    await press(wrapper, 'accept');
    expect(row(wrapper).get('[data-testid="invitation-refused"]').text()).toBe(MARKET_CHANGED);
    expect(row(wrapper).get('[data-testid="invitation-accept"]').attributes('disabled')).toBe(
      undefined,
    );
    await press(wrapper, 'accept');
    expect(acceptInvitation).toHaveBeenCalledTimes(2);
    expect(row(wrapper).find('[data-testid="invitation-refused"]').exists()).toBe(false);
    expect(row(wrapper).get('[data-testid="invitation-outcome"]').text()).toBe(
      'You are now an Editor on Riverside Spring Market.',
    );
  });

  it('says a failed connection in its row, the buttons kept', async () => {
    fetchInvitations.mockResolvedValue([TO_A_MARKET]);
    declineInvitation.mockRejectedValue(Object.assign(new AxiosError('Network Error'), {}));
    const wrapper = await mountPage();
    await press(wrapper, 'decline');
    expect(row(wrapper).get('[data-testid="invitation-refused"]').text()).toBe(
      'You seem to be offline. Check the connection and try again.',
    );
    expect(row(wrapper).find('[data-testid="invitation-decline"]').exists()).toBe(true);
  });
});
