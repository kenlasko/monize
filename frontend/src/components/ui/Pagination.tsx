'use client';

import { useState, useEffect } from 'react';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  itemName?: string; // e.g., "transactions", "securities"
  minimal?: boolean; // Remove shadow and rounded styling for inline use
  infoRight?: React.ReactNode; // Optional content to render right of "Showing X-Y of Z"
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
}: PaginationProps) {
  const [inputPage, setInputPage] = useState(currentPage.toString());

  // Keep input in sync with current page
  useEffect(() => {
    setInputPage(currentPage.toString());
  }, [currentPage]);

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

  const buttonClass = "px-2 h-[26px] text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className={`flex flex-col sm:flex-row items-center justify-between gap-3 ${minimal ? 'bg-transparent' : 'bg-white dark:bg-gray-800 px-4 py-3 shadow dark:shadow-gray-700/50 rounded-lg'}`}>
      {/* Showing X-Y of Z */}
      <div className="text-sm text-gray-700 dark:text-gray-300">
        Showing{' '}
        <span className="font-medium">{startItem}</span>
        {' '}-{' '}
        <span className="font-medium">{endItem}</span>
        {' '}of{' '}
        <span className="font-medium">{totalItems}</span>
        {' '}{itemName}
      </div>

      {/* Navigation controls + optional right content */}
      <div className="flex items-center gap-2">
        {infoRight}
        <div className="flex items-center space-x-1">
        {/* First page */}
        <button
          onClick={() => goToPage(1)}
          disabled={currentPage === 1}
          className={buttonClass}
          title="First page"
        >
          ««
        </button>

        {/* Jump back 10 */}
        {showLargeJumps && (
          <button
            onClick={() => goToPage(currentPage - 10)}
            disabled={currentPage <= 1}
            className={`${buttonClass} hidden sm:inline-flex`}
            title="Back 10 pages"
          >
            -10
          </button>
        )}

        {/* Previous page */}
        <button
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage === 1}
          className={buttonClass}
          title="Previous page"
        >
          ‹
        </button>

        {/* Page input */}
        <div className="inline-flex items-center gap-1 px-1 whitespace-nowrap flex-shrink-0">
          <input
            type="text"
            inputMode="numeric"
            value={inputPage}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onBlur={handleInputBlur}
            maxLength={4}
            size={4}
            className="w-10 h-[26px] px-1 py-0 text-xs text-center font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="Enter page number"
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
          title="Next page"
        >
          ›
        </button>

        {/* Jump forward 10 */}
        {showLargeJumps && (
          <button
            onClick={() => goToPage(currentPage + 10)}
            disabled={currentPage >= totalPages}
            className={`${buttonClass} hidden sm:inline-flex`}
            title="Forward 10 pages"
          >
            +10
          </button>
        )}

        {/* Last page */}
        <button
          onClick={() => goToPage(totalPages)}
          disabled={currentPage === totalPages}
          className={buttonClass}
          title="Last page"
        >
          »»
        </button>
        </div>
      </div>
    </div>
  );
}
