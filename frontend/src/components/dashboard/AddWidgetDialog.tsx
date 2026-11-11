'use client';

import { useTranslations } from 'next-intl';
import { PlusIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { cn } from '@/lib/utils';
import { DASHBOARD_WIDGETS, type DashboardWidgetId } from './widget-registry';
import { WIDTH_CLASSES, DEFAULT_WIDGET_WIDTH, fitsWidth, type RowGap, type WidgetWidth } from './dashboard-layout';
import { WidgetGlyph, useWidgetName } from './widget-glyphs';

/** Bring the item just added into view once it is drawn. jsdom has no scrollIntoView. */
function scrollToWidget(id: DashboardWidgetId) {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`);
    if (typeof el?.scrollIntoView !== 'function') return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  });
}

interface AddWidgetDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The widgets already in the draft; the rest are offered. */
  shownIds: readonly DashboardWidgetId[];
  /** Put the widget in the draft: at the end at its default size, or in the slot's space. */
  onAdd: (id: DashboardWidgetId) => void;
  /** Opened from a row's gap slot: only widgets that can be this narrow are offered. */
  fitWidth?: WidgetWidth;
}

/**
 * The widgets not on the dashboard, in registry order. From the end tile
 * choosing one adds it at the end; from a gap slot only the widgets that fit
 * the space are listed, and the one chosen fills it.
 */
export function AddWidgetDialog({ isOpen, onClose, shownIds, onAdd, fitWidth }: AddWidgetDialogProps) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  const widgetName = useWidgetName();
  const offered = DASHBOARD_WIDGETS.filter(
    (w) => !shownIds.includes(w.id) && (!fitWidth || fitsWidth(w.id, fitWidth)),
  );

  const choose = (id: DashboardWidgetId) => {
    onAdd(id);
    onClose();
    scrollToWidget(id);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="lg"
      className="p-6"
      pushHistory
      title={t('edit.addTitle')}
      description={fitWidth ? t('edit.addSlotDescription') : t('edit.addDescription')}
    >
      {offered.length === 0 ? (
        <EmptyState
          icon={<Squares2X2Icon />}
          title={fitWidth ? t('edit.addSlotEmpty') : t('edit.addEmpty')}
          className="py-6"
        />
      ) : (
        <ul className="-mx-2">
          {offered.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                data-testid={`add-widget-${w.id}`}
                onClick={() => choose(w.id)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${HOVER_ROW_ON_CARD}`}
              >
                <WidgetGlyph id={w.id} />
                <span className="min-w-0 flex-1 truncate">{widgetName(w.id)}</span>
                <PlusIcon className="h-4 w-4 flex-shrink-0 text-gray-400" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end pt-4">
        <Button variant="outline" onClick={onClose}>
          {tc('close')}
        </Button>
      </div>
    </Modal>
  );
}

/** The dashed add tile's look, shared by the end tile and the gap slots. */
const DASHED_TILE =
  'flex items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-sm font-medium text-gray-600 transition-colors motion-reduce:transition-none hover:border-blue-500 hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:text-gray-300 dark:hover:border-blue-400 dark:hover:text-blue-400';

/**
 * The empty end of a short row, from `lg` up, in edit mode: a dashed slot of
 * exactly the space left, so it fills its row and moves no widget. It
 * stretches with its row; the floor is on its content, for a last row with
 * nothing else in it. `data-gap-index` and `data-gap-width` are what the
 * reorder hook hit-tests; `highlighted` while a dragged widget would drop in.
 */
export function AddWidgetSlot({
  gap,
  highlighted,
  onClick,
}: {
  gap: RowGap;
  highlighted: boolean;
  onClick: (gap: RowGap) => void;
}) {
  const t = useTranslations('dashboard');
  return (
    <button
      type="button"
      data-testid={`add-widget-slot-${gap.index}`}
      data-gap-index={gap.index}
      data-gap-width={gap.width}
      data-drop-target={highlighted || undefined}
      aria-label={t('edit.addToSpace', { width: t(`edit.widthName.${gap.width}`) })}
      onClick={() => onClick(gap)}
      className={cn(
        WIDTH_CLASSES[gap.width],
        DASHED_TILE,
        highlighted && 'border-blue-500 bg-blue-50 text-blue-600 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-400',
      )}
    >
      <span className="flex min-h-32 items-center gap-2">
        <PlusIcon className="h-5 w-5" aria-hidden="true" />
        {t('edit.addWidget')}
      </span>
    </button>
  );
}

/**
 * The dashed tile that ends the grid in edit mode. With no widget left it
 * carries the reason Done is disabled beside it.
 */
export function AddWidgetTile({ onClick, empty }: { onClick: () => void; empty: boolean }) {
  const t = useTranslations('dashboard');
  return (
    <>
      <button
        type="button"
        data-testid="add-widget-tile"
        data-edit-slot="add"
        onClick={onClick}
        className={`${WIDTH_CLASSES[DEFAULT_WIDGET_WIDTH]} min-h-32 gap-2 ${DASHED_TILE}`}
      >
        <PlusIcon className="h-5 w-5" aria-hidden="true" />
        {t('edit.addWidget')}
      </button>
      {empty && (
        <p
          role="status"
          className={`${WIDTH_CLASSES[DEFAULT_WIDGET_WIDTH]} self-center text-sm text-amber-600 dark:text-amber-400`}
        >
          {t('customize.atLeastOne')}
        </p>
      )}
    </>
  );
}
