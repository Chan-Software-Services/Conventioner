import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

/** A verdict, or a follow-up, as the review route takes one. */
export interface Verdict {
  status: 'reviewer_approved' | 'reviewer_rejected' | 'needs_follow_up';
  ownerEmail?: string;
}

/**
 * Give a verdict through the review route as a reviewer's card sends one: with `seen`, the
 * application as the card showed it, read from the list just before. The route holds the verdict
 * on it and refuses one that names nothing it saw (E34/F03/S01), so a spec that sets a verdict up
 * by request sends what the screen would.
 *
 * `api` is the back end's address for `request`: `BACKEND_URL` for the seed's own session, or
 * `APP_API` for a browser context's.
 */
export async function putVerdict(
  request: APIRequestContext,
  api: string,
  marketId: string,
  applicationId: string,
  verdict: Verdict,
): Promise<APIResponse> {
  const listed = await request.get(`${api}/markets/${marketId}/applications`);
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const applications = (await listed.json()).applications as {
    id: string;
    status: string;
    verdictAt?: string | null;
    updatedAt?: string | null;
  }[];
  const shown = applications.find((application) => application.id === applicationId);
  expect(shown, `application ${applicationId} is listed`).toBeTruthy();
  return request.put(`${api}/markets/${marketId}/applications/${applicationId}/review`, {
    data: {
      ...verdict,
      seen: {
        status: shown!.status,
        verdictAt: shown!.verdictAt ?? null,
        updatedAt: shown!.updatedAt ?? null,
      },
    },
  });
}
