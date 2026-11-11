import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@/test/render';
import { DashboardGrid, type DashboardGridEditing } from './DashboardGrid';
import type { DashboardLayout, RowGap } from './dashboard-layout';
import type { DashboardWidgetContext } from './widget-registry';

const mockWide = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsLgUp: () => mockWide.value }));

// A small registry so the grid's own rules are tested, not the real widgets.
vi.mock('./widget-registry', () => ({
  DASHBOARD_WIDGETS: [
    { id: 'net-worth', render: () => <div data-testid="w-net-worth" /> },
    { id: 'trivia', render: () => <div data-testid="w-trivia" /> },
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
    const netWorth = screen.getByTestId('w-net-worth').closest('[data-widget-id]') as HTMLElement;
    expect(netWorth).toHaveAttribute('data-widget-id', 'net-worth');
    expect(netWorth).toHaveClass('lg:col-span-12', 'lg:min-h-[720px]');
    const insights = screen.getByTestId('w-insights').closest('[data-widget-id]') as HTMLElement;
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

  describe('in edit mode', () => {
    const editing = (over: Partial<DashboardGridEditing> = {}): DashboardGridEditing => ({
      overlay: (item, index) => <button type="button">{`controls ${item.id} ${index}`}</button>,
      placeholder: (item) => <div data-testid={`placeholder-${item.id}`} />,
      trailing: <button type="button">add tile</button>,
      announcement: '',
      ...over,
    });

    it('draws every widget in the draft, a placeholder for one with nothing to show (DASH-8)', () => {
      render(<DashboardGrid layout={LAYOUT} context={context({ hasSecurities: false })} editing={editing()} />);
      expect(renderedIds()).toEqual(['insights', 'top-movers', 'net-worth']);
      expect(screen.getByTestId('placeholder-top-movers')).toBeInTheDocument();
      expect(screen.queryByTestId('w-top-movers')).not.toBeInTheDocument();
    });

    it('puts the overlay in each item, with its place in the draft, over inert content', () => {
      render(<DashboardGrid layout={LAYOUT} context={context()} editing={editing()} />);
      const controls = screen.getByRole('button', { name: 'controls net-worth 2' });
      const item = controls.closest('[data-widget-id]') as HTMLElement;
      expect(item).toHaveAttribute('data-widget-id', 'net-worth');
      expect(screen.getByTestId('w-net-worth').closest('[inert]')).not.toBeNull();
      expect(controls.closest('[inert]')).toBeNull();
    });

    it('ends the grid with the trailing tile and reads moves out in one polite region', () => {
      render(
        <DashboardGrid layout={LAYOUT} context={context()} editing={editing({ announcement: 'Insights moved' })} />,
      );
      const grid = document.querySelector('[data-tour-id="dashboard-widgets"]') as HTMLElement;
      expect(grid.lastElementChild).toHaveTextContent('add tile');
      const regions = screen.getAllByRole('status');
      expect(regions).toHaveLength(1);
      expect(regions[0]).toHaveAttribute('aria-live', 'polite');
      expect(regions[0]).toHaveTextContent('Insights moved');
    });

    it('draws a drag under way: one insertion line, the dragged widget dimmed, the chip', () => {
      render(
        <DashboardGrid
          layout={LAYOUT}
          context={context()}
          editing={editing({
            reorder: {
              draggingIndex: 0,
              axis: 'x',
              dropIndicator: (index) => (index === 2 ? 'before' : null),
              chip: <div data-testid="chip" />,
            },
          })}
        />,
      );
      const lines = screen.getAllByTestId('drop-indicator-before');
      expect(lines).toHaveLength(1);
      expect(lines[0].closest('[data-widget-id]')).toHaveAttribute('data-widget-id', 'net-worth');
      // The line stands between items in a row.
      expect(lines[0]).toHaveClass('w-[3px]');
      const dimmed = Array.from(document.querySelectorAll('.opacity-30')).map((el) =>
        el.closest('[data-widget-id]')?.getAttribute('data-widget-id'),
      );
      expect(dimmed).toEqual(['insights']);
      // Fixed to the viewport, so not one of the grid's items.
      const grid = document.querySelector('[data-tour-id="dashboard-widgets"]') as HTMLElement;
      expect(grid).not.toContainElement(screen.getByTestId('chip'));
    });

    it('hands its element to the ref the reorder hook measures', () => {
      const ref = { current: null as HTMLDivElement | null };
      render(<DashboardGrid ref={ref} layout={LAYOUT} context={context()} editing={editing()} />);
      expect(ref.current).toHaveAttribute('data-tour-id', 'dashboard-widgets');
    });

    it('has no live region or tile outside edit mode', () => {
      render(<DashboardGrid layout={LAYOUT} context={context()} />);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByText('add tile')).not.toBeInTheDocument();
    });

    describe('gap slots', () => {
      // Row 1 (8 of 12) ends a third short, row 2 (10 of 12) two columns short, row 3 (4 of 12) two thirds short.
      const SECTION_8: DashboardLayout = [
        { id: 'net-worth', width: 'twoThirds', height: 'auto' },
        { id: 'top-movers', width: 'half', height: 'auto' },
        { id: 'insights', width: 'third', height: 'auto' },
        { id: 'trivia', width: 'third', height: 'auto' },
      ];
      const withSlots = () =>
        editing({
          gapSlot: (gap: RowGap) => (
            <button type="button" data-gap-index={gap.index} data-span={gap.span}>{`slot ${gap.width}`}</button>
          ),
        });
      // The grid's children in order, a widget by its id and a slot by its index and span.
      const children = () =>
        Array.from(document.querySelector('[data-tour-id="dashboard-widgets"]')!.children).map((el) =>
          el.hasAttribute('data-gap-index')
            ? `slot@${el.getAttribute('data-gap-index')}:${el.getAttribute('data-span')}`
            : (el.getAttribute('data-widget-id') ?? el.textContent),
        );

      afterEach(() => {
        mockWide.value = false;
      });

      it('draws one at each short row end of a third or more, from lg up, at its place and span', () => {
        mockWide.value = true;
        render(<DashboardGrid layout={SECTION_8} context={context()} editing={withSlots()} />);
        expect(children()).toEqual([
          'net-worth',
          'slot@1:4',
          'top-movers',
          'insights',
          'trivia',
          'slot@4:8',
          'add tile',
        ]);
      });

      it('draws none below lg, where the grid is one column', () => {
        render(<DashboardGrid layout={SECTION_8} context={context()} editing={withSlots()} />);
        expect(document.querySelector('[data-gap-index]')).toBeNull();
      });

      it('draws none outside edit mode', () => {
        mockWide.value = true;
        render(<DashboardGrid layout={SECTION_8} context={context()} />);
        expect(document.querySelector('[data-gap-index]')).toBeNull();
      });

      it('keeps each widget element when its slots come and go', () => {
        mockWide.value = true;
        const { rerender } = render(<DashboardGrid layout={SECTION_8} context={context()} />);
        const before = document.querySelector('[data-widget-id="top-movers"]');
        rerender(<DashboardGrid layout={SECTION_8} context={context()} editing={withSlots()} />);
        expect(document.querySelector('[data-gap-index="1"]')).not.toBeNull();
        expect(document.querySelector('[data-widget-id="top-movers"]')).toBe(before);
      });
    });
  });
});
