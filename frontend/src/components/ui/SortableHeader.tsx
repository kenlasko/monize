'use client';

import { ReactNode, type SyntheticEvent } from 'react';
import { SortIcon } from './SortIcon';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from './interactive-row';
import type { SortDirection } from '@/hooks/useSortableTable';
import type { LongPressRowHandlers } from '@/hooks/useLongPress';

interface SortableHeaderProps<F extends string> {
  field: F;
  sortField: F;
  sortDirection: SortDirection;
  onSort: (field: F) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
  children: ReactNode;
  /**
   * A control that lives in this header and does something other than sort --
   * the register's year toggle is the one. Activating it must not also sort
   * the column, so it renders inside a wrapper that stops the event before it
   * reaches the header. Moving the control out of the header instead would
   * separate it from the column it belongs to; leaving it in without the
   * wrapper makes every press on it sort as well.
   */
  controls?: ReactNode;
  /**
   * Press-and-hold handlers for a header that opens a sheet of its own (the
   * hideable columns' "Hide column", from `useColumnHeaderActions`). When
   * present the header spreads them and drops its own `onClick`: the sort
   * arrives through their `onClick`, which `useLongPress` withholds after a
   * long-press, so one press never both opens the sheet and sorts. The
   * keyboard sort is unchanged.
   */
  pressHandlers?: LongPressRowHandlers;
}

/**
 * The press handlers with the three that start a press (mouse down, touch
 * start, right-click) ignoring a press that begins on a header control. The
 * control's own wrapper cannot stop those events instead: a stopped
 * `mousedown` never reaches `document`, so every `useClickOutside` popover
 * open elsewhere would stay open when the control is pressed. Its click is
 * already stopped by the wrapper, which is harmless for the same reason.
 */
function outsideControls(handlers: LongPressRowHandlers): LongPressRowHandlers {
  const unlessInControls =
    <E extends SyntheticEvent>(handler: (event: E) => void) =>
    (event: E) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-header-controls]')) return;
      handler(event);
    };
  return {
    ...handlers,
    onMouseDown: unlessInControls(handlers.onMouseDown),
    onTouchStart: unlessInControls(handlers.onTouchStart),
    onContextMenu: unlessInControls(handlers.onContextMenu),
  };
}

/**
 * Clickable column header with a sort indicator. Mirrors the style used by the
 * Accounts table so all reports sort consistently.
 */
export function SortableHeader<F extends string>({
  field,
  sortField,
  sortDirection,
  onSort,
  align = 'left',
  className = '',
  children,
  controls,
  pressHandlers,
}: SortableHeaderProps<F>) {
  const justify =
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : '';
  const isActive = sortField === field;
  const sort = () => onSort(field);

  return (
    // `role="columnheader"` is the implicit role of a `<th>`, restated so it
    // survives a table restyled for phones (a `display` other than table-cell
    // drops the implicit role); inert everywhere else.
    <th
      role="columnheader"
      tabIndex={0}
      aria-sort={isActive ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      {...(pressHandlers ? outsideControls(pressHandlers) : { onClick: sort })}
      onKeyDown={activateOnKey(sort)}
      className={`ui-sort-th cursor-pointer transition-colors motion-reduce:transition-none hover:bg-gray-100 dark:hover:bg-gray-700 ${INTERACTIVE_ROW_FOCUS_CLASS} select-none ${className}`}
    >
      <div className={`flex items-center ${justify}`}>
        {children}
        <SortIcon field={field} sortField={sortField} sortDirection={sortDirection} />
        {controls && (
          <span
            data-header-controls=""
            role="presentation"
            className="inline-flex items-center"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {controls}
          </span>
        )}
      </div>
    </th>
  );
}
