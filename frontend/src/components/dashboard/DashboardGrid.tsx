'use client';

import type { ReactNode, Ref } from 'react';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { DropIndicatorLine, type DragAxis, type DropPosition } from '@/hooks/useDragReorder';
import { DashboardGridItem } from './DashboardGridItem';
import type { DashboardLayout, DashboardLayoutItem } from './dashboard-layout';
import { DASHBOARD_WIDGETS, type DashboardWidgetContext } from './widget-registry';

const DEFINITIONS = new Map(DASHBOARD_WIDGETS.map((w) => [w.id, w]));

/**
 * What edit mode adds to the grid. The parts are handed in rather than
 * imported, so the edit-mode code stays in its own chunk (`next/dynamic` in
 * the Dashboard page) and the dashboard's first load does not carry it.
 */
export interface DashboardGridEditing {
  /** The controls drawn over one widget. */
  overlay: (item: DashboardLayoutItem, index: number) => ReactNode;
  /** Stands in for a widget whose data says it has nothing to show (DASH-8). */
  placeholder: (item: DashboardLayoutItem) => ReactNode;
  /** After the last widget: the Add widget tile. */
  trailing: ReactNode;
  /** The latest move, read out by the grid's one polite live region. */
  announcement: string;
  /** A grip drag under way (`useGridReorder`): what to draw while it lasts. */
  reorder?: DashboardGridReorder;
}

export interface DashboardGridReorder {
  /** The widget being dragged, which stays in place, dimmed; null when none is. */
  draggingIndex: number | null;
  /** The flow direction, which decides whether the line stands or lies. */
  axis: DragAxis;
  /** The insertion line for one item, or null; drawn once for the whole grid. */
  dropIndicator: (index: number) => DropPosition | null;
  /** The chip that follows the pointer, fixed to the viewport. */
  chip: ReactNode;
}

/**
 * The widget grid: twelve columns from `lg` up, one below. Items flow in
 * layout order without `dense`, so screen order, DOM order and stored order
 * stay one order (DASH-3). Outside edit mode a widget whose data says it has
 * nothing to show is skipped; in edit mode every widget in the draft is on
 * screen, so it can still be moved or removed (DASH-8).
 */
export function DashboardGrid({
  layout,
  context,
  editing,
  ref,
}: {
  layout: DashboardLayout;
  context: DashboardWidgetContext;
  editing?: DashboardGridEditing;
  /** The grid element, whose items the reorder hook measures. */
  ref?: Ref<HTMLDivElement>;
}) {
  const reorder = editing?.reorder;
  return (
    <>
      <div
        ref={ref}
        {...tourAnchor(TOUR_ANCHORS.dashboardWidgets)}
        className="grid grid-cols-1 lg:grid-cols-12 gap-6"
      >
        {layout.map((item, index) => {
          const widget = DEFINITIONS.get(item.id);
          if (!widget) return null;
          const hasContent = !widget.shouldRender || widget.shouldRender(context);
          if (!editing) {
            if (!hasContent) return null;
            return (
              <DashboardGridItem key={item.id} item={item}>
                {widget.render(context)}
              </DashboardGridItem>
            );
          }
          return (
            <DashboardGridItem
              key={item.id}
              item={item}
              overlay={editing.overlay(item, index)}
              dragging={reorder?.draggingIndex === index}
              indicator={
                reorder && <DropIndicatorLine position={reorder.dropIndicator(index)} axis={reorder.axis} />
              }
            >
              {hasContent ? widget.render(context) : editing.placeholder(item)}
            </DashboardGridItem>
          );
        })}
        {editing?.trailing}
      </div>
      {reorder?.chip}
      {editing && (
        <p role="status" aria-live="polite" className="sr-only" data-testid="dashboard-edit-announcement">
          {editing.announcement}
        </p>
      )}
    </>
  );
}
