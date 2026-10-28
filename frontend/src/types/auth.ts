import type { ColorTheme } from '@/lib/color-themes';
import type { MapProvider } from '@/lib/contact-links';
import type { HiddenTableColumns } from '@/lib/hidden-columns';
import type { ViewDefaults } from '@/lib/view-defaults';

/**
 * The acting-context profile (`GET /auth/profile`, `GET /users/me`). While a
 * delegate is acting for an owner, the backend intentionally omits the owner's
 * credential-state fields (`hasPassword`, `mustChangePassword`,
 * `isDelegateOnly`, `backupEncryptionEnabled`) -- so they are optional here,
 * and any guard reading them must treat absence as "unknown", not as false.
 * Credential controls belong on the authenticated user's own profile from
 * `GET /auth/me-self`, which is `SelfUserProfile`.
 */
export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  authProvider: 'local' | 'oidc';
  hasPassword?: boolean;
  role: 'admin' | 'user';
  isActive: boolean;
  mustChangePassword?: boolean;
  isDelegateOnly?: boolean;
  backupEncryptionEnabled?: boolean;
  emailVerified?: boolean;
  // An email change waiting for the link sent to this address; the account's
  // email stays `email` until it is followed. Returned to the account holder only.
  pendingEmail?: string | null;
  createdAt: string;
  updatedAt: string;
  lastLogin?: string;
}

/**
 * The authenticated user's OWN profile (`GET /auth/me-self`, and the `user`
 * in auth responses): always a complete row, so the credential-state
 * booleans are guaranteed present.
 */
export type SelfUserProfile = User &
  Required<
    Pick<
      User,
      | 'hasPassword'
      | 'mustChangePassword'
      | 'isDelegateOnly'
      | 'backupEncryptionEnabled'
    >
  >;

export interface AdminUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  authProvider: 'local' | 'oidc';
  hasPassword: boolean;
  role: 'admin' | 'user';
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLogin: string | null;
}

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

/**
 * Administrators receive complete rows, so AdminUser keeps its
 * credential-state booleans *required* -- exactly as on the authenticated
 * user's own profile. AdminUser is deliberately not a full SelfUserProfile
 * (its identification fields are nullable, and the admin list omits
 * delegate-only rows), so the shared contract asserted here is exactly the
 * credential state. This is a frontend-side consistency check between two
 * frontend types; the backend's own return annotations are the cross-package
 * half of the guarantee.
 */
type _AdminUserCarriesRequiredCredentialState = Assert<
  IsAssignable<
    Pick<AdminUser, 'hasPassword' | 'mustChangePassword'>,
    Pick<SelfUserProfile, 'hasPassword' | 'mustChangePassword'>
  >
>;

