/**
 * Where the reader goes to create and manage an Enable Banking application.
 *
 * The control panel path could not be verified from the development
 * environment (no outbound access to the provider), so it is checked against
 * the live site in task BS10 (docs/future-plans/bank-sync-tasks.md). If the
 * provider has moved it, this constant is the one place to correct.
 */
export const ENABLE_BANKING_CONTROL_PANEL_URL =
  'https://enablebanking.com/cp/applications';

/** The provider's public site. */
export const ENABLE_BANKING_SITE_URL = 'https://enablebanking.com';

/**
 * The privacy notice and terms of use templates that ship with Monize. Enable
 * Banking requires a URL for each when a Production application is registered;
 * a person running Monize only for themselves can enter these two. They are
 * templates, so anyone else's instance publishes its own version instead.
 */
export const BANK_SYNC_PRIVACY_TEMPLATE_URL =
  'https://github.com/kenlasko/monize/blob/main/docs/legal/bank-sync-privacy.md';
export const BANK_SYNC_TERMS_TEMPLATE_URL =
  'https://github.com/kenlasko/monize/blob/main/docs/legal/bank-sync-terms.md';

/** The terms that apply to the Enable Banking API, which Monize reaches through. */
export const ENABLE_BANKING_API_TERMS_URL = 'https://auth.enablebanking.com/terms';

/**
 * The labels of the Enable Banking "Add a new application" form, verbatim. The
 * control panel is English-only, so they stay English in every locale and are
 * constants rather than translations: the reader matches them by eye.
 */
export const ENABLE_BANKING_FORM_LABELS = {
  environment: "Choose your application's environment",
  keyOption: 'Choose how to generate a private RSA key',
  applicationName: 'Application name',
  redirectUrls: 'Allowed redirect URLs',
  description: 'Application description',
  email: 'Email for data protection matters',
  privacyUrl: 'Privacy URL of the application',
  termsUrl: 'Terms URL of the application',
} as const;

/**
 * What a person running Monize only for themselves enters in that form. The
 * environment and the key option are radio choices, so they are named rather
 * than pasted.
 */
export const ENABLE_BANKING_REGISTRATION = {
  environment: 'Production',
  keyOption: 'Generate in the browser (using SubtleCrypto) and export private key',
  applicationName: 'Monize',
  description:
    'Self-hosted personal finance manager (Monize) that reads my own bank accounts for personal budgeting. Read-only access.',
} as const;
