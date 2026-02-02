'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { payeesApi } from '@/lib/payees';
import { CategorySuggestion } from '@/types/payee';
import toast from 'react-hot-toast';

interface CategoryAutoAssignDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function CategoryAutoAssignDialog({
  isOpen,
  onClose,
  onSuccess,
}: CategoryAutoAssignDialogProps) {
  const [minTransactions, setMinTransactions] = useState(10);
  const [minPercentage, setMinPercentage] = useState(75);
  const [onlyWithoutCategory, setOnlyWithoutCategory] = useState(true);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [hasPreviewLoaded, setHasPreviewLoaded] = useState(false);

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
      toast.error('Failed to load suggestions');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [minTransactions, minPercentage, onlyWithoutCategory]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSuggestions([]);
      setSelectedIds(new Set());
      setHasPreviewLoaded(false);
    }
  }, [isOpen]);

  const handleApply = async () => {
    if (selectedIds.size === 0) {
      toast.error('Please select at least one payee to update');
      return;
    }

    setIsApplying(true);
    try {
      const assignments = suggestions
        .filter(s => selectedIds.has(s.payeeId))
        .map(s => ({
          payeeId: s.payeeId,
          categoryId: s.suggestedCategoryId,
        }));

      const result = await payeesApi.applyCategorySuggestions(assignments);
      toast.success(`Updated ${result.updated} payee${result.updated !== 1 ? 's' : ''}`);
      onSuccess();
      onClose();
    } catch (error) {
      toast.error('Failed to apply category assignments');
      console.error(error);
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
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="2xl" className="overflow-hidden flex flex-col">
      {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            Auto-Assign Default Categories
          </h2>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* Description */}
          <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/30 rounded-lg border border-blue-200 dark:border-blue-800">
            <h3 className="text-sm font-semibold text-blue-800 dark:text-blue-200 mb-2">
              How it works
            </h3>
            <p className="text-sm text-blue-700 dark:text-blue-300">
              This feature analyzes your transaction history to suggest default categories for payees.
              It looks at which category is most commonly used for each payee and suggests assigning
              it as their default category for future transactions. You can always override the default 
              category if needed.
            </p>
          </div>

          {/* Settings */}
          <div className="space-y-6 mb-6">
            {/* Minimum Transactions */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Minimum Transactions: <span className="font-bold">{minTransactions}</span>
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
                Only consider payees with at least this many transactions
              </p>
            </div>

            {/* Minimum Percentage */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Category Match Percentage: <span className="font-bold">{minPercentage}%</span>
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
                The category must be used in at least this percentage of transactions
              </p>
            </div>

            {/* Only Without Category */}
            <div className="flex items-center">
              <input
                type="checkbox"
                id="onlyWithoutCategory"
                checked={onlyWithoutCategory}
                onChange={(e) => setOnlyWithoutCategory(e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label
                htmlFor="onlyWithoutCategory"
                className="ml-2 block text-sm text-gray-700 dark:text-gray-300"
              >
                Only payees without a default category
              </label>
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
              {isLoading ? 'Loading...' : 'Preview Suggestions'}
            </Button>
          </div>

          {/* Results */}
          {hasPreviewLoaded && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Suggestions ({suggestions.length} found)
                </h3>
                {suggestions.length > 0 && (
                  <div className="flex gap-2">
                    <button
                      onClick={selectAll}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      Select all
                    </button>
                    <span className="text-gray-300 dark:text-gray-600">|</span>
                    <button
                      onClick={selectNone}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      Select none
                    </button>
                  </div>
                )}
              </div>

              {suggestions.length === 0 ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  <p>No payees match the current criteria.</p>
                  <p className="text-sm mt-1">Try adjusting the settings above.</p>
                </div>
              ) : (
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-700">
                      <tr>
                        <th className="w-10 px-3 py-2"></th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          Payee
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          Suggested Category
                        </th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          Match
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
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(suggestion.payeeId)}
                              onChange={() => togglePayee(suggestion.payeeId)}
                              onClick={(e) => e.stopPropagation()}
                              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                              {suggestion.payeeName}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              {suggestion.transactionCount} transactions
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <span className="inline-flex text-xs font-medium rounded-full px-2 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                              {suggestion.suggestedCategoryName}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <span className={`text-sm font-medium ${
                              suggestion.percentage >= 90
                                ? 'text-green-600 dark:text-green-400'
                                : suggestion.percentage >= 75
                                  ? 'text-blue-600 dark:text-blue-400'
                                  : 'text-yellow-600 dark:text-yellow-400'
                            }`}>
                              {suggestion.percentage}%
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
              <span>{selectedIds.size} payee{selectedIds.size !== 1 ? 's' : ''} selected</span>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onClose} disabled={isApplying}>
              Cancel
            </Button>
            <Button
              onClick={handleApply}
              disabled={isApplying || selectedIds.size === 0}
            >
              {isApplying ? 'Applying...' : `Apply to ${selectedIds.size} Payee${selectedIds.size !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>
      </Modal>
  );
}
