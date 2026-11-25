/**
 * The human check's token a test sends over the API (T539).
 *
 * The stack's front end has no site key, so its screens send this same placeholder
 * (`PLACEHOLDER_TOKEN` in `src/utils/captcha.ts`), and its back end, with `DISABLE_CAPTCHA`, passes
 * any token but refuses a request that sends none, as production does. So a request that asks the
 * check (a vendor's code request, sign-up) sends it, as `captcha_token`.
 */
export const HUMAN_CHECK_TOKEN = 'e2e-test-captcha-token';
