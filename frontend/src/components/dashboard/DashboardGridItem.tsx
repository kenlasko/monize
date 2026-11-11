import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { HEIGHT_CLASSES, WIDTH_CLASSES, type DashboardLayoutItem } from './dashboard-layout';

/**
 * One widget's place in the dashboard grid: its span and its height floor,
 * both from the layout. The floor is a min-height, never a height, so content
 * that needs more room grows the item and its row (DASH-7).
 *
 * The item is itself a one-cell grid and every child is placed in that cell,
 * so the card fills the item by the grid's own stretch, as it filled the row
 * when it was the grid item itself; an edit overlay can later share the cell.
 * Not a percentage height: `h-full` in an auto-sized row is the cycle WebKit
 * resolves from the neighbouring widget (docs/frontend/ui-conventions.md).
 * The column is `minmax(0, 1fr)` so wide content scrolls inside the card
 * rather than widening it; the row is `auto` so it is never shorter than the
 * card's content.
 */
export function DashboardGridItem({
  item,
  children,
}: {
  item: DashboardLayoutItem;
  children: ReactNode;
}) {
  return (
    <div
      data-widget-id={item.id}
      className={cn(
        "grid grid-cols-1 [grid-template-areas:'cell'] *:[grid-area:cell]",
        WIDTH_CLASSES[item.width],
        HEIGHT_CLASSES[item.height],
      )}
    >
      {children}
    </div>
  );
}
