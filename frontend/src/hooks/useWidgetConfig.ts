import { useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const logger = createLogger('useWidgetConfig');

export interface UseWidgetConfigResult<T> {
  /** The widget's settings: stored values merged over the defaults. */
  config: T;
  /**
   * Merge a partial update into this widget's settings and persist the whole
   * `dashboardWidgetConfig` map to the backend so it follows the user across
   * devices. Optimistic: the store updates immediately and reverts on failure.
   */
  updateConfig: (patch: Partial<T>) => Promise<void>;
}

/**
 * Per-widget settings backed by the cross-device `dashboardWidgetConfig`
 * preference (a map keyed by widget id). Each configurable dashboard widget
 * calls this with its own id and a stable module-level defaults object.
 *
 * Reads and writes go through the preferences store; the persisted map is the
 * source of truth (loaded from the backend on every session), so a timeframe or
 * account selection made on desktop shows up identically on mobile.
 */
export function useWidgetConfig<T extends object>(
  widgetId: string,
  defaults: T,
): UseWidgetConfigResult<T> {
  const t = useTranslations('dashboard');
  const stored = usePreferencesStore(
    (s) => s.preferences?.dashboardWidgetConfig?.[widgetId],
  );

  const config = useMemo(
    () => ({ ...defaults, ...(stored as Partial<T> | undefined) }),
    [defaults, stored],
  );

  const updateConfig = useCallback(
    async (patch: Partial<T>) => {
      // Read the freshest map straight from the store (not a render-time
      // closure) so near-simultaneous edits from two widgets don't clobber
      // each other.
      const state = usePreferencesStore.getState();
      const allBefore = state.preferences?.dashboardWidgetConfig ?? {};
      const nextWidget = {
        ...defaults,
        ...(allBefore[widgetId] as Partial<T> | undefined),
        ...patch,
      } as Record<string, unknown>;
      const nextAll = { ...allBefore, [widgetId]: nextWidget };

      // Optimistic update so the chart re-renders immediately.
      state.updatePreferences({ dashboardWidgetConfig: nextAll });

      try {
        const saved = await userSettingsApi.updatePreferences({
          dashboardWidgetConfig: nextAll,
        });
        usePreferencesStore.getState().updatePreferences({
          dashboardWidgetConfig: saved.dashboardWidgetConfig,
        });
      } catch (error) {
        logger.error('Failed to save widget config:', error);
        // Revert to the pre-edit map.
        usePreferencesStore.getState().updatePreferences({
          dashboardWidgetConfig: allBefore,
        });
        toast.error(getErrorMessage(error, t('widgets.configSaveFailed')));
      }
    },
    [defaults, widgetId, t],
  );

  return { config, updateConfig };
}
