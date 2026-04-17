'use client';

import { ReactNode, useRef } from 'react';
import toast from 'react-hot-toast';
import { exportToCsv } from '@/lib/csv-export';

interface AssistantTableProps {
  children: ReactNode;
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned.toLowerCase() || 'ai-table';
}

/**
 * Derive a filename-appropriate label for the table. Prefers the nearest
 * preceding heading (matches how the markdown author introduces the table),
 * then falls back to the first header cell so the CSV name reflects the
 * table's subject rather than a generic placeholder.
 */
function deriveTableName(
  wrapper: HTMLElement | null,
  table: HTMLTableElement,
): string {
  const heading = wrapper?.previousElementSibling;
  if (
    heading &&
    /^(H[1-6]|P)$/.test(heading.tagName) &&
    heading.textContent?.trim()
  ) {
    return heading.textContent.trim();
  }
  const firstHeader = table
    .querySelector('thead th')
    ?.textContent?.trim();
  return firstHeader || '';
}

export function AssistantTable({ children }: AssistantTableProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const handleDownload = () => {
    const table = tableRef.current;
    if (!table) return;

    const headers = Array.from(table.querySelectorAll('thead th')).map(
      (th) => th.textContent?.trim() ?? '',
    );
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('th, td')).map(
        (c) => c.textContent?.trim() ?? '',
      ),
    );

    if (headers.length === 0 && rows.length === 0) {
      toast.error('No table data to export');
      return;
    }

    const filename = sanitizeFilename(
      deriveTableName(wrapperRef.current, table),
    );
    exportToCsv(filename, headers, rows);
  };

  return (
    <div ref={wrapperRef} className="my-2">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleDownload}
          className="p-1 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors"
          title="Download table as CSV"
          aria-label="Download table as CSV"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
        </button>
      </div>
      <div className="overflow-x-auto">
        <table ref={tableRef} className="text-xs border-collapse">
          {children}
        </table>
      </div>
    </div>
  );
}
