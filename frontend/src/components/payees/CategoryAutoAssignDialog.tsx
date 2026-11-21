'use client';

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { payeesApi } from '@/lib/payees';
import { CategorySuggestion } from '@/types/payee';
import { Category } from '@/types/category';
import { buildCategoryLabelMap } from '@/lib/categoryUtils';
import toast from 'react-hot-toast';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

import { useNumberFormat } from '@/hooks/useNumberFormat';
import { Badge } from '@/components/ui/Badge';
const logger = createLogger('CategoryAutoAssign');

interface CategoryAutoAssignDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  categories?: Category[];
}

export function CategoryAutoAssignDialog({
  isOpen,
  onClose,
  onSuccess,
  categories = [],
}: CategoryAutoAssignDialogProps) {
  const [minTransactions, setMinTransactions] = useState(10);
  const [minPercentage, setMinPercentage] = useState(75);
  const [onlyWithoutCategory, setOnlyWithoutCategory] = useState(true);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [backfillTransactions, setBackfillTransactions] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [hasPreviewLoaded, setHasPreviewLoaded] = useState(false);
  const t = useTranslations('payees');
  const tc = useTranslations('common');
  const { formatPercentTrimmed } = useNumberFormat();
  const router = useRouter();

  // Jump to the Transactions page filtered to this payee's uncategorized
  // transactions so the user can review or fix them directly.
  const viewUncategorized = useCallback(
    (payeeId: string) => {
      onClose();
      router.push(`/transactions?payeeId=${payeeId}&categoryId=uncategorized`);
    },
    [onClose, router],
  );

  // Map a suggested category id to its full "Parent: Child" label so the
  // suggestion shows the subcategory in context; fall back to the bare name.
  const categoryLabelMap = useMemo(
    () => buildCategoryLabelMap(categories),
    [categories],
  );

  // Load preview when parameters change
  const loadPreview = useCallback(async () => {
    setIsLoading(true);
    try {
      const results = await payeesApi.getCategorySuggestions({
        minTransactions,
        minPercentage,
        onlyWithoutCategory,
      });
      setSuggestions(results);
      // Select all by default
      setSelectedIds(new Set(results.map(s => s.payeeId)));
      setHasPreviewLoaded(true);
    } catch (error) {
      toast.error(getErrorMessage(error, t('categoryAutoAssign.toasts.loadFailed')));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [minTransactions, minPercentage, onlyWithoutCategory, t]);

  // Reset state when dialog opens
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setSuggestions([]);
      setSelectedIds(new Set());
      setBackfillTransactions(false);
      setHasPreviewLoaded(false);
    }
  }

  // Total uncategorized transactions across the selected payees -- the scope of
  // the optional backfill, shown in its label.
  const backfillCount = useMemo(
    () =>
      suggestions
        .filter(s => selectedIds.has(s.payeeId))
        .reduce((sum, s) => sum + s.uncategorizedCount, 0),
    [suggestions, selectedIds],
  );

  const handleApply = async () => {
    if (selectedIds.size === 0) {
      toast.error(t('categoryAutoAssign.toasts.selectAtLeastOne'));
      return;
    }

    setIsApplying(true);
    try {
      const assignments = suggestions
        .filter(s => selectedIds.has(s.payeeId))
        .map(s => ({
          payeeId: s.payeeId,
          categoryId: s.suggestedCategoryId,
          backfillTransactions,
        }));

      const result = await payeesApi.applyCategorySuggestions(assignments);
      toast.success(t('categoryAutoAssign.toasts.updated', { count: result.updated }));
      if (result.transactionsBackfilled > 0) {
        toast.success(
          t('categoryAutoAssign.toasts.backfilled', { count: result.transactionsBackfilled }),
        );
      }
      onSuccess();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, t('categoryAutoAssign.toasts.applyFailed')));
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
    setSelectedIds(new Set(suggestions.map(s => s.payeeId)));
  };

  const selectNone = () => {
    setSelectedIds(new Set());
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="2xl"
      title={t('categoryAutoAssign.title')}
      description={t('categoryAutoAssign.howItWorksBody')}
      className="p-6 overflow-hidden flex flex-col"
      footer={
        <>
          <div className="mr-auto text-sm text-gray-500 dark:text-gray-400">
            {selectedIds.size > 0 && (
              <span>{t('categoryAutoAssign.selectedCount', { count: selectedIds.size })}</span>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onClose} disabled={isApplying}>
              {tc('cancel')}
            </Button>
            <Button
              onClick={handleApply}
              disabled={isApplying || selectedIds.size === 0}
            >
              {isApplying ? t('categoryAutoAssign.applying') : t('categoryAutoAssign.applyButton', { count: selectedIds.size })}
            </Button>
          </div>
        </>
      }
    >
        {/* Content: the one region that scrolls, so the title and the button
            row stay on screen however long the suggestion list grows. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Settings */}
          <div className="space-y-6 mb-6">
            {/* Minimum Transactions */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('categoryAutoAssign.minTransactionsLabel', { count: minTransactions })}
              </label>
              <input
                type="range"
                min="1"
                max="50"
                value={minTransactions}
                onChange={(e) => setMinTransactions(parseInt(e.target.value))}
                className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600"
              />
              <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
                <span>1</span>
                <span>25</span>
                <span>50</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('categoryAutoAssign.minTransactionsHelp')}
              </p>
            </div>

            {/* Minimum Percentage */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('categoryAutoAssign.matchPercentageLabel', { percent: minPercentage })}
              </label>
              <input
                type="range"
                min="50"
                max="100"
                step="5"
                value={minPercentage}
                onChange={(e) => setMinPercentage(parseInt(e.target.value))}
                className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600"
              />
              <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
                <span>50%</span>
                <span>75%</span>
                <span>100%</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('categoryAutoAssign.matchPercentageHelp')}
              </p>
            </div>

            {/* Only Without Category */}
            <label className="flex items-center gap-3 cursor-pointer">
              <ToggleSwitch
                checked={onlyWithoutCategory}
                onChange={setOnlyWithoutCategory}
                label={t('categoryAutoAssign.onlyWithoutCategoryLabel')}
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('categoryAutoAssign.onlyWithoutCategoryLabel')}
              </span>
            </label>
          </div>

          {/* Preview Button */}
          <div className="mb-4">
            <Button
              onClick={loadPreview}
              disabled={isLoading}
              variant="secondary"
              className="w-full"
            >
              {isLoading ? t('categoryAutoAssign.loading') : t('categoryAutoAssign.previewButton')}
            </Button>
          </div>

          {/* Results */}
          {hasPreviewLoaded && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {t('categoryAutoAssign.suggestionsHeader', { count: suggestions.length })}
                </h3>
                {suggestions.length > 0 && (
                  <div className="flex gap-2">
                    <button
                      onClick={selectAll}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {t('categoryAutoAssign.selectAll')}
                    </button>
                    <span className="text-gray-300 dark:text-gray-600">|</span>
                    <button
                      onClick={selectNone}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {t('categoryAutoAssign.selectNone')}
                    </button>
                  </div>
                )}
              </div>

              {suggestions.length === 0 ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  <p>{t('categoryAutoAssign.empty.line1')}</p>
                  <p className="text-sm mt-1">{t('categoryAutoAssign.empty.line2')}</p>
                </div>
              ) : (
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-700">
                      <tr>
                        <th className="w-10 px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          {t('categoryAutoAssign.columns.assign')}
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          {t('categoryAutoAssign.columns.payee')}
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          {t('categoryAutoAssign.columns.suggestedCategory')}
                        </th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          {t('categoryAutoAssign.columns.match')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                      {suggestions.map((suggestion) => (
                        <tr
                          key={suggestion.payeeId}
                          className="hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                          onClick={() => togglePayee(suggestion.payeeId)}
                        >
                          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                            <ToggleSwitch
                              size="sm"
                              checked={selectedIds.has(suggestion.payeeId)}
                              onChange={() => togglePayee(suggestion.payeeId)}
                              label={t('categoryAutoAssign.selectPayeeLabel', {
                                name: suggestion.payeeName,
                              })}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                              {suggestion.payeeName}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                {suggestion.transactionCount} transactions
                              </span>
                              {suggestion.uncategorizedCount > 0 && (
                                <Badge
                as="button"
                variant="amber"
                                  type="button"
                                  onClick={() => viewUncategorized(suggestion.payeeId)}
                                  className="cursor-pointer transition-colors hover:bg-amber-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-amber-900/60"
                                  title={t('categoryAutoAssign.viewUncategorizedTitle', {
                                    count: suggestion.uncategorizedCount,
                                    name: suggestion.payeeName,
                                  })}
                                >
                                  {t('list.uncategorizedBadge', {
                                    count: suggestion.uncategorizedCount,
                                  })}
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant="blue">
                              {categoryLabelMap.get(suggestion.suggestedCategoryId) ??
                                suggestion.suggestedCategoryName}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <span className={`text-sm font-medium ${
                              suggestion.percentage >= 90
                                ? 'text-green-600 dark:text-green-400'
                                : suggestion.percentage >= 75
                                  ? 'text-blue-600 dark:text-blue-400'
                                  : 'text-yellow-600 dark:text-yellow-400'
                            }`}>
                              {formatPercentTrimmed(suggestion.percentage)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Optional backfill: also apply the assigned category to the
                  selected payees' existing uncategorized transactions. */}
              {backfillCount > 0 && (
                <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <ToggleSwitch
                      checked={backfillTransactions}
                      onChange={setBackfillTransactions}
                      label={t('categoryAutoAssign.backfillLabel', { count: backfillCount })}
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      {t('categoryAutoAssign.backfillLabel', { count: backfillCount })}
                    </span>
                  </label>
                  <p className="ml-12 mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('categoryAutoAssign.backfillHelp')}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
    </Modal>
  );
}
