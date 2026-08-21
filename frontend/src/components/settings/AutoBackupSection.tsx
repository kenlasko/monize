'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { backupApi } from '@/lib/backupApi';
import { getErrorMessage } from '@/lib/errors';
import { resolveTimezone, isoToDatetimeLocal, formatDatetimeLocal } from '@/lib/utils';
import {
  AutoBackupCapability,
  AutoBackupSettings,
  UpdateAutoBackupSettingsData,
} from '@/types/auth';
import { usePreferencesStore } from '@/store/preferencesStore';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';

const FREQUENCY_OPTIONS = [
  { value: 'every6hours', labelKey: 'frequencyOptions.every6hours' },
  { value: 'every12hours', labelKey: 'frequencyOptions.every12hours' },
  { value: 'daily', labelKey: 'frequencyOptions.daily' },
  { value: 'weekly', labelKey: 'frequencyOptions.weekly' },
];

function formatDateTime(
  dateStr: string | null,
  timezone: string,
  dateFormat: string,
  timeFormat: '24h' | '12h',
  neverLabel: string,
): string {
  if (!dateStr) return neverLabel;
  const datetimeLocal = isoToDatetimeLocal(dateStr, timezone);
  return formatDatetimeLocal(datetimeLocal, dateFormat, timeFormat);
}

export function AutoBackupSection() {
  const t = useTranslations('settings.autoBackup');
  const tCommon = useTranslations('common');
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
  const [capability, setCapability] = useState<AutoBackupCapability | null>(
    null,
  );
  const [isCapabilityLoading, setIsCapabilityLoading] = useState(true);
  const storageUnavailable = capability?.available === false;
  const capabilityBlocksArming = isCapabilityLoading || storageUnavailable;
  // Use the persisted state, not the mutable toggle. A schedule that was already
  // armed stays switchable off even when storage is unavailable; a schedule that
  // was persisted disabled must not be armed while capability is unknown or
  // unavailable.
  const scheduleWasEnabled = settings?.enabled === true;
  const cannotArm = capabilityBlocksArming && !scheduleWasEnabled;
  const saveWouldArm = enabled && !scheduleWasEnabled;
  const saveBlockedByCapability = saveWouldArm && capabilityBlocksArming;

  // Deployment capability is a separate concern from the settings row: it is
  // re-probed on mount and after the two actions that can change the answer
  // (validating a folder, saving the folder), never on a manual run, which
  // cannot change where the server can write.
  const loadCapability = useCallback(async () => {
    try {
      const value = await backupApi.getAutoBackupCapability();
      setCapability(value);
    } catch {
      // Fail open: a capability probe we could not read is not a refusal. The
      // server still creates and probes the directory on save, so it stays the
      // authoritative guard; blocking here on a transient error or a backend
      // that predates this endpoint would strand the controls with no way back.
      setCapability(null);
    } finally {
      setIsCapabilityLoading(false);
    }
  }, []);

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

  useEffect(() => {
    loadCapability();
  }, [loadCapability]);

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
        // A folder that now validates may have flipped the deployment from
        // "no storage" to writable; re-probe so the banner and the arming
        // controls reflect it without waiting for a save.
        await loadCapability();
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
      // The saved folder is what the server now probes, so re-read capability
      // against it rather than leaving a stale mount-time answer on screen.
      await loadCapability();
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
    value: number | undefined,
  ) => {
    if (value !== undefined && value >= 0) {
      setter(value);
      markDirty();
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('heading')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('loadingText')}</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
        {t('heading')}
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
        {t('description')}
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
        {t('adminManagedNote')}
      </p>

      {storageUnavailable && (
        <div
          className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          role="status"
        >
          <p className="font-medium">{t('noStorage.title')}</p>
          <p className="mt-1">
            {t('noStorage.body', { folderPath: capability?.folderPath ?? '' })}
          </p>
        </div>
      )}

      {/* Enable toggle */}
      <div className="mb-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <ToggleSwitch
            checked={enabled}
            disabled={cannotArm}
            onChange={(v) => {
              setEnabled(v);
              markDirty();
            }}
            label={t('enableLabel')}
          />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
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
                {tCommon('cancel')}
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
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 break-all">
          {settings?.resolvedFolderPath
            ? t('perUserFolderHelpWithPath', { path: settings.resolvedFolderPath })
            : t('perUserFolderHelp')}
        </p>
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
          options={FREQUENCY_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
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
          className="w-40 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {frequency === 'every6hours' || frequency === 'every12hours'
            ? t('backupTimeHelpInterval', { timezone: userTimezone })
            : t('backupTimeHelpDaily', { timezone: userTimezone })}
        </p>
      </div>

      {/* Retention Policy */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
          {t('retention.heading')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
          {t('retention.description')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <NumericInput
              id="retention-daily"
              label={t('retention.dailyLabel')}
              decimalPlaces={0}
              min={0}
              max={365}
              value={retentionDaily}
              onChange={(value) => handleRetentionChange(setRetentionDaily, value)}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('retention.dailyHelp')}
            </p>
          </div>
          <div>
            <NumericInput
              id="retention-weekly"
              label={t('retention.weeklyLabel')}
              decimalPlaces={0}
              min={0}
              max={52}
              value={retentionWeekly}
              onChange={(value) => handleRetentionChange(setRetentionWeekly, value)}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('retention.weeklyHelp')}
            </p>
          </div>
          <div>
            <NumericInput
              id="retention-monthly"
              label={t('retention.monthlyLabel')}
              decimalPlaces={0}
              min={0}
              max={120}
              value={retentionMonthly}
              onChange={(value) => handleRetentionChange(setRetentionMonthly, value)}
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
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t('status.heading')}
          </h3>
          <dl className="space-y-1 text-sm">
            {settings.lastBackupAt && (
              <div className="flex justify-between">
                <dt className="text-gray-600 dark:text-gray-400">{t('status.lastBackup')}</dt>
                <dd className="font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  {formatDateTime(
                    settings.lastBackupAt,
                    userTimezone,
                    dateFormat,
                    timeFormat,
                    t('never'),
                  )}
                  {settings.lastBackupStatus === 'success' && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                      {t('status.success')}
                    </span>
                  )}
                  {settings.lastBackupStatus === 'partial' && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                      {t('status.partial')}
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
            {(settings.lastBackupStatus === 'failed' ||
              settings.lastBackupStatus === 'partial') &&
              settings.lastBackupError && (
                <div className="flex justify-between">
                  <dt className="text-gray-600 dark:text-gray-400">
                    {t('status.error')}
                  </dt>
                  <dd className="text-red-600 dark:text-red-400 text-right max-w-xs truncate">
                    {settings.lastBackupError}
                  </dd>
                </div>
              )}
            {settings.nextBackupAt && (
              <div className="flex justify-between">
                <dt className="text-gray-600 dark:text-gray-400">{t('status.nextBackup')}</dt>
                <dd className="font-medium text-gray-900 dark:text-gray-100">
                  {formatDateTime(
                    settings.nextBackupAt,
                    userTimezone,
                    dateFormat,
                    timeFormat,
                    t('never'),
                  )}
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
          disabled={isSaving || !isDirty || saveBlockedByCapability}
        >
          {isSaving ? t('savingButton') : t('saveButton')}
        </Button>
        {settings && settings.folderPath && (
          <Button
            variant="outline"
            onClick={handleRunNow}
            // Nowhere to write means a run can only produce a failure the banner
            // has already explained.
            disabled={isRunning || capabilityBlocksArming}
          >
            {isRunning ? t('runningButton') : t('runNowButton')}
          </Button>
        )}
      </div>
    </div>
  );
}
