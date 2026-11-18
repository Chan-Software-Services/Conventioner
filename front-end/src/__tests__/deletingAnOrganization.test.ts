/**
 * Delete organization's deletion belongs to its opening (T411): one delete however often it is
 * pressed, the dialog held by the shell until it answers, and an answer that lands after the dialog
 * was closed and opened again leaves the new opening alone. Its refusal is said where the preview's
 * own failure is said, and a refusal for markets under way names them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';

import DeleteOrgDialog from '@/components/DeleteOrgDialog.vue';
import { tryEveryClose } from './support/dialogCloses';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

enableAutoUnmount(afterEach);

function held<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const refused = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error('refused'), { isAxiosError: true, response: { status, data } });

const DRAFT = {
  id: 'market-1',
  name: 'Spring Makers Fair',
  phase: 'draft',
  phaseLabel: 'Draft',
  ran: false,
  placements: 0,
  publicSlug: null,
};

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const confirm = () => byTestId('delete-org-window')!.querySelector('form')!.requestSubmit();

beforeEach(() => {
  for (const call of Object.values(api)) call.mockReset();
  api.get.mockResolvedValue({
    data: { canDelete: true, blockingMarkets: [], marketsToDelete: [DRAFT] },
  });
});

async function openDialog(): Promise<VueWrapper> {
  const wrapper = mount(DeleteOrgDialog, {
    props: { open: true, orgId: 'org-1', orgName: 'Harbour Makers' },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

async function closeAndOpenAgain(wrapper: VueWrapper) {
  await wrapper.setProps({ open: false });
  await flushPromises();
  await wrapper.setProps({ open: true });
  await flushPromises();
}

describe('Delete organization', () => {
  it('sends one delete for two presses, and nothing closes it until it lands', async () => {
    const wrapper = await openDialog();
    const answer = held();
    api.delete.mockReturnValue(answer.promise);

    confirm();
    confirm();
    await flushPromises();

    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith('/organizations/org-1');
    expect(byTestId('delete-org-submit-button')!.hasAttribute('disabled')).toBe(true);
    expect(byTestId('delete-org-cancel-button')!.hasAttribute('disabled')).toBe(true);
    await tryEveryClose('delete-org');
    expect(wrapper.emitted('close')).toBeUndefined();

    answer.resolve({ data: {} });
    await flushPromises();
    expect(wrapper.emitted('deleted')).toHaveLength(1);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('says a refusal under what it would destroy, with Delete it all enabled again', async () => {
    api.delete.mockRejectedValue(refused(403, { error: 'Only the owner deletes it.' }));
    const wrapper = await openDialog();

    confirm();
    await flushPromises();

    expect(byTestId('delete-org-error')!.textContent?.trim()).toBe('Only the owner deletes it.');
    expect(byTestId('delete-org-submit-button')!.hasAttribute('disabled')).toBe(false);
    expect(wrapper.emitted('deleted')).toBeUndefined();
  });

  it('names the markets under way when the deletion is refused for them', async () => {
    api.delete.mockRejectedValue(
      refused(409, {
        error: 'organization_has_live_markets',
        message: 'This organization still holds a market that is under way.',
        blockingMarkets: [{ ...DRAFT, phase: 'review', phaseLabel: 'Review' }],
      }),
    );
    await openDialog();

    confirm();
    await flushPromises();

    expect(byTestId('delete-org-error')!.textContent?.trim()).toBe(
      'This organization still holds a market that is under way.',
    );
    expect(byTestId('delete-org-blocking-market')!.textContent).toContain('Spring Makers Fair');
    expect(byTestId('delete-org-submit-button')!.hasAttribute('disabled')).toBe(true);
  });

  it('keeps a refusal out of its next opening', async () => {
    api.delete.mockRejectedValue(refused(403, { error: 'Only the owner deletes it.' }));
    const wrapper = await openDialog();
    confirm();
    await flushPromises();
    expect(byTestId('delete-org-error')).not.toBeNull();

    await closeAndOpenAgain(wrapper);

    expect(byTestId('delete-org-error')).toBeNull();
    expect(byTestId('delete-org-submit-button')!.hasAttribute('disabled')).toBe(false);
  });

  it.each([
    ['refusal', (answer: ReturnType<typeof held>) => answer.reject(refused(500, {}))],
    ['success', (answer: ReturnType<typeof held>) => answer.resolve({ data: {} })],
  ])("keeps an earlier opening's %s out of the opening its parent made since", async (_, land) => {
    const wrapper = await openDialog();
    const answer = held();
    api.delete.mockReturnValue(answer.promise);
    confirm();
    await flushPromises();

    await closeAndOpenAgain(wrapper);
    land(answer);
    await flushPromises();

    expect(byTestId('delete-org-error')).toBeNull();
    expect(byTestId('delete-org-submit-button')!.hasAttribute('disabled')).toBe(false);
    expect(wrapper.emitted('deleted')).toBeUndefined();
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it("names both of a market's pages that stop working: its market page and its vendor page (T469)", async () => {
    api.get.mockResolvedValue({
      data: {
        canDelete: true,
        blockingMarkets: [],
        marketsToDelete: [
          DRAFT,
          {
            ...DRAFT,
            id: 'market-2',
            name: 'Harbour Night Market',
            phase: 'archived',
            phaseLabel: 'Archived',
            ran: true,
            placements: 12,
            publicSlug: 'harbour-night-market',
          },
        ],
      },
    });
    await openDialog();

    const urls = document.body.querySelectorAll('[data-testid="delete-org-public-url"]');
    expect(urls).toHaveLength(1);
    expect(urls[0]!.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Its market page, /harbour-night-market, and vendor page, /harbour-night-market/vendor, will stop working for anyone who has the links.',
    );
  });
});
