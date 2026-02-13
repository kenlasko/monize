'use client';

import { Button } from '@/components/ui/Button';

interface BulkSelectionBannerProps {
  selectionCount: number;
  isAllOnPageSelected: boolean;
  selectAllMatching: boolean;
  totalMatching: number;
  onSelectAllMatching: () => void;
  onClearSelection: () => void;
  onBulkUpdate: () => void;
}

export function BulkSelectionBanner({
  selectionCount,
  isAllOnPageSelected,
  selectAllMatching,
  totalMatching,
  onSelectAllMatching,
  onClearSelection,
  onBulkUpdate,
}: BulkSelectionBannerProps) {
  if (selectionCount === 0) return null;

  return (
    <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 mb-4 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm text-blue-800 dark:text-blue-200">
        <span className="font-medium">
          {selectionCount} transaction{selectionCount !== 1 ? 's' : ''} selected
        </span>
        {isAllOnPageSelected && !selectAllMatching && totalMatching > selectionCount && (
          <button
            onClick={onSelectAllMatching}
            className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline"
          >
            Select all {totalMatching} matching transactions
          </button>
        )}
        {selectAllMatching && (
          <span className="text-blue-600 dark:text-blue-400">
            (all matching transactions)
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onClearSelection}
          className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
        >
          Clear selection
        </button>
        <Button onClick={onBulkUpdate} size="sm">
          Bulk Update
        </Button>
      </div>
    </div>
  );
}
