'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  backupApi,
  randomSupportMultiplier,
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

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [enabledSections, setEnabledSections] = useState<Set<SupportBackupSection>>(
    new Set(SUPPORT_BACKUP_SECTIONS),
  );
  const [multiplier, setMultiplier] = useState<number>(() => randomSupportMultiplier());
  const [password, setPassword] = useState('');
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
    password: password.trim() ? password : undefined,
  });

  const toggleSection = (section: SupportBackupSection) => {
    setEnabledSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
    setPreview(null);
  };

  const toggleAccount = (id: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
    setPreview(null);
  };

  const regenerateMultiplier = () => {
    setMultiplier(randomSupportMultiplier());
    setPreview(null);
  };

  const multiplierValid =
    Number.isFinite(multiplier) && multiplier > 1 && !Number.isInteger(multiplier);

  const runPreview = async () => {
    if (!multiplierValid) return;
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
    if (!multiplierValid) return;
    setIsGenerating(true);
    try {
      const input = buildInput();
      const blob = await backupApi.supportExport(input);
      const url = URL.createObjectURL(blob);
      const today = new Date().toISOString().slice(0, 10);
      const filename = input.password
        ? `monize-support-backup-${today}.mzbe`
        : `monize-support-backup-${today}.json.gz`;
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
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
              <label key={section} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
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
                <label key={account.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
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
                  setPreview(null);
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

        {/* Password */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('passwordLabel')}
          </label>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('passwordPlaceholder')}
          />
        </div>

        {/* Preview */}
        {preview && (
          <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3 max-h-64 overflow-auto">
            {preview.samples.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('previewEmpty')}</p>
            ) : (
              preview.samples.map((sample) => (
                <div key={sample.table} className="mb-3 last:mb-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    {sample.table}
                  </p>
                  <pre className="mt-1 whitespace-pre-wrap break-all text-xs text-gray-600 dark:text-gray-300">
                    {t('previewBefore')}: {JSON.stringify(sample.before[0] ?? {})}
                    {'\n'}
                    {t('previewAfter')}: {JSON.stringify(sample.after[0] ?? {})}
                  </pre>
                </div>
              ))
            )}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="outline"
            onClick={runPreview}
            isLoading={isPreviewing}
            disabled={!multiplierValid}
          >
            {t('preview')}
          </Button>
          <Button onClick={runGenerate} isLoading={isGenerating} disabled={!multiplierValid}>
            {t('generate')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
