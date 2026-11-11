import { useEffect, type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
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
  // The card sits in the content wrapper, itself the item's child.
  return screen.getByTestId('card').closest('[data-widget-id]') as HTMLElement;
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
        const item = screen.getByTestId('pinned-card').closest('[data-widget-id]') as HTMLElement;
        expect(item.className).not.toMatch(/(?<![\w-])(?:max-)?h-/);
        expect(item.style.height).toBe('');
        expect(item.style.maxHeight).toBe('');
        unmount();
      }
    }
  });

  it('places an overlay in the same cell, over the content made inert', () => {
    render(
      <DashboardGridItem item={itemOf()} overlay={<button type="button">controls</button>}>
        <div data-testid="card">card</div>
      </DashboardGridItem>,
    );
    const content = screen.getByTestId('card').parentElement as HTMLElement;
    expect(content).toHaveAttribute('inert');
    expect(content).toBe(screen.getByTestId('widget-edit-content'));
    // Itself a one-cell grid, so the card still fills the item by stretch.
    expect(content).toHaveClass('grid', "[grid-template-areas:'cell']", '*:[grid-area:cell]');
    const item = content.parentElement as HTMLElement;
    expect(item).toHaveAttribute('data-widget-id', 'net-worth');
    expect(item).toContainElement(screen.getByRole('button', { name: 'controls' }));
    expect(screen.getByRole('button', { name: 'controls' }).closest('[inert]')).toBeNull();
    expect(content.className).not.toMatch(/(?<![\w-])(?:max-)?h-/);
  });

  it('dims the dragged widget further, and holds the insertion line against its own edge', () => {
    const { rerender } = render(
      <DashboardGridItem item={itemOf()} overlay={<span />} indicator={<span data-testid="line" />}>
        <div data-testid="card">card</div>
      </DashboardGridItem>,
    );
    const content = screen.getByTestId('widget-edit-content');
    expect(content).toHaveClass('opacity-60');
    const item = content.parentElement as HTMLElement;
    expect(item).toHaveClass('relative');
    expect(item).toContainElement(screen.getByTestId('line'));
    rerender(
      <DashboardGridItem item={itemOf()} overlay={<span />} dragging>
        <div data-testid="card">card</div>
      </DashboardGridItem>,
    );
    expect(screen.getByTestId('widget-edit-content')).toHaveClass('opacity-30');
    expect(screen.getByTestId('widget-edit-content')).not.toHaveClass('opacity-60');
  });

  it('leaves the content as it is outside edit mode', () => {
    expect(renderItem(itemOf())).not.toHaveAttribute('inert');
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('keeps the content mounted across view -> edit -> view', () => {
    const mounts = vi.fn();
    const unmounts = vi.fn();
    function Probe() {
      useEffect(() => {
        mounts();
        return unmounts;
      }, []);
      return <div data-testid="card">card</div>;
    }
    const view = (overlay?: ReactNode) => (
      <DashboardGridItem item={itemOf()} overlay={overlay}>
        <Probe />
      </DashboardGridItem>
    );
    const { rerender } = render(view());
    const card = screen.getByTestId('card');
    rerender(view(<span />));
    expect(screen.getByTestId('widget-edit-content')).toHaveAttribute('inert');
    rerender(view());
    expect(screen.getByTestId('card')).toBe(card);
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
    expect(document.querySelector('[inert]')).toBeNull();
    expect(screen.queryByTestId('widget-edit-content')).toBeNull();
  });
});
