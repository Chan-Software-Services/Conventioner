import type { Locator, Page } from '@playwright/test';

/**
 * Page object for the Login, Register, and OTP authentication views.
 * Encapsulates all selectors using data-testid attributes.
 */
export class LoginPage {
  readonly page: Page;

  // Mode tabs
  readonly tabLogin: Locator;
  readonly tabRegister: Locator;
  readonly tabOtp: Locator;

  /** The bordered box of every field on the open tab, which holds its input and any Show button. */
  readonly fieldBoxes: Locator;

  // Login form
  readonly loginForm: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly togglePassword: Locator;
  readonly errorMessage: Locator;
  readonly successMessage: Locator;
  readonly errorForgotPasswordLink: Locator;
  readonly resendVerificationButton: Locator;
  readonly submitButton: Locator;
  readonly forgotPasswordLink: Locator;
  readonly rememberMe: Locator;

  // Register form
  readonly registerForm: Locator;
  readonly registerEmailInput: Locator;
  readonly registerPasswordInput: Locator;
  readonly registerPasswordConfirmInput: Locator;
  readonly registerTogglePassword: Locator;
  readonly registerErrorMessage: Locator;
  readonly registerSuccessMessage: Locator;
  readonly registerSubmitButton: Locator;

  // OTP form
  readonly otpForm: Locator;
  readonly otpEmailInput: Locator;
  readonly otpCodeInput: Locator;
  readonly otpErrorMessage: Locator;
  readonly otpSuccessMessage: Locator;
  readonly otpResendVerificationButton: Locator;
  readonly otpSubmitButton: Locator;
  readonly otpDifferentEmailButton: Locator;
  readonly otpRememberMe: Locator;

  constructor(page: Page) {
    this.page = page;

    this.tabLogin = page.getByTestId('login-tab-login');
    this.tabRegister = page.getByTestId('login-tab-register');
    this.tabOtp = page.getByTestId('login-tab-otp');

    this.fieldBoxes = page.getByTestId('login-field-box');

    this.loginForm = page.getByTestId('login-form');
    this.emailInput = page.getByTestId('login-email-input');
    this.passwordInput = page.getByTestId('login-password-input');
    this.togglePassword = page.getByTestId('login-toggle-password');
    this.errorMessage = page.getByTestId('login-error-message');
    this.successMessage = page.getByTestId('login-success-message');
    this.errorForgotPasswordLink = page.getByTestId('login-error-forgot-password-link');
    this.resendVerificationButton = page.getByTestId('login-resend-verification-button');
    this.submitButton = page.getByTestId('login-submit-button');
    this.forgotPasswordLink = page.getByTestId('login-forgot-password-link');
    this.rememberMe = page.getByTestId('login-remember-me');

    this.registerForm = page.getByTestId('login-register-form');
    this.registerEmailInput = page.getByTestId('login-register-email-input');
    this.registerPasswordInput = page.getByTestId('login-register-password-input');
    this.registerPasswordConfirmInput = page.getByTestId('login-register-password-confirm-input');
    this.registerTogglePassword = page.getByTestId('login-register-toggle-password');
    this.registerErrorMessage = page.getByTestId('login-register-error-message');
    this.registerSuccessMessage = page.getByTestId('login-register-success-message');
    this.registerSubmitButton = page.getByTestId('login-register-submit-button');

    this.otpForm = page.getByTestId('login-otp-form');
    this.otpEmailInput = page.getByTestId('login-otp-email-input');
    this.otpCodeInput = page.getByTestId('login-otp-code-input');
    this.otpErrorMessage = page.getByTestId('login-otp-error-message');
    this.otpSuccessMessage = page.getByTestId('login-otp-success-message');
    this.otpResendVerificationButton = page.getByTestId('login-otp-resend-verification-button');
    this.otpSubmitButton = page.getByTestId('login-otp-submit-button');
    this.otpDifferentEmailButton = page.getByTestId('login-otp-different-email-button');
    this.otpRememberMe = page.getByTestId('login-otp-remember-me');
  }

  async goto(): Promise<void> {
    await this.page.goto('/login');
  }

  async switchToLogin(): Promise<void> {
    await this.tabLogin.click();
  }

  async switchToRegister(): Promise<void> {
    await this.tabRegister.click();
  }

  async switchToOtp(): Promise<void> {
    await this.tabOtp.click();
  }

  async fillEmail(email: string): Promise<void> {
    await this.emailInput.fill(email);
  }

  async fillPassword(password: string): Promise<void> {
    await this.passwordInput.fill(password);
  }

  async clickSubmit(): Promise<void> {
    await this.submitButton.click();
  }

  async login(email: string, password: string): Promise<void> {
    await this.goto();
    await this.signIn(email, password);
  }

  /** Sign in on the login page as it stands, keeping the address it was opened at (its `next`). */
  async signIn(email: string, password: string): Promise<void> {
    await this.fillEmail(email);
    await this.fillPassword(password);
    await this.clickSubmit();
  }

  /**
   * Where signing in lands. By the path, not a glob: `/login?next=/markets` ends in `/markets` too,
   * so a glob would be met before the sign-in had happened.
   */
  async waitForMarkets(): Promise<void> {
    await this.page.waitForURL((url) => url.pathname === '/markets', { timeout: 10000 });
  }

  /**
   * Sign in from the login page, and return once Markets, where it lands, has the answers to its
   * three reads, the account's markets, its organizations and the invitations waiting for it.
   *
   * A seed that then signs in on this page's cookies (`page.request`) ends this sign-in first, as
   * every sign-in ends the one its browser held, so a read of Markets still out then answers 401
   * and the page signs out. A fixture account's sign-in takes a few milliseconds, its password
   * hashed at bcrypt's lowest cost, so without this wait the seed's sign-in lands among those reads.
   */
  async signInToMarkets(email: string, password: string): Promise<void> {
    const answered = (path: string) =>
      this.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === path && response.request().method() === 'GET',
        { timeout: 10000 },
      );
    await this.goto();
    await this.fillEmail(email);
    await this.fillPassword(password);
    const reads = Promise.all([
      answered('/api/markets'),
      answered('/api/organizations'),
      answered('/api/invitations'),
    ]);
    // Set before the submit, so its timers end first: a sign-in that never lands fails on the
    // landing below, which says so, rather than on these waits.
    reads.catch(() => undefined);
    await this.clickSubmit();
    await this.waitForMarkets();
    await reads;
  }
}
