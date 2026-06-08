'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { accountsApi } from '@/lib/accounts';
import { usePreferencesStore } from '@/store/preferencesStore';
import { getExportDateFormatOptions } from '@/lib/constants';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('AccountExportModal');

interface AccountExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountId: string;
  accountName: string;
}

function resolveBrowserDateFormat(): string {
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(new Date(2024, 11, 31));
    const order = parts
      .filter((p) => p.type === 'year' || p.type === 'month' || p.type === 'day')
      .map((p) => p.type);

    const sep = parts.find((p) => p.type === 'literal')?.value || '/';

    if (order[0] === 'year' && order[1] === 'month' && order[2] === 'day') {
      return `YYYY${sep}MM${sep}DD`;
    }
    if (order[0] === 'month' && order[1] === 'day' && order[2] === 'year') {
      return `MM${sep}DD${sep}YYYY`;
    }
    if (order[0] === 'day' && order[1] === 'month' && order[2] === 'year') {
      return `DD${sep}MM${sep}YYYY`;
    }
    return 'YYYY-MM-DD';
  } catch {
    return 'YYYY-MM-DD';
  }
}

export function AccountExportModal({
  isOpen,
  onClose,
  accountId,
  accountName,
}: AccountExportModalProps) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const userDateFormat = usePreferencesStore((state) => state.preferences?.dateFormat) || 'browser';

  const FORMAT_OPTIONS = [
    { value: 'csv', label: 'CSV' },
    { value: 'qif', label: 'QIF' },
  ];

  const SPLIT_OPTIONS = [
    { value: 'expand', label: t('exportModal.splitOptions.expand') },
    { value: 'collapse', label: t('exportModal.splitOptions.collapse') },
  ];

  const [format, setFormat] = useState<'csv' | 'qif'>('csv');
  const [splitMode, setSplitMode] = useState('expand');
  const [dateFormat, setDateFormat] = useState(userDateFormat);
  const [customDateFormat, setCustomDateFormat] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    if (isExporting) return;

    let resolvedDateFormat: string;
    if (dateFormat === 'browser') {
      resolvedDateFormat = resolveBrowserDateFormat();
    } else if (dateFormat === 'custom') {
      if (!customDateFormat.trim()) {
        toast.error(t('exportModal.customDateFormatEmpty'));
        return;
      }
      resolvedDateFormat = customDateFormat.trim();
    } else {
      resolvedDateFormat = dateFormat;
    }

    setIsExporting(true);
    try {
      await accountsApi.exportAccount(accountId, format, {
        expandSplits: format === 'csv' ? splitMode === 'expand' : undefined,
        dateFormat: resolvedDateFormat,
      });
      toast.success(t('exportModal.exportedAs', { format: format.toUpperCase() }));
      onClose();
    } catch (error) {
      logger.error('Export failed', error);
      toast.error(getErrorMessage(error, 'Failed to export account'));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="sm">
      <div className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('exportModal.title', { name: accountName })}
        </h2>

        <div className="space-y-4">
          <Select
            label={t('exportModal.format')}
            options={FORMAT_OPTIONS}
            value={format}
            onChange={(e) => setFormat(e.target.value as 'csv' | 'qif')}
          />

          {format === 'csv' && (
            <Select
              label={t('exportModal.splitTransactions')}
              options={SPLIT_OPTIONS}
              value={splitMode}
              onChange={(e) => setSplitMode(e.target.value)}
            />
          )}

          <Select
            label={t('exportModal.dateFormat')}
            options={getExportDateFormatOptions(tc)}
            value={dateFormat}
            onChange={(e) => setDateFormat(e.target.value)}
          />

          {dateFormat === 'custom' && (
            <div>
              <Input
                label={t('exportModal.customFormat')}
                value={customDateFormat}
                onChange={(e) => setCustomDateFormat(e.target.value)}
                placeholder="e.g. DD.MM.YYYY"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('exportModal.customFormatHelp')}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-6">
          <Button variant="outline" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleExport} isLoading={isExporting}>
            {t('exportModal.exportButton')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
