'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { getErrorMessage } from '@/lib/errors';

/**
 * Switches the trivia line beside the dashboard greeting on or off, on by
 * default. Off, the line goes and the daily job builds nothing and calls no
 * provider. Offered without a provider too: the line is then calculated, and
 * is still a thing a reader may not want.
 */
export function AiTriviaToggle({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations('settings.aiSettings.trivia');
  const stored = usePreferencesStore((s) => s.preferences?.aiTriviaEnabled);
  const updatePreferencesStore = usePreferencesStore((s) => s.updatePreferences);
  const enabled = stored !== false;
  const [saving, setSaving] = useState(false);

  const handleToggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    // Optimistic, so the dashboard reads the new setting at once.
    updatePreferencesStore({ aiTriviaEnabled: next });
    try {
      const updated = await userSettingsApi.updatePreferences({ aiTriviaEnabled: next });
      updatePreferencesStore(updated);
      toast.success(next ? t('enabled') : t('disabled'));
    } catch (error) {
      updatePreferencesStore({ aiTriviaEnabled: !next });
      toast.error(getErrorMessage(error, t('saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">{t('title')}</h2>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('subtitle')}</p>
        <ToggleSwitch
          checked={enabled}
          onChange={handleToggle}
          disabled={disabled || saving}
          label={t('toggleLabel')}
        />
      </div>
    </Card>
  );
}
