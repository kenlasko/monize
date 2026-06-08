'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { backupApi } from '@/lib/backupApi';
import { getErrorMessage } from '@/lib/errors';
import { resolveTimezone, isoToDatetimeLocal, formatDatetimeLocal } from '@/lib/utils';
import { AutoBackupSettings, UpdateAutoBackupSettingsData } from '@/types/auth';
import { usePreferencesStore } from '@/store/preferencesStore';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';

const FREQUENCY_OPTIONS = [
  { value: 'every6hours', label: 'Every 6 Hours' },
  { value: 'every12hours', label: 'Every 12 Hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

function formatDateTime(
  dateStr: string | null,
  timezone: string,
  dateFormat: string,
  timeFormat: '24h' | '12h',
): string {
  if (!dateStr) return 'Never';
  const datetimeLocal = isoToDatetimeLocal(dateStr, timezone);
  return formatDatetimeLocal(datetimeLocal, dateFormat, timeFormat);
}

export function AutoBackupSection() {
  const t = useTranslations('settings.autoBackup');
  const preferences = usePreferencesStore((s) => s.preferences);
  const userTimezone = resolveTimezone(preferences?.timezone);
  const dateFormat = preferences?.dateFormat || 'browser';
  const timeFormat = preferences?.timeFormat || '24h';

  const [settings, setSettings] = useState<AutoBackupSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [folderValid, setFolderValid] = useState<boolean | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);

  // Local form state
  const [enabled, setEnabled] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [frequency, setFrequency] = useState<AutoBackupSettings['frequency']>('daily');
  const [retentionDaily, setRetentionDaily] = useState(7);
  const [retentionWeekly, setRetentionWeekly] = useState(4);
  const [backupTime, setBackupTime] = useState('02:00');
  const [retentionMonthly, setRetentionMonthly] = useState(6);
  const [isDirty, setIsDirty] = useState(false);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isBrowseOpen, setIsBrowseOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('/');
  const [browseEntries, setBrowseEntries] = useState<string[]>([]);

  const loadSettings = useCallback(async () => {
    try {
      const data = await backupApi.getAutoBackupSettings();
      setSettings(data);
      setEnabled(data.enabled);
      setFolderPath(data.folderPath);
      setFrequency(data.frequency);
      setBackupTime(data.backupTime);
      setRetentionDaily(data.retentionDaily);
      setRetentionWeekly(data.retentionWeekly);
      setRetentionMonthly(data.retentionMonthly);
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.loadFailed')));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleValidateFolder = async () => {
    if (!folderPath.trim()) {
      setFolderValid(false);
      setFolderError(t('folderErrors.required'));
      return;
    }
    setIsValidating(true);
    setFolderValid(null);
    setFolderError(null);
    try {
      const result = await backupApi.validateFolder(folderPath);
      setFolderValid(result.valid);
      setFolderError(result.error ?? null);
      if (result.valid) {
        toast.success(t('toasts.folderValid'));
      } else {
        toast.error(result.error ?? t('folderErrors.validationFailed'));
      }
    } catch (error) {
      setFolderValid(false);
      setFolderError(getErrorMessage(error, t('folderErrors.validationError')));
    } finally {
      setIsValidating(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const data: UpdateAutoBackupSettingsData = {
        enabled,
        folderPath,
        frequency,
        backupTime,
        timezone: userTimezone,
        retentionDaily,
        retentionWeekly,
        retentionMonthly,
      };
      const updated = await backupApi.updateAutoBackupSettings(data);
      setSettings(updated);
      setIsDirty(false);
      toast.success(t('toasts.saved'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.saveFailed')));
    } finally {
      setIsSaving(false);
    }
  };

  const handleRunNow = async () => {
    setIsRunning(true);
    try {
      const result = await backupApi.runAutoBackup();
      toast.success(t('toasts.backupCreated', { filename: result.filename }));
      await loadSettings();
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.runFailed')));
      await loadSettings();
    } finally {
      setIsRunning(false);
    }
  };

  const markDirty = () => setIsDirty(true);

  const handleBrowse = async (path: string) => {
    setIsBrowsing(true);
    setIsBrowseOpen(true);
    try {
      const result = await backupApi.browseFolders(path);
      setBrowsePath(result.current);
      setBrowseEntries(result.directories);
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.browseFailed')));
    } finally {
      setIsBrowsing(false);
    }
  };

  const handleOpenBrowse = () => {
    const startPath = folderPath.trim() || '/';
    handleBrowse(startPath);
  };

  const handleSelectBrowsedFolder = () => {
    setFolderPath(browsePath);
    setIsBrowseOpen(false);
    setBrowseEntries([]);
    setFolderValid(null);
    setFolderError(null);
    markDirty();
  };

  const handleCloseBrowse = () => {
    setIsBrowseOpen(false);
    setBrowseEntries([]);
  };

  const handleRetentionChange = (
    setter: (v: number) => void,
    value: string,
  ) => {
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= 0) {
      setter(num);
      markDirty();
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          {t('heading')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('loadingText')}</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
        {t('heading')}
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
        {t('description')}
      </p>

      {/* Enable toggle */}
      <div className="mb-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <ToggleSwitch
            checked={enabled}
            onChange={(v) => {
              setEnabled(v);
              markDirty();
            }}
            label={t('enableLabel')}
          />
          <span className="text-sm font-medium text-gray-900 dark:text-white">
            {t('enableLabel')}
          </span>
        </label>
      </div>

      {/* Folder path */}
      <div className="mb-6">
        <label
          htmlFor="auto-backup-folder"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          {t('backupFolderLabel')}
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1">
            <Input
              id="auto-backup-folder"
              value={folderPath}
              onChange={(e) => {
                setFolderPath(e.target.value);
                setFolderValid(null);
                setFolderError(null);
                markDirty();
              }}
              placeholder={t('backupFolderPlaceholder')}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleOpenBrowse}
            >
              {t('browseButton')}
            </Button>
            <Button
              variant="outline"
              onClick={handleValidateFolder}
              disabled={isValidating || !folderPath.trim()}
            >
              {isValidating ? t('validatingButton') : t('validateButton')}
            </Button>
          </div>
        </div>
        {/* Browse dialog */}
        {isBrowseOpen && (
          <div className="mt-2 border border-gray-200 dark:border-gray-600 rounded-lg p-3 bg-gray-50 dark:bg-gray-700/50">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 break-all mb-2">
              {browsePath}
            </p>
            <div className="flex gap-1 mb-2">
              <Button
                variant="outline"
                onClick={handleSelectBrowsedFolder}
              >
                {t('selectThisFolder')}
              </Button>
              <Button
                variant="outline"
                onClick={handleCloseBrowse}
              >
                Cancel
              </Button>
            </div>
            <div className="max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-800">
              {browsePath !== '/' && (
                <button
                  type="button"
                  onClick={() => {
                    const parent = browsePath.replace(/\/[^/]+\/?$/, '') || '/';
                    handleBrowse(parent);
                  }}
                  disabled={isBrowsing}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center gap-2"
                >
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  ..
                </button>
              )}
              {browseEntries.map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => handleBrowse(`${browsePath === '/' ? '' : browsePath}/${dir}`)}
                  disabled={isBrowsing}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center gap-2"
                >
                  <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  {dir}
                </button>
              ))}
              {browseEntries.length === 0 && (
                <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 italic">
                  {t('noSubdirectories')}
                </p>
              )}
            </div>
          </div>
        )}
        {folderValid === true && (
          <p className="mt-1 text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {t('folderValid')}
          </p>
        )}
        {folderValid === false && folderError && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{folderError}</p>
        )}
      </div>

      {/* Frequency */}
      <div className="mb-6">
        <Select
          label={t('frequencyLabel')}
          value={frequency}
          onChange={(e) => {
            setFrequency(e.target.value as AutoBackupSettings['frequency']);
            markDirty();
          }}
          options={FREQUENCY_OPTIONS}
        />
      </div>

      {/* Backup Time */}
      <div className="mb-6">
        <label
          htmlFor="backup-time"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          {t('backupTimeLabel', { timezone: userTimezone })}
        </label>
        <input
          id="backup-time"
          type="time"
          value={backupTime}
          onChange={(e) => {
            setBackupTime(e.target.value);
            markDirty();
          }}
          className="w-40 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {frequency === 'every6hours' || frequency === 'every12hours'
            ? t('backupTimeHelpInterval', { timezone: userTimezone })
            : t('backupTimeHelpDaily', { timezone: userTimezone })}
        </p>
      </div>

      {/* Retention Policy */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
          {t('retention.heading')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
          {t('retention.description')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="retention-daily"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('retention.dailyLabel')}
            </label>
            <input
              id="retention-daily"
              type="number"
              min={0}
              max={365}
              value={retentionDaily}
              onChange={(e) => handleRetentionChange(setRetentionDaily, e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('retention.dailyHelp')}
            </p>
          </div>
          <div>
            <label
              htmlFor="retention-weekly"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('retention.weeklyLabel')}
            </label>
            <input
              id="retention-weekly"
              type="number"
              min={0}
              max={52}
              value={retentionWeekly}
              onChange={(e) => handleRetentionChange(setRetentionWeekly, e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('retention.weeklyHelp')}
            </p>
          </div>
          <div>
            <label
              htmlFor="retention-monthly"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('retention.monthlyLabel')}
            </label>
            <input
              id="retention-monthly"
              type="number"
              min={0}
              max={120}
              value={retentionMonthly}
              onChange={(e) => handleRetentionChange(setRetentionMonthly, e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('retention.monthlyHelp')}
            </p>
          </div>
        </div>
      </div>

      {/* Status Section */}
      {settings && (settings.lastBackupAt || settings.nextBackupAt) && (
        <div className="mb-6 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
            {t('status.heading')}
          </h3>
          <dl className="space-y-1 text-sm">
            {settings.lastBackupAt && (
              <div className="flex justify-between">
                <dt className="text-gray-600 dark:text-gray-400">{t('status.lastBackup')}</dt>
                <dd className="font-medium text-gray-900 dark:text-white flex items-center gap-2">
                  {formatDateTime(settings.lastBackupAt, userTimezone, dateFormat, timeFormat)}
                  {settings.lastBackupStatus === 'success' && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                      {t('status.success')}
                    </span>
                  )}
                  {settings.lastBackupStatus === 'failed' && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300">
                      {t('status.failed')}
                    </span>
                  )}
                </dd>
              </div>
            )}
            {settings.lastBackupStatus === 'failed' && settings.lastBackupError && (
              <div className="flex justify-between">
                <dt className="text-gray-600 dark:text-gray-400">{t('status.error')}</dt>
                <dd className="text-red-600 dark:text-red-400 text-right max-w-xs truncate">
                  {settings.lastBackupError}
                </dd>
              </div>
            )}
            {settings.nextBackupAt && (
              <div className="flex justify-between">
                <dt className="text-gray-600 dark:text-gray-400">{t('status.nextBackup')}</dt>
                <dd className="font-medium text-gray-900 dark:text-white">
                  {formatDateTime(settings.nextBackupAt, userTimezone, dateFormat, timeFormat)}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          onClick={handleSave}
          disabled={isSaving || !isDirty}
        >
          {isSaving ? t('savingButton') : t('saveButton')}
        </Button>
        {settings && settings.folderPath && (
          <Button
            variant="outline"
            onClick={handleRunNow}
            disabled={isRunning}
          >
            {isRunning ? t('runningButton') : t('runNowButton')}
          </Button>
        )}
      </div>
    </div>
  );
}
