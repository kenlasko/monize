'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useClickOutside } from '@/hooks/useClickOutside';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { ArrowDownTrayIcon, ChevronDownIcon, DocumentIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import { MENU_ENTER_CLASS, MENU_ORIGIN_RIGHT } from '@/components/ui/menu-motion';

const logger = createLogger('ExportDropdown');

interface ExportDropdownBaseProps {
  disabled?: boolean;
  /**
   * Extra classes for the trigger button, for a caller that has to size it --
   * a toolbar standing it beside labelled fields needs `h-full`, and the
   * button's own padding cannot know that. Layout only; the colours, the
   * spacing and the disabled treatment stay here so every export button reads
   * the same.
   */
  className?: string;
  /**
   * Extra classes for the positioning wrapper the CSV+PDF variant renders --
   * the box a toolbar lays out, which is `inline-block` and therefore as wide
   * as the button's text whatever the button itself is told. A toolbar giving
   * the export its own full line on a phone (`w-full sm:w-auto`) has to size
   * this, not only the trigger. Ignored by the single-format variants, which
   * have no wrapper: there the button IS the box, so `className` sizes it.
   */
  containerClassName?: string;
}

/**
 * At least one format, in one of three shapes: both (a dropdown), PDF alone or
 * CSV alone (a single button each). A component with neither handler would
 * render a button that exports nothing, so the union refuses it at the type
 * level rather than at runtime.
 */
type ExportDropdownProps = ExportDropdownBaseProps &
  (
    | { onExportPdf: () => void; onExportCsv?: () => void }
    | { onExportPdf?: undefined; onExportCsv: () => void }
  );

export function ExportDropdown({
  onExportCsv,
  onExportPdf,
  disabled,
  className,
  containerClassName,
}: ExportDropdownProps) {
  const t = useTranslations('common');
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  useClickOutside(dropdownRef, close, { enabled: isOpen });

  const handleExportCsv = () => {
    close();
    onExportCsv?.();
  };

  const handleExportPdf = async () => {
    close();
    if (!onExportPdf) return;
    setIsExporting(true);
    try {
      await onExportPdf();
    } catch (error) {
      logger.error('PDF export failed:', error);
      toast.error(t('exportDropdown.failedPdf'));
    } finally {
      setIsExporting(false);
    }
  };

  /**
   * CSV-only mode: one button, the same shape the PDF-only one has.
   *
   * A report whose current view has nothing to draw (a matrix of figures, a
   * custom report's rows) exports CSV and nothing else, and used to hand-roll
   * this button -- a third copy of the styling, and one that missed the phone
   * layout `ReportToolbarActions` gives the other two. Writing to a file is
   * synchronous here, so there is no `isExporting` state to show: the PDF path
   * has one because it renders the DOM to an image first.
   */
  if (!onExportPdf) {
    return (
      <button
        onClick={handleExportCsv}
        disabled={disabled}
        className={cn(
          'px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed',
          className,
        )}
        title={t('exportDropdown.exportCsv')}
      >
        <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
        {t('exportDropdown.exportCsv')}
      </button>
    );
  }

  // PDF-only mode: render a single button instead of a dropdown
  if (!onExportCsv) {
    return (
      <button
        onClick={handleExportPdf}
        disabled={disabled || isExporting}
        className={cn(
          'px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-1.5 disabled:opacity-50',
          className,
        )}
        title={t('exportDropdown.exportPdf')}
      >
        <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
        {isExporting ? t('exportDropdown.exporting') : t('exportDropdown.exportPdf')}
      </button>
    );
  }

  return (
    <div ref={dropdownRef} className={cn('relative inline-block', containerClassName)}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled || isExporting}
        className={cn(
          'px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-1.5 disabled:opacity-50',
          className,
        )}
        title={t('exportDropdown.exportReport')}
      >
        <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
        {isExporting ? t('exportDropdown.exporting') : t('exportDropdown.export')}
        <ChevronDownIcon className="h-3 w-3" aria-hidden="true" />
      </button>

      {isOpen && (
        <div className={`absolute right-0 mt-1 w-36 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50 ${MENU_ENTER_CLASS} ${MENU_ORIGIN_RIGHT}`}>
          <button
            onClick={handleExportCsv}
            className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-t-md flex items-center gap-2"
          >
            <DocumentTextIcon className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden="true" />
            CSV
          </button>
          <button
            onClick={handleExportPdf}
            className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-b-md flex items-center gap-2"
          >
            <DocumentIcon className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden="true" />
            PDF
          </button>
        </div>
      )}
    </div>
  );
}
