import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { DashboardGridItem } from './DashboardGridItem';
import { WIDGET_HEIGHTS, WIDGET_WIDTHS, type DashboardLayoutItem } from './dashboard-layout';

const itemOf = (over: Partial<DashboardLayoutItem> = {}): DashboardLayoutItem => ({
  id: 'net-worth',
  width: 'half',
  height: 'standard',
  ...over,
});

function renderItem(item: DashboardLayoutItem) {
  render(
    <DashboardGridItem item={item}>
      <div data-testid="card">card</div>
    </DashboardGridItem>,
  );
  return screen.getByTestId('card').parentElement as HTMLElement;
}

describe('DashboardGridItem', () => {
  it.each([
    ['third', 'lg:col-span-4'],
    ['half', 'lg:col-span-6'],
    ['twoThirds', 'lg:col-span-8'],
    ['full', 'lg:col-span-12'],
  ] as const)('spans %s as %s', (width, span) => {
    expect(renderItem(itemOf({ width }))).toHaveClass(span);
  });

  it.each([
    ['compact', 'lg:min-h-[390px]'],
    ['standard', 'lg:min-h-[540px]'],
    ['tall', 'lg:min-h-[720px]'],
  ] as const)('carries the %s floor as %s', (height, floor) => {
    expect(renderItem(itemOf({ height }))).toHaveClass(floor);
  });

  it('has no floor at the auto height', () => {
    expect(renderItem(itemOf({ height: 'auto' })).className).not.toMatch(/min-h-/);
  });

  it('names its widget for the reorder hit test', () => {
    expect(renderItem(itemOf({ id: 'insights' }))).toHaveAttribute('data-widget-id', 'insights');
  });

  it('is a one-cell grid that places every child in its cell', () => {
    const item = renderItem(itemOf());
    expect(item).toHaveClass('grid', 'grid-cols-1', "[grid-template-areas:'cell']", '*:[grid-area:cell]');
  });

  it('never pins its own height, at any size (DASH-7)', () => {
    for (const width of WIDGET_WIDTHS) {
      for (const height of WIDGET_HEIGHTS) {
        const { unmount } = render(
          <DashboardGridItem item={itemOf({ width, height })}>
            <div data-testid="pinned-card" />
          </DashboardGridItem>,
        );
        const item = screen.getByTestId('pinned-card').parentElement as HTMLElement;
        expect(item.className).not.toMatch(/(?<![\w-])(?:max-)?h-/);
        expect(item.style.height).toBe('');
        expect(item.style.maxHeight).toBe('');
        unmount();
      }
    }
  });
});
