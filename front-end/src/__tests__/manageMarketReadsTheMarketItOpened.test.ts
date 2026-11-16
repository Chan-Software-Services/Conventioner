// @vitest-environment happy-dom
/**
 * Manage market reads, and writes to, the market it was opened on (T277 ticket 11, T421).
 *
 * Its own read of the market is keyed by the market it is open on, so a read of another market,
 * or one a write has overtaken, never lands: opened on A, closed and opened on B, A's late read
 * leaves B alone and Rename renames B (T277 probe 11); a re-read asked before a rename, answering
 * after the rename's own re-read, never puts the old name back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import ManageMarketOverlay from '@/views/ManageMarketOverlay.vue';
import MarketPermissions from '@/components/MarketPermissions.vue';
import {
  MarketPhase,
  MarketRole,
  type Market,
  type PermissionTableRow,
} from '@/assets/types/datatypes';
import { answersRefusing } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

const ROW = { id: 'assign', label: 'Assign tables' } as unknown as PermissionTableRow;

function market(id: string, name: string, email = 'owner@example.com'): Market {
  return {
    id,
    name,
    phase: MarketPhase.Draft,
    organizationId: 'org-1',
    organizationName: 'Seed Test Org',
    roles: {},
    inOrganization: true,
    actionRefusals: answersRefusing(),
    permissionTable: [ROW],
    peopleWithAccess: [
      {
        userId: 'u-owner',
        email,
        role: MarketRole.Owner,
        marketRole: MarketRole.Owner,
        organizationRole: null,
        fromOrganization: false,
      },
    ],
  } as unknown as Market;
}

function held<T>() {
  let settle!: (value: T) => void;
  let refuse!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    refuse = reject;
  });
  return { promise, settle, refuse };
}

const byTestId = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
const dialogText = () => byTestId('manage-market-window')?.textContent ?? '';

function mountOn(target: Market) {
  return mount(ManageMarketOverlay, {
    props: { manageOpen: true, market: target },
    attachTo: document.body,
    global: {
      stubs: { RouterLink: { template: '<a><slot /></a>' }, MarketPermissions: true },
    },
  });
}

async function typeName(name: string) {
  const input = byTestId('manage-market-rename-input')!;
  input.value = name;
  input.dispatchEvent(new Event('input'));
  await flushPromises();
}

enableAutoUnmount(afterEach);
beforeEach(() => {
  setActivePinia(createPinia());
  api.get.mockReset();
  api.post.mockReset();
  api.put.mockReset();
  api.delete.mockReset();
  document.body.innerHTML = '';
});

describe('Manage market opened on B never shows or writes A', () => {
  it("A's late read lands after B is opened: B stays, and Rename writes to B", async () => {
    const A = market('market-a', 'Market A');
    const B = market('market-b', 'Market B');
    const readA = held<unknown>();
    const readB = held<unknown>();
    api.get.mockImplementation((url: string) => {
      if (url === '/markets/market-a') return readA.promise;
      if (url === '/markets/market-b') return readB.promise;
      return Promise.resolve({ data: {} });
    });
    api.put.mockResolvedValue({ data: {} });
    const w = mountOn(A);
    await flushPromises();
    await w.setProps({ manageOpen: false });
    await flushPromises();
    await w.setProps({ manageOpen: true, market: B });
    await flushPromises();
    readB.settle({ data: { market: B } });
    await flushPromises();
    readA.settle({ data: { market: A } });
    await flushPromises();

    expect(byTestId('manage-market-rename-input')?.value).toBe('Market B');
    await typeName('Market B renamed');
    byTestId('manage-market-rename-save-button')!.click();
    await flushPromises();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0]![0]).toBe('/markets/market-b/name');
  });

  it("says it is loading under the new market's name when the market changes while open, never the last one's people", async () => {
    const A = market('market-a', 'Market A', 'ana@example.com');
    const B = market('market-b', 'Market B', 'ben@example.com');
    const readB = held<unknown>();
    api.get.mockImplementation((url: string) => {
      if (url === '/markets/market-a') return Promise.resolve({ data: { market: A } });
      if (url === '/markets/market-b') return readB.promise;
      return Promise.resolve({ data: { entries: [], next: null } });
    });
    const w = mountOn(A);
    await flushPromises();
    expect(dialogText()).toContain('ana@example.com');

    await w.setProps({ market: B });
    await flushPromises();
    expect(dialogText()).toContain('Market B');
    expect(dialogText()).toContain('Loading...');
    expect(dialogText()).not.toContain('Market A');
    expect(dialogText()).not.toContain('ana@example.com');

    readB.settle({ data: { market: B } });
    await flushPromises();
    expect(dialogText()).not.toContain('Loading...');
    expect(dialogText()).toContain('ben@example.com');
  });

  it("A's failed read, answering after B is opened, says nothing on B", async () => {
    const A = market('market-a', 'Market A');
    const B = market('market-b', 'Market B');
    const readA = held<unknown>();
    api.get.mockImplementation((url: string) => {
      if (url === '/markets/market-a') return readA.promise;
      if (url === '/markets/market-b') return Promise.resolve({ data: { market: B } });
      return Promise.resolve({ data: { entries: [], next: null } });
    });
    const w = mountOn(A);
    await flushPromises();
    await w.setProps({ market: B });
    await flushPromises();
    readA.refuse(new Error('A is unreachable'));
    await flushPromises();

    expect(byTestId('manage-market-error')).toBeNull();
    expect(byTestId('manage-market-rename-input')?.value).toBe('Market B');
  });
});

describe('a failed first read', () => {
  it("says the failure over the opener's copy of the market, and writes to it", async () => {
    const A = market('market-a', 'Market A', 'ana@example.com');
    api.get.mockImplementation((url: string) =>
      url === '/markets/market-a'
        ? Promise.reject(new Error('unreachable'))
        : Promise.resolve({ data: { entries: [], next: null } }),
    );
    api.put.mockResolvedValue({ data: {} });
    mountOn(A);
    await flushPromises();

    expect(byTestId('manage-market-error')?.textContent?.trim()).toBe(
      'The market could not be loaded.',
    );
    expect(dialogText()).toContain('ana@example.com');
    await typeName('Market A renamed');
    byTestId('manage-market-rename-save-button')!.click();
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/markets/market-a/name', { name: 'Market A renamed' });
  });
});

describe('a re-read asked before a write never lands after it', () => {
  it("a re-read asked before a rename, answering after the rename's own, keeps the new name", async () => {
    const before = market('market-1', 'Spring Market');
    const renamed = market('market-1', 'Summer Market');
    const reads: ReturnType<typeof held<unknown>>[] = [];
    api.get.mockImplementation((url: string) => {
      if (url !== '/markets/market-1')
        return Promise.resolve({ data: { entries: [], next: null } });
      const read = held<unknown>();
      reads.push(read);
      return read.promise;
    });
    api.put.mockResolvedValue({ data: {} });
    const w = mountOn(before);
    await flushPromises();
    reads[0]!.settle({ data: { market: before } });
    await flushPromises();

    // Who may do what met a market that changed: Manage market reads it again, and that read is
    // still out when the rename is saved.
    w.findComponent(MarketPermissions).vm.$emit('marketChanged');
    await flushPromises();
    const askedBefore = reads[reads.length - 1]!;
    await typeName('Summer Market');
    byTestId('manage-market-rename-save-button')!.click();
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/markets/market-1/name', { name: 'Summer Market' });

    const afterRename = reads[reads.length - 1]!;
    expect(afterRename).not.toBe(askedBefore);
    afterRename.settle({ data: { market: renamed } });
    await flushPromises();
    askedBefore.settle({ data: { market: before } });
    await flushPromises();

    expect(byTestId('manage-market-window')?.querySelector('.market-name')?.textContent).toBe(
      'Summer Market',
    );
    expect(byTestId('manage-market-rename-input')?.value).toBe('Summer Market');
  });

  it('a change to who may do what, answered while an older re-read is out, is not undone by it', async () => {
    const before = market('market-1', 'Spring Market');
    const changedRow = { ...ROW, label: 'Assign tables, changed' } as PermissionTableRow;
    const after = { ...before, permissionTable: [changedRow] } as Market;
    const reads: ReturnType<typeof held<unknown>>[] = [];
    api.get.mockImplementation((url: string) => {
      if (url !== '/markets/market-1')
        return Promise.resolve({ data: { entries: [], next: null } });
      const read = held<unknown>();
      reads.push(read);
      return read.promise;
    });
    const w = mountOn(before);
    await flushPromises();
    reads[0]!.settle({ data: { market: before } });
    await flushPromises();
    const permissions = () => w.findComponent(MarketPermissions);

    permissions().vm.$emit('marketChanged');
    await flushPromises();
    const askedBefore = reads[reads.length - 1]!;
    permissions().vm.$emit('changed', [changedRow]);
    await flushPromises();
    expect(permissions().props('market').permissionTable).toEqual([changedRow]);

    // The table was taken in while that re-read was out, so the market is read once more.
    const askedAfter = reads[reads.length - 1]!;
    expect(askedAfter).not.toBe(askedBefore);
    askedAfter.settle({ data: { market: after } });
    await flushPromises();
    askedBefore.settle({ data: { market: before } });
    await flushPromises();
    expect(permissions().props('market').permissionTable).toEqual([changedRow]);
  });
});