export interface LoginCredentials {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface RegisterData {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  /**
   * Temporary password supplied by the registrant when their email is
   * already a delegate row (so they can claim and upgrade it into a full
   * account, preserving the existing delegate id).
   */
  currentPassword?: string;
}

export interface AuthResponse {
  user?: User;
  requires2FA?: boolean;
  tempToken?: string;
  /** Login was rejected because the account's email is not yet verified. */
  emailNotVerified?: boolean;
  /** Registration succeeded but the user must verify their email before logging in. */
  verificationRequired?: boolean;
  /**
   * 2FA sign-in only, and only when it was completed with a backup code (the
   * server omits both fields for an authenticator code). The client then sends
   * the user to Settings > Security to reset their 2FA.
   */
  usedBackupCode?: boolean;
  /** Backup codes left after the one this sign-in consumed. */
  backupCodesRemaining?: number;
}

/** How a 2FA sign-in was completed, as far as the next page cares. */
export interface TwoFactorSignInDetails {
  usedBackupCode: boolean;
  /** `null` when the server did not say (never for a backup-code sign-in). */
  backupCodesRemaining: number | null;
}

export interface TwoFactorSetupResponse {
  secret: string;
  qrCodeDataUrl: string;
  otpauthUrl: string;
}

export interface BackupCodesResponse {
  codes: string[];
}

export interface TrustedDevice {
  id: string;
  deviceName: string;
  ipAddress: string | null;
  lastUsedAt: string;
  expiresAt: string;
  createdAt: string;
  isCurrent?: boolean;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface UserPreferences {
  reportingBasis?: 'cash' | 'accrual';
  accrualEnabled?: boolean;
  userId: string;
  defaultCurrency: string;
  dateFormat: string; // 'browser' = use browser locale
  numberFormat: string; // 'browser' = use browser locale
  theme: 'light' | 'dark' | 'system';
  colorTheme: ColorTheme;
  timezone: string; // 'browser' = use browser timezone
  notificationEmail: boolean;
  twoFactorEnabled: boolean;
  gettingStartedDismissed: boolean;
  weekStartsOn: number; // 0=Sunday, 1=Monday, ..., 6=Saturday
  budgetDigestEnabled: boolean;
  budgetDigestDay: 'MONDAY' | 'FRIDAY';
  favouriteReportIds: string[];
  dashboardWidgets: string[]; // ordered visible widget ids; empty = default layout
  dashboardWidgetConfig: Record<string, Record<string, unknown>>; // per-widget settings keyed by widget id
  hiddenTableColumns: HiddenTableColumns; // hidden column ids keyed by table kind
  // Account-level fallbacks for the browser-local view settings. Optional: a
  // preferences copy cached before the field existed has none.
  viewDefaults?: ViewDefaults;
  showCreatedAt: boolean;
  timeFormat: '24h' | '12h';
  preferredExchanges: string[];
  defaultQuoteProvider: 'yahoo' | 'msn' | 'lse' | 'deutsche_boerse';
  /** Which map service an address link opens; 'device' decides from the platform. */
  defaultMapProvider: MapProvider;
  recentTransactionsLimit: number;
  aiBubbleEnabled: boolean;
  showWhatsNew: boolean;
  /**
   * Strict reconciled lock. False (the default) keeps Money's behaviour: the
   * transaction form warns before an edit that would move a reconciled row's
   * date or amount and then lets it through. True makes the server refuse the
   * write outright -- an edit, a delete, or a status change away from
   * RECONCILED -- so the way to make one is to turn this off in Settings.
   */
  lockReconciledTransactions: boolean;
  /**
   * Opt-in: look up a new payee's website, address, email and phone through
   * the configured AI provider (prefilled for review in the payee form;
   * written in the background for a name-only create).
   */
  payeeContactLookupEnabled: boolean;
  language: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The deployment's automatic-backup policy, as the admin surface reads it.
 *
 * Not one account's row: it has no `userId`, because the thing it describes has
 * no owner. The name is kept because every consumer of it is this one screen.
 */
export interface AutoBackupSettings {
  enabled: boolean;
  folderPath: string;
  /**
   * Folder this user's backup files actually land in --
   * `<folderPath>/<ab>/<cd>/<userId>`. Server-computed and read-only; absent
   * when the configured base folder is unusable.
   */
  resolvedFolderPath?: string;
  frequency: 'daily' | 'every12hours' | 'every6hours' | 'weekly';
  backupTime: string;
  timezone: string;
  retentionDaily: number;
  retentionWeekly: number;
  retentionMonthly: number;
  lastBackupAt: string | null;
  lastBackupStatus: 'success' | 'partial' | 'failed' | null;
  lastBackupError: string | null;
  nextBackupAt: string | null;
  /**
   * How many active accounts this deployment's policy governs, and how many of
   * them currently hold an armed schedule.
   *
   * Server-computed and read-only, present only on the admin policy surface.
   * Two numbers rather than one because a single one could only have been
   * `accountCount`, which states coverage the deployment may not have: an
   * account whose reconcile failed is still an account the policy governs.
   * They match on a settled deployment.
   */
  accountCount?: number;
  scheduledAccountCount?: number;
}

/**
 * Whether the deployment has somewhere to write automatic backups, and where.
 *
 * This is a deployment capability, not a field from the acting-context user
 * profile or the user's settings row.
 */
export interface AutoBackupCapability {
  available: boolean;
  /** The store in display form: a directory, or a bucket and key prefix. */
  folderPath: string;
  /**
   * False when the bound store has no location to choose -- an object store's
   * bucket and prefix are the deployment's. The folder picker is hidden on it
   * rather than offering a control whose endpoints refuse.
   */
  locationSelectable: boolean;
  /**
   * Which store is bound: `local` for a container directory, `s3` for an
   * S3-compatible bucket. Named rather than inferred from
   * `locationSelectable`, which answers "may I choose a location" and not
   * "where do my backups live".
   */
  storageProvider: string;
  /** How many artifacts the current store already holds for the caller. */
  artifactCount?: number;
  /** Operator-facing detail when the capability is unavailable. */
  reason?: string;
}

/**
 * What one "back up every account now" run did.
 *
 * Counts rather than a filename: the run covers every account on the
 * deployment, and `filename` names only the artifact written for the account
 * that pressed the button -- absent when that account's own backup was skipped
 * or failed.
 */
export interface AutoBackupRunResult {
  message: string;
  usersRequested: number;
  usersBackedUp: number;
  usersSkipped: number;
  usersFailed: number;
  usersPartial: number;
  filename?: string;
}

export interface UpdateAutoBackupSettingsData {
  enabled?: boolean;
  folderPath?: string;
  frequency?: AutoBackupSettings['frequency'];
  backupTime?: string;
  timezone?: string;
  retentionDaily?: number;
  retentionWeekly?: number;
  retentionMonthly?: number;
}

export interface UpdateProfileData {
  firstName?: string;
  lastName?: string;
  email?: string;
  currentPassword?: string;
}

export interface UpdatePreferencesData {
  reportingBasis?: 'cash' | 'accrual';
  accrualEnabled?: boolean;
  defaultCurrency?: string;
  dateFormat?: string;
  numberFormat?: string;
  theme?: 'light' | 'dark' | 'system';
  colorTheme?: ColorTheme;
  timezone?: string;
  notificationEmail?: boolean;
  gettingStartedDismissed?: boolean;
  weekStartsOn?: number;
  budgetDigestEnabled?: boolean;
  budgetDigestDay?: 'MONDAY' | 'FRIDAY';
  favouriteReportIds?: string[];
  dashboardWidgets?: string[];
  dashboardWidgetConfig?: Record<string, Record<string, unknown>>;
  hiddenTableColumns?: HiddenTableColumns;
  viewDefaults?: ViewDefaults;
  showCreatedAt?: boolean;
  timeFormat?: '24h' | '12h';
  preferredExchanges?: string[];
  defaultQuoteProvider?: 'yahoo' | 'msn' | 'lse' | 'deutsche_boerse';
  defaultMapProvider?: MapProvider;
  recentTransactionsLimit?: number;
  aiBubbleEnabled?: boolean;
  showWhatsNew?: boolean;
  lockReconciledTransactions?: boolean;
  payeeContactLookupEnabled?: boolean;
  language?: string;
}

export interface ChangePasswordData {
  currentPassword: string;
  newPassword: string;
}

export interface PersonalAccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  isRevoked: boolean;
  createdAt: string;
}

export interface CreatePatData {
  name: string;
  scopes?: string;
  expiresAt?: string;
}

export interface CreatePatResponse extends PersonalAccessToken {
  token: string;
}
