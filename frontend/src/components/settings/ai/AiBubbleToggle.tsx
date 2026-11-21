'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { getErrorMessage } from '@/lib/errors';
import { CARD_CLASS } from '@/components/ui/Card';

interface AiBubbleToggleProps {
  disabled?: boolean;
  /**
   * Whether this user has an AI provider at all. The bubble has nothing to
   * answer with without one, and hides itself on the same fact, so the setting
   * is not offered rather than offered and silently ineffective -- the provider
   * list below is where that is fixed.
   */
  aiConfigured?: boolean;
}

/**
 * Opt-in toggle for the app-wide floating AI chat bubble. The bubble reads the
 * same `aiBubbleEnabled` preference from the store, so flipping this switch
 * shows/hides it everywhere immediately (optimistic), reverting on save error.
 */
export function AiBubbleToggle({
  disabled = false,
  aiConfigured = false,
}: AiBubbleToggleProps) {
  const t = useTranslations('settings.aiSettings.bubble');
  const preferences = usePreferencesStore((s) => s.preferences);
  const updatePreferencesStore = usePreferencesStore((s) => s.updatePreferences);
  const enabled = preferences?.aiBubbleEnabled ?? false;
  const [saving, setSaving] = useState(false);

  const handleToggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    // Optimistic: update the shared store so the bubble appears/disappears now.
    updatePreferencesStore({ aiBubbleEnabled: next });
    try {
      const updated = await userSettingsApi.updatePreferences({
        aiBubbleEnabled: next,
      });
      updatePreferencesStore(updated);
      toast.success(next ? t('enabled') : t('disabled'));
    } catch (error) {
      // Revert the optimistic change on failure.
      updatePreferencesStore({ aiBubbleEnabled: !next });
      toast.error(getErrorMessage(error, t('saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  if (!aiConfigured) return null;

  return (
    <div className={`${CARD_CLASS} p-6 mb-6`}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('title')}
      </h2>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('subtitle')}</p>
        <ToggleSwitch
          checked={enabled}
          onChange={handleToggle}
          disabled={disabled || saving}
          label={t('toggleLabel')}
        />
      </div>
    </div>
  );
}
