'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { payeesApi } from '@/lib/payees';
import { DeactivationCandidate } from '@/types/payee';
import toast from 'react-hot-toast';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useDateFormat } from '@/hooks/useDateFormat';

const logger = createLogger('DeactivateUnusedPayees');

interface DeactivateUnusedPayeesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function DeactivateUnusedPayeesDialog({
  isOpen,
  onClose,
  onSuccess,
}: DeactivateUnusedPayeesDialogProps) {
  const t = useTranslations('payees');
  const tc = useTranslations('common');
  const { formatDate: formatUserDate } = useDateFormat();
  const [maxTransactions, setMaxTransactions] = useState(3);
  const [monthsUnused, setMonthsUnused] = useState(12);
  const [candidates, setCandidates] = useState<DeactivationCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [hasPreviewLoaded, setHasPreviewLoaded] = useState(false);

  const loadPreview = useCallback(async () => {
    setIsLoading(true);
    try {
      const results = await payeesApi.getDeactivationPreview({
        maxTransactions,
        monthsUnused,
      });
      setCandidates(results);
      setSelectedIds(new Set(results.map(c => c.payeeId)));
      setHasPreviewLoaded(true);
    } catch (error) {
      toast.error(getErrorMessage(error, t('deactivateUnused.toasts.loadFailed')));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [maxTransactions, monthsUnused, t]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setCandidates([]);
      setSelectedIds(new Set());
      setHasPreviewLoaded(false);
    }
  }, [isOpen]);

  const handleApply = async () => {
    if (selectedIds.size === 0) {
      toast.error(t('deactivateUnused.toasts.selectAtLeastOne'));
      return;
    }

    setIsApplying(true);
    try {
      const payeeIds = candidates
        .filter(c => selectedIds.has(c.payeeId))
        .map(c => c.payeeId);

      const result = await payeesApi.deactivatePayees(payeeIds);
      toast.success(t('deactivateUnused.toasts.deactivated', { count: result.deactivated }));
      onSuccess();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, t('deactivateUnused.toasts.deactivateFailed')));
      logger.error(error);
    } finally {
      setIsApplying(false);
    }
  };

  const togglePayee = (payeeId: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(payeeId)) {
        newSet.delete(payeeId);
      } else {
        newSet.add(payeeId);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(candidates.map(c => c.payeeId)));
  };

  const selectNone = () => {
    setSelectedIds(new Set());
  };

  const formatMonthsLabel = (months: number): string => {
    if (months < 12) return `${months} month${months !== 1 ? 's' : ''}`;
    const years = Math.floor(months / 12);
    const remainingMonths = months % 12;
    if (remainingMonths === 0) return `${years} year${years !== 1 ? 's' : ''}`;
    return `${years}.5 years`;
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return t('deactivateUnused.neverUsed');
    return formatUserDate(dateStr);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="2xl" className="overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
          {t('deactivateUnused.title')}
        </h2>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Description */}
        <div className="mb-6 p-4 bg-amber-50 dark:bg-amber-900/30 rounded-lg border border-amber-200 dark:border-amber-800">
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200 mb-2">
            {t('deactivateUnused.howItWorksTitle')}
          </h3>
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t('deactivateUnused.howItWorksBody')}
          </p>
        </div>

        {/* Settings */}
        <div className="space-y-6 mb-6">
          {/* Maximum Transactions */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('deactivateUnused.maxTransactionsLabel', { count: maxTransactions })}
            </label>
            <input
              type="range"
              min="0"
              max="20"
              value={maxTransactions}
              onChange={(e) => setMaxTransactions(parseInt(e.target.value))}
              className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-amber-600"
            />
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
              <span>0</span>
              <span>10</span>
              <span>20</span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('deactivateUnused.maxTransactionsHelp')}
            </p>
          </div>

          {/* Months Unused */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('deactivateUnused.monthsUnusedLabel', { label: formatMonthsLabel(monthsUnused) })}
            </label>
            <input
              type="range"
              min="6"
              max="120"
              step="6"
              value={monthsUnused}
              onChange={(e) => setMonthsUnused(parseInt(e.target.value))}
              className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-amber-600"
            />
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
              <span>6 months</span>
              <span>5 years</span>
              <span>10 years</span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('deactivateUnused.monthsUnusedHelp')}
            </p>
          </div>
        </div>

        {/* Preview Button */}
        <div className="mb-4">
          <Button
            onClick={loadPreview}
            disabled={isLoading}
            variant="secondary"
            className="w-full"
          >
            {isLoading ? t('deactivateUnused.loading') : t('deactivateUnused.previewButton')}
          </Button>
        </div>

        {/* Results */}
        {hasPreviewLoaded && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t("deactivateUnused.candidatesHeader", { count: candidates.length })}
              </h3>
              {candidates.length > 0 && (
                <div className="flex gap-2">
                  <button
                    onClick={selectAll}
                    className="text-xs text-amber-600 dark:text-amber-400 hover:underline"
                  >
                    {t('deactivateUnused.selectAll')}
                  </button>
                  <span className="text-gray-300 dark:text-gray-600">|</span>
                  <button
                    onClick={selectNone}
                    className="text-xs text-amber-600 dark:text-amber-400 hover:underline"
                  >
                    {t('deactivateUnused.selectNone')}
                  </button>
                </div>
              )}
            </div>

            {candidates.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <p>{t('deactivateUnused.empty.line1')}</p>
                <p className="text-sm mt-1">{t('deactivateUnused.empty.line2')}</p>
              </div>
            ) : (
              <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-700">
                    <tr>
                      <th className="w-10 px-3 py-2"></th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        {t('deactivateUnused.columns.payee')}
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden sm:table-cell">
                        {t('deactivateUnused.columns.transactions')}
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        {t('deactivateUnused.columns.lastUsed')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                    {candidates.map((candidate) => (
                      <tr
                        key={candidate.payeeId}
                        className="hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                        onClick={() => togglePayee(candidate.payeeId)}
                      >
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <ToggleSwitch
                            size="sm"
                            checked={selectedIds.has(candidate.payeeId)}
                            onChange={() => togglePayee(candidate.payeeId)}
                            label={t('deactivateUnused.selectPayeeLabel', {
                              name: candidate.payeeName,
                            })}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {candidate.payeeName}
                          </div>
                          {candidate.defaultCategoryName && (
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              {candidate.defaultCategoryName}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-sm text-gray-600 dark:text-gray-400 hidden sm:table-cell">
                          {candidate.transactionCount}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className={`text-sm ${
                            candidate.lastUsedDate === null
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-gray-600 dark:text-gray-400'
                          }`}>
                            {formatDate(candidate.lastUsedDate)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-between items-center">
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {selectedIds.size > 0 && (
            <span>{t('deactivateUnused.selectedCount', { count: selectedIds.size })}</span>
          )}
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={onClose} disabled={isApplying}>
            {tc('cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={handleApply}
            disabled={isApplying || selectedIds.size === 0}
          >
            {isApplying ? t('deactivateUnused.deactivating') : t('deactivateUnused.deactivateButton', { count: selectedIds.size })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
