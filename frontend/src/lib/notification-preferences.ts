import apiClient from './api';
import type { NotificationCategory } from '@/types/notification';

/**
 * The categories the preference matrix exposes -- a subset of
 * {@link NotificationCategory}, mirroring the backend
 * `NOTIFICATION_PREFERENCE_CATEGORIES` and held equal by
 * `notification-preferences.contract.test.ts`. Only categories a producer
 * actually reads are shown, so a toggle never controls nothing. SYSTEM is the
 * admin infra alerts (backup, provider, SMTP): a push-only control (its email
 * is a severity-driven admin fan-out, not a user toggle).
 */
export const NOTIFICATION_PREFERENCE_CATEGORIES: readonly NotificationCategory[] =
  [
    'PAYMENTS',
    'BUDGETS',
    'SYSTEM',
    'BALANCES',
    'INVESTMENTS',
    'STRATEGIES',
    'BANK_SYNC',
    'BANK_SYNC_ACTIVITY',
  ];

/**
 * Which channels a matrix category exposes as a live control -- the client
 * mirror of the backend `CategoryChannelSupport`. A cell whose channel is
 * unsupported renders "not applicable" rather than a toggle, because the server
 * forces its resolved delivery off whatever the stored value.
 */
export interface CategoryChannelSupport {
  /** REPORT-mode email (digest). */
  email: boolean;
  /** NOTIFICATION-mode immediate email. */
  emailNotification: boolean;
  /** Web push. */
  push: boolean;
  /** UnifiedPush/ntfy (the same wire as push, to a distributor endpoint). */
  unifiedpush: boolean;
}

/**
 * The channels each matrix category exposes as a live control. Mirrors the
 * backend `NOTIFICATION_CATEGORY_CHANNELS` and is held equal to it by
 * `notification-preferences.contract.test.ts` -- but the authoritative value
 * for a given row is `supportedChannels` on the API response, which this only
 * shadows for a category whose row has not loaded.
 */
export const NOTIFICATION_CATEGORY_CHANNELS: Record<
  NotificationCategory,
  CategoryChannelSupport
> = {
  PAYMENTS: { email: true, emailNotification: true, push: true, unifiedpush: true },
  BUDGETS: { email: true, emailNotification: true, push: true, unifiedpush: true },
  SYSTEM: { email: false, emailNotification: false, push: true, unifiedpush: true },
  BALANCES: { email: true, emailNotification: true, push: true, unifiedpush: true },
  INVESTMENTS: { email: true, emailNotification: true, push: true, unifiedpush: true },
  STRATEGIES: { email: true, emailNotification: true, push: true, unifiedpush: true },
  // No report-mode digest for bank sync, so its report-email cell is not applicable.
  BANK_SYNC: { email: false, emailNotification: true, push: true, unifiedpush: true },
  BANK_SYNC_ACTIVITY: { email: false, emailNotification: true, push: true, unifiedpush: true },
};

/**
 * The cooldown windows the matrix offers, in minutes. `0` is the real "off";
 * the ceiling mirrors the backend `THROTTLE_MAX_MINUTES` (24h) -- a window
 * beyond a day suppresses so much it reads as "off" done wrong. Each option is
 * labelled by a full catalog string a translator can localise.
 */
export const THROTTLE_OPTION_MINUTES: readonly number[] = [
  0, 5, 15, 30, 60, 360, 1440,
];

/**
 * One category's stored channel state.
 *
 * `email` is the REPORT-mode email (batch/digest -- live, unthrottled).
 * `emailNotification` is the NOTIFICATION-mode email (immediate, one per event),
 * `push` the browser push, and `throttleMinutes` the cooldown that gates both
 * interrupting channels. All four are live (Phase 5).
 */
export interface NotificationChannelPreference {
  category: NotificationCategory;
  email: boolean;
  emailNotification: boolean;
  push: boolean;
  unifiedpush: boolean;
  throttleMinutes: number;
  /**
   * Which channels this category exposes as live controls, from the server.
   * A cell whose channel is not supported renders "not applicable" instead of a
   * toggle; absent on a response from before this field, so read it defensively.
   */
  supportedChannels?: CategoryChannelSupport;
}

/** A partial update: send only the field(s) that changed. */
export interface NotificationPreferencePatch {
  email?: boolean;
  emailNotification?: boolean;
  push?: boolean;
  unifiedpush?: boolean;
  throttleMinutes?: number;
}

export const notificationPreferencesApi = {
  list: async (): Promise<NotificationChannelPreference[]> => {
    const response = await apiClient.get<NotificationChannelPreference[]>(
      '/notifications/preferences',
    );
    return response.data;
  },

  update: async (
    category: NotificationCategory,
    patch: NotificationPreferencePatch,
  ): Promise<NotificationChannelPreference> => {
    const response = await apiClient.put<NotificationChannelPreference>(
      `/notifications/preferences/${category}`,
      patch,
    );
    return response.data;
  },

  /** The daily portfolio-movement threshold in percent, or null when off. */
  getPortfolioAlert: async (): Promise<{ movePercent: number | null }> => {
    const response = await apiClient.get<{ movePercent: number | null }>(
      '/notifications/preferences/portfolio-alert',
    );
    return response.data;
  },

  /** Set (number) or clear (null) the portfolio-movement threshold. */
  setPortfolioAlert: async (
    movePercent: number | null,
  ): Promise<{ movePercent: number | null }> => {
    const response = await apiClient.put<{ movePercent: number | null }>(
      '/notifications/preferences/portfolio-alert',
      { movePercent },
    );
    return response.data;
  },
};
