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
import { DragHandle } from '@/components/ui/DragHandle';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { useIsLgUp } from '@/hooks/useIsMobile';
import type { GridReorderGrip } from '@/hooks/useGridReorder';
import { cn } from '@/lib/utils';
import {
  WIDGET_HEIGHTS,
  widthsOfferedFor,
  type DashboardLayoutItem,
  type WidgetHeight,
  type WidgetWidth,
} from './dashboard-layout';
import { WidgetGlyph, useWidgetName } from './widget-glyphs';
import { WidgetResizeGrip } from './WidgetResizeGrip';

const CONTROL_CLASS = `rounded-md p-1.5 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${HOVER_TOOLBAR_BUTTON}`;

/** Compact segments for the overlay bar, which a third-width card makes narrow. */
const SIZE_SEGMENT_CLASS = 'px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

interface WidgetEditOverlayProps {
  item: DashboardLayoutItem;
  /** The item's place in the draft, and how many the draft holds. */
  index: number;
  count: number;
  /** Move the item from one place to another; the page announces it. */
  onMove: (from: number, to: number) => void;
  onRemove: (item: DashboardLayoutItem) => void;
  /** One width or height choice; the page's draft applies it and the card follows. */
  onResize?: (id: DashboardLayoutItem['id'], size: { width?: WidgetWidth; height?: WidgetHeight }) => void;
  /** The grip's drag and arrow-key callbacks, from the page's `useGridReorder`. */
  grip: GridReorderGrip;
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
  onResize,
  grip,
  sizeChoices,
}: WidgetEditOverlayProps) {
  const t = useTranslations('dashboard');
  const name = useWidgetName()(item.id);
  // The grid has columns from lg up, so sizes only mean something there. Not
  // rendered below lg (rather than hidden by CSS), so a phone's bar holds no
  // control that does nothing and a screen reader never meets one.
  const isWide = useIsLgUp();

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
        {/* The wrapper catches, before DragHandle's own handlers, where the
            press landed (DragHandle reports offsets only) and a cancelled
            pointer (which DragHandle reports as an ordinary end). */}
        <span
          data-edit-slot="grip"
          className="flex flex-shrink-0 items-center"
          onPointerDownCapture={(e) => grip.onPress(e.clientX, e.clientY)}
          onPointerCancelCapture={grip.onCancel}
        >
          {/* DragHandle is touch-action: none, so a finger on it drags; the
              rest of the overlay is not, so a finger on the card scrolls. */}
          <DragHandle
            label={t('edit.grip', { name })}
            title={t('edit.gripHint', { name })}
            onDragStart={grip.onDragStart}
            onDragMove={grip.onDragMove}
            onDragEnd={grip.onDragEnd}
            onNudge={grip.onNudge}
          />
        </span>
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-gray-900 dark:text-gray-100">
          {name}
        </span>
        {(sizeChoices || (isWide && onResize)) && (
          <span data-edit-slot="size" className="flex flex-wrap items-center gap-1">
            {sizeChoices}
            {isWide && onResize && (
              <>
                <SizeGroup
                  caption={t('edit.widthLabel')}
                  label={t('edit.widthOf', { name })}
                  options={widthsOfferedFor(item.id).map((value) => ({
                    value,
                    text: t(`edit.widthShort.${value}`),
                    name: t('edit.presetName', {
                      short: t(`edit.widthShort.${value}`),
                      name: t(`edit.widthName.${value}`),
                    }),
                    title: t(`edit.widthName.${value}`),
                  }))}
                  current={item.width}
                  onPick={(width) => onResize(item.id, { width })}
                />
                <SizeGroup
                  caption={t('edit.heightLabel')}
                  label={t('edit.heightOf', { name })}
                  options={WIDGET_HEIGHTS.map((value) => ({
                    value,
                    text: t(`edit.heightShort.${value}`),
                    name: t('edit.presetName', {
                      short: t(`edit.heightShort.${value}`),
                      name: t(`edit.heightName.${value}`),
                    }),
                    title: t(`edit.heightName.${value}`),
                  }))}
                  current={item.height}
                  onPick={(height) => onResize(item.id, { height })}
                />
              </>
            )}
          </span>
        )}
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
      {isWide && onResize && (
        <WidgetResizeGrip id={item.id} width={item.width} height={item.height} onResize={onResize} />
      )}
    </div>
  );
}

interface SizeGroupProps<T extends string> {
  /** The visible word before the pill ("Width", "Height"). */
  caption: string;
  label: string;
  options: { value: T; text: string; name: string; title: string }[];
  current: T;
  onPick: (value: T) => void;
}

/**
 * One pill of presets with a visible caption. Each button's accessible name
 * begins with its visible text (WCAG 2.5.3), the preset in words following.
 */
function SizeGroup<T extends string>({ caption, label, options, current, onPick }: SizeGroupProps<T>) {
  return (
    <div className="flex items-center gap-1">
      <span aria-hidden="true" className="text-xs text-gray-500 dark:text-gray-400">
        {caption}
      </span>
      <div role="group" aria-label={label} className={SEGMENTED_GROUP_CLASS}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-label={o.name}
            title={o.title}
            aria-pressed={o.value === current}
            onClick={() => onPick(o.value)}
            className={cn(segmentClass(o.value === current), SIZE_SEGMENT_CLASS)}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The widget's tint glyph and name, following the pointer while its grip is
 * dragged. Fixed to the viewport and placed by the reorder hook through
 * `positionRef`, which writes its transform directly so following the
 * pointer re-renders nothing.
 */
export function WidgetDragChip({
  id,
  positionRef,
}: {
  id: DashboardLayoutItem['id'];
  positionRef: (el: HTMLElement | null) => void;
}) {
  const name = useWidgetName()(id);
  return (
    <div
      ref={positionRef}
      aria-hidden="true"
      data-testid="widget-drag-chip"
      className="pointer-events-none fixed left-0 top-0 z-50 flex max-w-64 items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1 text-sm font-medium text-gray-900 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
    >
      <WidgetGlyph id={id} />
      <span className="truncate">{name}</span>
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
      className="flex flex-col pt-14 text-center"
    >
      {/* The tile's height on a phone, where the grid item has no floor; on
          the content, not the card, so the card still fills its item. */}
      <div className="flex min-h-26 flex-1 flex-col items-center justify-center gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
          <WidgetGlyph id={item.id} />
          {name}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{t('edit.placeholder')}</span>
      </div>
    </Card>
  );
}
