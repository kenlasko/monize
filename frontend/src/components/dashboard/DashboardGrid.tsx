'use client';

import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { DashboardGridItem } from './DashboardGridItem';
import type { DashboardLayout } from './dashboard-layout';
import { DASHBOARD_WIDGETS, type DashboardWidgetContext } from './widget-registry';

const DEFINITIONS = new Map(DASHBOARD_WIDGETS.map((w) => [w.id, w]));

/**
 * The widget grid: twelve columns from `lg` up, one below. Items flow in
 * layout order without `dense`, so screen order, DOM order and stored order
 * stay one order (DASH-3); a widget whose data says it has nothing to show
 * is skipped.
 */
export function DashboardGrid({
  layout,
  context,
}: {
  layout: DashboardLayout;
  context: DashboardWidgetContext;
}) {
  return (
    <div
      {...tourAnchor(TOUR_ANCHORS.dashboardWidgets)}
      className="grid grid-cols-1 lg:grid-cols-12 gap-6"
    >
      {layout.map((item) => {
        const widget = DEFINITIONS.get(item.id);
        if (!widget || (widget.shouldRender && !widget.shouldRender(context))) return null;
        return (
          <DashboardGridItem key={item.id} item={item}>
            {widget.render(context)}
          </DashboardGridItem>
        );
      })}
    </div>
  );
}
