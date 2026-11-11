'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { DropIndicatorLine, useDragReorder } from '@/hooks/useDragReorder';
import type {
  PayeeLookupPreferredSource,
  PayeeLookupSettings,
} from '@/types/payee-lookup';

/** The two sources, in the order they are asked. */
type SourceRow = PayeeLookupPreferredSource;

interface LookupSourceOrderProps {
  settings: PayeeLookupSettings;
  disabled?: boolean;
  /**
   * Whether the order is worth changing. False when only one source can answer
   * -- the rows still render, because each carries its own configuration, but
   * the arrows and the drag go dead, because moving them would imply a
   * fallback that does not exist.
   */
  reorderable?: boolean;
  onReorder: (first: PayeeLookupPreferredSource) => void;
  /**
   * Each source's own controls, rendered under its description: the Google
   * Places key buttons and usage, the AI provider picker. They live with the
   * handlers that save them rather than here, so this component stays the list
   * and nothing else.
   */
  rowControls?: Partial<Record<SourceRow, ReactNode>>;
  /**
   * The one control that belongs on the title line: each source's on/off
   * switch.
   *
   * Separate from `rowControls` because its POSITION is the point. A switch is
   * the row's primary state, so it sits beside the name it applies to, centred
   * against the title and description as a pair -- below them it read as one
   * more of the row's settings rather than the thing that turns the row on.
   */
  rowAside?: Partial<Record<SourceRow, ReactNode>>;
  /**
   * Sources with nothing to configure, left out of the list entirely.
   *
   * With no AI provider there is nothing to switch on or order, so the row is
   * not drawn -- an empty row offering a disabled switch would be a control
   * whose only outcome is "go and configure something else".
   */
  hidden?: readonly SourceRow[];
}

/**
 * The order the two lookup sources are asked in, reorderable by dragging a row
 * or by the up/down buttons on it.
 *
 * **Two items, so the order is one fact**: which one is first. It is stored as
 * `preferredSource` rather than as a list, because a stored array of two would
 * have states the domain does not (empty, duplicated, naming a source that no
 * longer exists) and every reader would have to defend against them.
 *
 * Drag comes from `useDragReorder`, the same hook the Favourite Accounts widget
 * and the column chooser use, so a list reorders the same way everywhere. The up/down buttons are not a lesser alternative to it: dragging
 * is unavailable to a keyboard and unreliable on a touch screen, and
 * `FavouriteAccounts` offers both for that reason.
 */
export function LookupSourceOrder({
  settings,
  disabled = false,
  reorderable = true,
  onReorder,
  rowControls,
  rowAside,
  hidden = [],
}: LookupSourceOrderProps) {
  const t = useTranslations('settings.payeeLookup.order');
  const order: SourceRow[] = (
    settings.preferredSource === 'ai'
      ? (['ai', 'google-places'] as const)
      : (['google-places', 'ai'] as const)
  ).filter((source) => !hidden.includes(source));

  /**
   * Every legal move in a two-item list is the same move: the second becomes
   * the first. Written once so the drag path and the buttons cannot disagree
   * about what a reorder means -- and so neither has to reason about indices
   * that only ever have one outcome.
   */
  const swap = () => {
    // Nothing to swap with when only one source is drawn.
    if (disabled || !reorderable || order.length < 2) return;
    onReorder(order[1]);
  };

  const moveItem = (from: number, to: number) => {
    if (from !== to) swap();
  };

  const move = (index: number, direction: -1 | 1) => {
    const to = index + direction;
    if (to < 0 || to >= order.length) return;
    swap();
  };

  const { dragIndex, rowProps, dropIndicator } = useDragReorder(moveItem);

  const canDrag = !disabled && reorderable;

  return (
    <div>
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('title')}
      </p>

      <ol className="mt-3 space-y-2">
        {order.map((source, index) => (
          <li
            key={source}
            {...(canDrag ? rowProps(index) : {})}
            className={`relative flex items-start gap-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700 ${
              canDrag ? 'cursor-grab' : ''
            } ${dragIndex === index ? 'opacity-50' : ''}`}
          >
            <DropIndicatorLine position={dropIndicator(index, order.length)} />

            <span
              aria-hidden="true"
              className="mt-0.5 w-4 shrink-0 text-sm font-semibold text-gray-400 dark:text-gray-500"
            >
              {index + 1}
            </span>

            <div className="min-w-0 flex-1">
              {/* `items-center` so the switch is centred against the title and
                  description together, rather than pinned to the first line of
                  a block whose height depends on how the help text wraps. */}
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t(source === 'ai' ? 'aiTitle' : 'placesTitle')}
                  </p>
                  <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                    {t(source === 'ai' ? 'aiHelp' : 'placesHelp')}
                  </p>
                </div>

                {rowAside?.[source]}
              </div>

              {rowControls?.[source]}
            </div>

            <div className="flex shrink-0 flex-col">
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={disabled || !reorderable || index === 0}
                aria-label={t('moveUp')}
                title={t('moveUp')}
                className="rounded p-1 text-gray-400 transition-colors hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none dark:hover:text-gray-300"
              >
                <ChevronUpIcon className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={disabled || !reorderable || index === order.length - 1}
                aria-label={t('moveDown')}
                title={t('moveDown')}
                className="rounded p-1 text-gray-400 transition-colors hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none dark:hover:text-gray-300"
              >
                <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
