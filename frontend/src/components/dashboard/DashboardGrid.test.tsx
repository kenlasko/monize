import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { DashboardGrid } from './DashboardGrid';
import type { DashboardLayout } from './dashboard-layout';
import type { DashboardWidgetContext } from './widget-registry';

// A small registry so the grid's own rules are tested, not the real widgets.
vi.mock('./widget-registry', () => ({
  DASHBOARD_WIDGETS: [
    { id: 'net-worth', render: () => <div data-testid="w-net-worth" /> },
    { id: 'insights', render: () => <div data-testid="w-insights" /> },
    {
      id: 'top-movers',
      shouldRender: (ctx: { hasSecurities: boolean }) => ctx.hasSecurities,
      render: () => <div data-testid="w-top-movers" />,
    },
  ],
  resolveDashboardWidgets: () => [],
}));

const context = (over: Partial<DashboardWidgetContext> = {}) =>
  ({ hasSecurities: true, ...over }) as DashboardWidgetContext;

const LAYOUT: DashboardLayout = [
  { id: 'insights', width: 'third', height: 'compact' },
  { id: 'top-movers', width: 'half', height: 'standard' },
  { id: 'net-worth', width: 'full', height: 'tall' },
];

const renderedIds = () =>
  Array.from(document.querySelectorAll('[data-widget-id]')).map((el) => el.getAttribute('data-widget-id'));

describe('DashboardGrid', () => {
  it('is a twelve-column grid from lg up and one column below, in row flow', () => {
    render(<DashboardGrid layout={LAYOUT} context={context()} />);
    const grid = document.querySelector('[data-tour-id="dashboard-widgets"]') as HTMLElement;
    expect(grid).toHaveClass('grid', 'grid-cols-1', 'lg:grid-cols-12', 'gap-6');
    // DASH-3: `dense` would show widgets out of their stored order.
    expect(grid.className).not.toMatch(/dense/);
  });

  it('renders the widgets in layout order, each in its own item at its own size', () => {
    render(<DashboardGrid layout={LAYOUT} context={context()} />);
    expect(renderedIds()).toEqual(['insights', 'top-movers', 'net-worth']);
    const netWorth = screen.getByTestId('w-net-worth').parentElement as HTMLElement;
    expect(netWorth).toHaveAttribute('data-widget-id', 'net-worth');
    expect(netWorth).toHaveClass('lg:col-span-12', 'lg:min-h-[720px]');
    const insights = screen.getByTestId('w-insights').parentElement as HTMLElement;
    expect(insights).toHaveClass('lg:col-span-4', 'lg:min-h-[390px]');
  });

  it('skips a widget whose data says it has nothing to show', () => {
    render(<DashboardGrid layout={LAYOUT} context={context({ hasSecurities: false })} />);
    expect(renderedIds()).toEqual(['insights', 'net-worth']);
    expect(screen.queryByTestId('w-top-movers')).not.toBeInTheDocument();
  });

  it('renders nothing for an empty layout', () => {
    render(<DashboardGrid layout={[]} context={context()} />);
    expect(renderedIds()).toEqual([]);
  });
});
