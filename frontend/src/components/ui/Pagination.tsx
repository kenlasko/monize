'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  itemName?: string; // e.g., "transactions", "securities"
  minimal?: boolean; // Remove shadow and rounded styling for inline use
  infoRight?: React.ReactNode; // Optional content to render left of the page stepper
  infoBefore?: React.ReactNode; // Optional content to render immediately left of "Showing X-Y of Z"
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  itemName = 'items',
  minimal = false,
  infoRight,
  infoBefore,
}: PaginationProps) {
  const t = useTranslations('common');
  const [inputPage, setInputPage] = useState(currentPage.toString());

  // Keep input in sync with current page (the "info from previous render"
  // pattern rather than a setState in an effect)
  const [syncedPage, setSyncedPage] = useState(currentPage);
  if (syncedPage !== currentPage) {
    setSyncedPage(currentPage);
    setInputPage(currentPage.toString());
  }

  const goToPage = (page: number) => {
    const validPage = Math.max(1, Math.min(page, totalPages));
    if (validPage !== currentPage) {
      onPageChange(validPage);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputPage(e.target.value);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const page = parseInt(inputPage, 10);
      if (!isNaN(page) && page >= 1 && page <= totalPages) {
        goToPage(page);
      } else {
        setInputPage(currentPage.toString());
      }
    }
  };

  const handleInputBlur = () => {
    const page = parseInt(inputPage, 10);
    if (!isNaN(page) && page >= 1 && page <= totalPages) {
      goToPage(page);
    } else {
      setInputPage(currentPage.toString());
    }
  };

  // Calculate showing range
  const startItem = (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);

  // Determine which jump buttons to show based on total pages
  const showLargeJumps = totalPages > 10;

  const buttonClass = "px-2 h-[26px] text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md transition-colors motion-reduce:transition-none hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className={`flex flex-col min-[820px]:flex-row items-center justify-between gap-3 ${minimal ? 'bg-transparent' : 'bg-white dark:bg-gray-800 px-4 py-3 shadow dark:shadow-gray-700/50 rounded-lg'}`}>
      {/* Showing X-Y of Z, and whatever the caller wants read as part of that
          line rather than as part of the paging controls. */}
      {/* Once the row stacks, a leading control (the Table / Calendar
          switch) holds the left-hand edge, as it does on the calendar's own
          toolbar, rather than being centred with the line beside it. */}
      <div className={`flex items-center gap-2 ${infoBefore ? 'self-start min-[820px]:self-auto' : ''}`}>
        {infoBefore}
        <div className="text-sm text-gray-700 dark:text-gray-300">
          {t('pagination.showing')}{' '}
          <span className="font-medium">{startItem}</span>
          {' '}-{' '}
          <span className="font-medium">{endItem}</span>
          {' '}{t('pagination.of')}{' '}
          <span className="font-medium">{totalItems}</span>
          {' '}{itemName}
        </div>
      </div>

      {/* Whatever the caller puts beside the paging controls, then the
          controls.

          One row that wraps rather than a column that stacks at a fixed width:
          the stepper is seven controls wide and the buttons beside it are two
          more, so a breakpoint guess puts them on a line of their own while
          there is still room for both. Wrapping only splits them where the row
          genuinely does not fit. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {infoRight}
        <div className="flex items-center space-x-1">
        {/* First page */}
        <button
          onClick={() => goToPage(1)}
          disabled={currentPage === 1}
          className={buttonClass}
          title={t('pagination.firstPage')}
        >
          ««
        </button>

        {/* Jump back 10 */}
        {showLargeJumps && (
          <button
            onClick={() => goToPage(currentPage - 10)}
            disabled={currentPage <= 1}
            className={`${buttonClass} hidden sm:inline-flex`}
            title={t('pagination.back10Pages')}
          >
            -10
          </button>
        )}

        {/* Previous page */}
        <button
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage === 1}
          className={buttonClass}
          title={t('pagination.previousPage')}
        >
          ‹
        </button>

        {/* Page input */}
        <div className="inline-flex items-center gap-1 px-0.5 whitespace-nowrap flex-shrink-0">
          <input
            type="text"
            inputMode="numeric"
            value={inputPage}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onBlur={handleInputBlur}
            maxLength={4}
            size={4}
            className="w-16! h-[26px] px-0! py-0! text-xs! text-center font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            title={t('pagination.enterPageNumber')}
          />
          <span className="text-sm text-gray-500 dark:text-gray-400">
            / {totalPages}
          </span>
        </div>

        {/* Next page */}
        <button
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className={buttonClass}
          title={t('pagination.nextPage')}
        >
          ›
        </button>

        {/* Jump forward 10 */}
        {showLargeJumps && (
          <button
            onClick={() => goToPage(currentPage + 10)}
            disabled={currentPage >= totalPages}
            className={`${buttonClass} hidden sm:inline-flex`}
            title={t('pagination.forward10Pages')}
          >
            +10
          </button>
        )}

        {/* Last page */}
        <button
          onClick={() => goToPage(totalPages)}
          disabled={currentPage === totalPages}
          className={buttonClass}
          title={t('pagination.lastPage')}
        >
          »»
        </button>
        </div>
      </div>
    </div>
  );
}
