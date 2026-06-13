'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { userSettingsApi } from '@/lib/user-settings';
import { getErrorMessage } from '@/lib/errors';

interface CustomInstructionsCardProps {
  initialInstructions: string;
  defaultPrompt: string;
  disabled?: boolean;
}

export function CustomInstructionsCard({
  initialInstructions,
  defaultPrompt,
  disabled = false,
}: CustomInstructionsCardProps) {
  const t = useTranslations('settings.aiProviders.customInstructions');
  const [instructions, setInstructions] = useState(initialInstructions);
  const [isSaving, setIsSaving] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await userSettingsApi.updatePreferences({
        aiImportInstructions: instructions,
      });
      toast.success(t('toasts.saved'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.saveFailed')));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 shadow-sm mb-6">
      <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
        {t('heading')}
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        {t('description')}
      </p>

      <textarea
        className="w-full h-32 p-3 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-blue-500 focus:border-blue-500 bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white mb-4 placeholder-gray-400 dark:placeholder-gray-500"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder={t('textareaPlaceholder')}
        disabled={disabled || isSaving}
      />

      <div className="flex justify-end mb-6">
        <button
          onClick={handleSave}
          disabled={disabled || isSaving}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md shadow-sm disabled:opacity-50 transition-colors"
        >
          {isSaving ? t('savingButton') : t('saveButton')}
        </button>
      </div>

      <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center justify-between w-full text-left text-sm font-semibold text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white focus:outline-none"
        >
          <span>{t('basePromptHeading')}</span>
          <span className="ml-2 transition-transform duration-200">
            {isExpanded ? '▲' : '▼'}
          </span>
        </button>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('basePromptDescription')}
        </p>

        {isExpanded && (
          <div className="mt-3 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded p-4 overflow-x-auto">
            <pre className="text-xs text-gray-800 dark:text-gray-300 font-mono whitespace-pre-wrap">
              {defaultPrompt}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
