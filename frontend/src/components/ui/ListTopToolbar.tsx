'use client';

import { Pagination } from '@/components/ui/Pagination';
import { DensityToggle } from '@/components/ui/DensityToggle';
import type { DensityView } from '@/store/densityStore';
import { HOVER_TOOLBAR_BUTTON } from '@/components/ui/Card';

/**
 * A text button in this bar's `actions`: the register's export button and the
 * Columns menu trigger. The `sm` density toggle's size and colours, so the
 * buttons beside it stand at its height, plus the disabled state an export
 * needs.
 */
export const LIST_TOOLBAR_BUTTON_CLASS =
  'inline-flex items-center px-2 py-1 text-xs font-medium rounded text-gray-600 dark:text-gray-300 ' +
  `hover:text-gray-900 dark:hover:text-gray-100 ${HOVER_TOOLBAR_BUTTON} ` +
  'disabled:opacity-50 disabled:cursor-not-allowed';

interface ListTopToolbarProps {
  /** The remembered density, when this surface offers a density setting. */
  densityView?: DensityView;
  /**
   * Paging state. Supply all five or none: with them the bar carries the
   * pager and the buttons ride at the right-hand end of it, in front of the
   * page stepper; without them it is the buttons alone.
   *
   * A single page keeps the pager too. Its buttons are inert there, but the
   * line beside them -- "Showing 1-7 of 7 transactions" -- is the answer to
   * "did that filter work?", and hiding it exactly when a filter has narrowed
   * the list to one page takes the count away at the moment it is being read.
   */
  currentPage?: number;
  totalPages?: number;
  totalItems?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  /** Plural noun for "Showing 1-25 of 90 <itemName>" -- always translated. */
  itemName?: string;
  /** Buttons that belong to the list itself (export, and the like). */
  actions?: React.ReactNode;
  /**
   * The Table / Calendar switch for the screen this list is the table half of.
   *
   * It rides beside the "Showing 1-25 of 90" line at the left-hand end of the
   * bar rather than with the buttons on the right: what the reader is looking
   * at -- these rows, this many of them -- and the control that changes which
   * shape they are looking at read as one statement, and it leaves the
   * right-hand end to the controls that act on the list as drawn (export,
   * density) and the pager. With no pager to sit beside it stays with the
   * buttons, which is the only place left. Absent on a list whose screen offers no
   * calendar.
   */
  viewToggle?: React.ReactNode;
}

/**
 * The grey strip above a table: where you are in the list and the switch that
 * changes its shape on the left, the controls that act on the whole list and
 * then the pager on the right.
 *
 * It is one component because it is one thing the user learns once. The cash
 * register drew it and the brokerage register did not, so the two halves of an
 * investment account -- one toggle apart, on the same page -- put their pager
 * in different places and their density button in different rows, and the
 * brokerage side's pager was below the table where a reader who had just
 * scrolled a page of trades would not meet it. A second copy of this markup is
 * how that came back, so `ui-conventions.test.ts` fails on one.
 */
export function ListTopToolbar({
  densityView,
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  itemName,
  actions,
  viewToggle,
}: ListTopToolbarProps) {
  const buttons = (
    <div className="flex items-center gap-1 flex-shrink-0">
      {actions}
      {densityView && <DensityToggle view={densityView} hideLabelOnMobile className="flex-shrink-0" />}
    </div>
  );

  const showPagination =
    currentPage !== undefined &&
    totalPages !== undefined &&
    totalItems !== undefined &&
    pageSize !== undefined &&
    onPageChange !== undefined;

  return (
    <div className="flex items-center justify-end p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
      {showPagination ? (
        <div className="flex-1">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={totalItems}
            pageSize={pageSize}
            onPageChange={onPageChange}
            itemName={itemName}
            minimal
            infoRight={buttons}
            infoAfter={viewToggle}
          />
        </div>
      ) : (
        <div className="flex items-center gap-1 flex-shrink-0">
          {buttons}
          {viewToggle}
        </div>
      )}
    </div>
  );
}
