'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { JsonHighlight } from '@/components/ui/JsonHighlight';
import {
  backupApi,
  randomSupportMultiplier,
  randomSupportPassword,
  SUPPORT_BACKUP_SECTIONS,
  SupportBackupInput,
  SupportBackupPreview,
  SupportBackupSection,
} from '@/lib/backupApi';
import { accountsApi } from '@/lib/accounts';
import { getErrorMessage } from '@/lib/errors';
import type { Account } from '@/types/account';

interface SupportBackupModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SupportBackupModal({ isOpen, onClose }: SupportBackupModalProps) {
  const t = useTranslations('settings.supportBackup');
  const tc = useTranslations('common');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [enabledSections, setEnabledSections] = useState<Set<SupportBackupSection>>(
    new Set(SUPPORT_BACKUP_SECTIONS),
  );
  const [multiplier, setMultiplier] = useState<number>(() => randomSupportMultiplier());
  const [password, setPassword] = useState<string>(() => randomSupportPassword());
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [preview, setPreview] = useState<SupportBackupPreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    accountsApi
      .getAll(true)
      .then((data) => {
        if (!cancelled) setAccounts(data);
      })
      .catch(() => {
        // The account scope is optional; the modal still works without the list.
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const buildInput = (): SupportBackupInput => ({
    multiplier,
    sections: SUPPORT_BACKUP_SECTIONS.filter((s) => enabledSections.has(s)),
    accountIds: selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    password,
  });

  const invalidatePreview = () => setPreview(null);

  const toggleSection = (section: SupportBackupSection) => {
    setEnabledSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
    invalidatePreview();
  };

  const toggleAccount = (id: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
    invalidatePreview();
  };

  const regenerateMultiplier = () => {
    setMultiplier(randomSupportMultiplier());
    invalidatePreview();
  };

  const multiplierValid =
    Number.isFinite(multiplier) && multiplier > 1 && !Number.isInteger(multiplier);
  const passwordValid = password.trim().length >= 8;
  const canRun = multiplierValid && passwordValid;

  const runPreview = async () => {
    if (!canRun) return;
    setIsPreviewing(true);
    try {
      setPreview(await backupApi.supportExportPreview(buildInput()));
    } catch (err) {
      toast.error(getErrorMessage(err, t('previewFailed')));
    } finally {
      setIsPreviewing(false);
    }
  };

  const runGenerate = async () => {
    if (!canRun) return;
    setIsGenerating(true);
    try {
      const blob = await backupApi.supportExport(buildInput());
      const url = URL.createObjectURL(blob);
      const today = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      // Always encrypted, so always the encrypted-envelope extension
      link.download = `monize-support-backup-${today}.mzbe`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success(t('generatedToast'));
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err, t('generateFailed')));
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="2xl">
      <div className="p-6 space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('title')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('howItWorks')}
          </p>
        </div>

        {/* Sections */}
        <fieldset>
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('sectionsLabel')}
          </legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {SUPPORT_BACKUP_SECTIONS.map((section) => (
              <label
                key={section}
                className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
              >
                <input
                  type="checkbox"
                  checked={enabledSections.has(section)}
                  onChange={() => toggleSection(section)}
                  className="rounded border-gray-300 dark:border-gray-600"
                />
                {t(`sections.${section}`)}
              </label>
            ))}
          </div>
        </fieldset>

        {/* Account scope */}
        {accounts.length > 0 && (
          <fieldset>
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('accountsLabel')}
            </legend>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              {t('accountsHint')}
            </p>
            <div className="max-h-40 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 p-2 space-y-1">
              {accounts.map((account) => (
                <label
                  key={account.id}
                  className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                >
                  <input
                    type="checkbox"
                    checked={selectedAccountIds.includes(account.id)}
                    onChange={() => toggleAccount(account.id)}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  {account.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {/* Date range */}
        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('dateRangeLabel')}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {t('dateRangeHint')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <DateInput
              label={t('dateFromLabel')}
              value={dateFrom}
              onDateChange={(date) => {
                setDateFrom(date);
                invalidatePreview();
              }}
            />
            <DateInput
              label={t('dateToLabel')}
              value={dateTo}
              onDateChange={(date) => {
                setDateTo(date);
                invalidatePreview();
              }}
            />
          </div>
        </div>

        {/* Multiplier */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('multiplierLabel')}
          </label>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                type="number"
                step="0.00001"
                min="1.00001"
                value={String(multiplier)}
                onChange={(e) => {
                  setMultiplier(Number(e.target.value));
                  invalidatePreview();
                }}
                error={!multiplierValid ? t('multiplierInvalid') : undefined}
              />
            </div>
            <Button variant="outline" onClick={regenerateMultiplier}>
              {t('regenerate')}
            </Button>
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('multiplierHint')}
          </p>
        </div>

        {/* Encryption password: required, pre-filled random, editable */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('passwordLabel')}
          </label>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={!passwordValid ? t('passwordInvalid') : undefined}
              />
            </div>
            <Button variant="outline" onClick={() => setPassword(randomSupportPassword())}>
              {t('regenerate')}
            </Button>
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('passwordHint')}
          </p>
        </div>

        {/* Preview */}
        {preview && (
          <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3 max-h-72 overflow-auto">
            {preview.samples.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('previewEmpty')}</p>
            ) : (
              preview.samples.map((sample) => (
                <div key={sample.table} className="mb-4 last:mb-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
                    {sample.table}
                  </p>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    {t('previewBefore')}
                  </p>
                  <JsonHighlight value={sample.before[0] ?? {}} className="mb-2" />
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    {t('previewAfter')}
                  </p>
                  <JsonHighlight value={sample.after[0] ?? {}} />
                </div>
              ))
            )}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button
            variant="outline"
            onClick={runPreview}
            isLoading={isPreviewing}
            disabled={!canRun}
          >
            {t('preview')}
          </Button>
          <Button onClick={runGenerate} isLoading={isGenerating} disabled={!canRun}>
            {t('generate')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
