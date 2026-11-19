import type { APIRequestContext } from '@playwright/test';
import { BACKEND_URL } from '../fixtures';

/**
 * Turns on a market's self check-in switch, "Vendors check themselves in and out", through its
 * own write, as the door code's screen does (T496). The switch is off for every market until
 * someone turns it on, and while it is off the vendor's own check-in, check-out and both undos are
 * refused, so every spec that has a vendor check themselves in or out calls this first.
 *
 * `request` holds the session of someone who may check vendors in (the seed's owner), and the
 * market is in its market days: the switch is set nowhere else.
 */
export async function letVendorsCheckThemselvesIn(
  request: APIRequestContext,
  marketId: string,
): Promise<void> {
  const res = await request.put(`${BACKEND_URL}/markets/${marketId}/self-check-in`, {
    data: { enabled: true },
  });
  if (!res.ok()) {
    throw new Error(
      `Letting vendors check themselves in failed: ${res.status()} ${await res.text()}`,
    );
  }
}
