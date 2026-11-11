'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { Card, HOVER_TOOLBAR_BUTTON } from '@/components/ui/Card';
import { cn } from '@/lib/utils';
import type { DashboardLayoutItem } from './dashboard-layout';
import { WidgetGlyph, useWidgetName } from './widget-glyphs';

const CONTROL_CLASS = `rounded-md p-1.5 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${HOVER_TOOLBAR_BUTTON}`;

interface WidgetEditOverlayProps {
  item: DashboardLayoutItem;
  /** The item's place in the draft, and how many the draft holds. */
  index: number;
  count: number;
  /** Move the item from one place to another; the page announces it. */
  onMove: (from: number, to: number) => void;
  onRemove: (item: DashboardLayoutItem) => void;
  /** The grip (F5 puts the pointer drag handle here); a plain glyph until then. */
  grip?: ReactNode;
  /** Width and height choices (F4), between the name and the move buttons. */
  sizeChoices?: ReactNode;
}

/**
 * Edit mode's controls over one widget, in the grid item's one cell beside
 * the (inert, dimmed) card: the grip, the widget's name, move earlier and
 * later, and remove. The overlay itself lets a press through, so a touch on
 * the card body still scrolls the page; only its bar takes pointer events.
 */
export function WidgetEditOverlay({
  item,
  index,
  count,
  onMove,
  onRemove,
  grip,
  sizeChoices,
}: WidgetEditOverlayProps) {
  const t = useTranslations('dashboard');
  const name = useWidgetName()(item.id);

  return (
    <div
      data-testid={`widget-edit-overlay-${item.id}`}
      className="pointer-events-none relative z-10 rounded-lg border-2 border-dashed border-blue-400/70 dark:border-blue-400/60"
    >
      <div
        role="group"
        aria-label={name}
        className="pointer-events-auto m-2 flex flex-wrap items-center gap-1 rounded-md border border-gray-200 bg-white/95 p-1 shadow-sm dark:border-gray-700 dark:bg-gray-800/95"
      >
        <span data-edit-slot="grip" className="flex flex-shrink-0 items-center">
          {grip ?? (
            <span aria-hidden="true" className="select-none px-1 text-gray-400">
              ⠿
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-gray-900 dark:text-gray-100">
          {name}
        </span>
        {sizeChoices && <span data-edit-slot="size">{sizeChoices}</span>}
        <button
          type="button"
          data-edit-action="earlier"
          onClick={() => onMove(index, index - 1)}
          disabled={index === 0}
          aria-label={t('customize.moveEarlier', { name })}
          title={t('customize.moveEarlier', { name })}
          className={CONTROL_CLASS}
        >
          {/* Up in the one-column phone stack, left in the wide grid's row flow. */}
          <ChevronUpIcon className="h-4 w-4 lg:hidden" aria-hidden="true" />
          <ChevronLeftIcon className="hidden h-4 w-4 lg:block" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-edit-action="later"
          onClick={() => onMove(index, index + 1)}
          disabled={index === count - 1}
          aria-label={t('customize.moveLater', { name })}
          title={t('customize.moveLater', { name })}
          className={CONTROL_CLASS}
        >
          <ChevronDownIcon className="h-4 w-4 lg:hidden" aria-hidden="true" />
          <ChevronRightIcon className="hidden h-4 w-4 lg:block" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-edit-action="remove"
          onClick={() => onRemove(item)}
          aria-label={t('edit.remove', { name })}
          title={t('edit.remove', { name })}
          className={cn(CONTROL_CLASS, 'hover:text-red-600 dark:hover:text-red-400')}
        >
          <XMarkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/**
 * Stands in for a widget whose data says it has nothing to show, in edit mode
 * only, so it can still be moved or removed (DASH-8).
 */
export function WidgetPlaceholder({ item }: { item: DashboardLayoutItem }) {
  const t = useTranslations('dashboard');
  const name = useWidgetName()(item.id);
  return (
    <Card
      padding="md"
      data-testid={`widget-placeholder-${item.id}`}
      className="flex min-h-40 flex-col items-center justify-center gap-2 pt-14 text-center"
    >
      <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
        <WidgetGlyph id={item.id} />
        {name}
      </span>
      <span className="text-xs text-gray-500 dark:text-gray-400">{t('edit.placeholder')}</span>
    </Card>
  );
}
