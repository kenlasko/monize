'use client';

import { Pagination } from '@/components/ui/Pagination';

interface ListBottomPagerProps {
  /**
   * Paging state. Supply all five or none -- with none this draws nothing,
   * which is the same contract `ListTopToolbar` keeps and for the same reason:
   * a list whose surroundings own the paging must not half-draw a pager from
   * whichever props happened to arrive.
   */
  currentPage?: number;
  totalPages?: number;
  totalItems?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  /** Plural noun for "Showing 1-25 of 90 <itemName>" -- always translated. */
  itemName: string;
  /**
   * The line drawn instead of the pager when everything fits on one page --
   * already translated, and pluralised by its own catalog, because "1
   * transaction" and "1 transactions" are not the same sentence and only the
   * caller's namespace knows the noun.
   */
  totalLabel: string;
}

/**
 * The pager below a table: where you are in the list, repeated at the end of
 * it.
 *
 * `ListTopToolbar` is the strip above the rows and this is its counterpart, so
 * a reader who has just scrolled a full page of rows meets the controls where
 * they finished rather than having to scroll back. The two are separate
 * components because the top strip also carries the controls that act on the
 * whole list (density, export) and the bottom deliberately does not: repeating
 * a toggle is not repeating a position.
 *
 * On a single page it draws the count instead of an inert pager. That differs
 * from the top strip, which keeps its pager for a reason its own comment gives
 * -- "Showing 1-7 of 7" is the answer to "did that filter work?", and it is
 * answered once, up there, where the filter controls are.
 *
 * It is drawn by the surface, not by the list, because it belongs *outside* the
 * card the rows sit in -- `Pagination` carries its own background and shadow, so
 * inside a rounded panel it reads as a white box on a white panel. The top strip
 * is the opposite: it is the panel's own header row, which is why that one lives
 * in the list. Anything drawing a pager below a table composes this rather than
 * repeating the markup (`ui-conventions.test.ts`).
 */
export function ListBottomPager({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  itemName,
  totalLabel,
}: ListBottomPagerProps) {
  if (
    currentPage === undefined ||
    totalPages === undefined ||
    totalItems === undefined ||
    pageSize === undefined ||
    onPageChange === undefined
  ) {
    return null;
  }

  if (totalPages > 1) {
    return (
      <div className="ui-list-pager mt-4">
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalItems}
          pageSize={pageSize}
          onPageChange={onPageChange}
          itemName={itemName}
        />
      </div>
    );
  }

  // Nothing to say about an empty list -- the empty state above already said
  // it, and "0 transactions" under it would be the same sentence twice.
  if (totalItems <= 0) return null;

  return (
    <div className="ui-list-pager ui-list-total mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
      {totalLabel}
    </div>
  );
}
