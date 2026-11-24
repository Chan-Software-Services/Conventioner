import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
vi.mock('@/utils/api', () => ({ api: { get: (...args: unknown[]) => get(...args) } }));

const { fetchPublicApplicationForm } = await import('@/utils/publicApplicationForm');

function httpError(status: number) {
  return Object.assign(new Error(`Request failed with status ${status}`), {
    response: { status },
  });
}

describe('fetchPublicApplicationForm', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('reports a served market as neither failed nor missing', async () => {
    get.mockResolvedValue({
      data: { market_name: 'Spring Market', application_form: { fields: [] }, is_open: true },
    });

    const form = await fetchPublicApplicationForm('spring-market');

    expect(form.failed).toBe(false);
    expect(form.notFound).toBe(false);
    expect(form.marketName).toBe('Spring Market');
  });

  it('answers the form version the read served', async () => {
    get.mockResolvedValue({
      data: { application_form: { fields: [] }, is_open: true, formVersion: 'version-1' },
    });

    expect((await fetchPublicApplicationForm('spring-market')).formVersion).toBe('version-1');
  });

  it('answers no form version when the read served none, or one that is not a string', async () => {
    get.mockResolvedValueOnce({ data: { application_form: { fields: [] }, is_open: true } });
    get.mockResolvedValueOnce({ data: { application_form: { fields: [] }, formVersion: 7 } });

    expect((await fetchPublicApplicationForm('spring-market')).formVersion).toBeNull();
    expect((await fetchPublicApplicationForm('spring-market')).formVersion).toBeNull();
  });

  it('answers no form version when the read failed', async () => {
    get.mockRejectedValue(new Error('Network Error'));

    expect((await fetchPublicApplicationForm('spring-market')).formVersion).toBeNull();
  });

  it('reports a 404 as missing', async () => {
    // What both an unknown slug and a market whose vendors are imported answer.
    get.mockRejectedValue(httpError(404));

    const form = await fetchPublicApplicationForm('spring-market');

    expect(form.notFound).toBe(true);
    expect(form.failed).toBe(true);
  });

  it('does not report a request that never answered as missing', async () => {
    // A phone on a bad connection. Calling this "no such market" sends the applicant away from a
    // page that would have loaded on the next try.
    get.mockRejectedValue(new Error('Network Error'));

    const form = await fetchPublicApplicationForm('spring-market');

    expect(form.failed).toBe(true);
    expect(form.notFound).toBe(false);
  });

  it('does not report a server error as missing', async () => {
    get.mockRejectedValue(httpError(500));

    const form = await fetchPublicApplicationForm('spring-market');

    expect(form.failed).toBe(true);
    expect(form.notFound).toBe(false);
  });
});
