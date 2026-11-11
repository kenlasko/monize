import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { WidgetDragChip, WidgetEditOverlay, WidgetPlaceholder } from './WidgetEditOverlay';
import type { DashboardLayoutItem } from './dashboard-layout';

const mockMatches = vi.hoisted(() => ({ wide: true }));
vi.mock('@/hooks/useIsMobile', () => ({
  useMediaQuery: (query: string) => (query.includes('min-width: 1024px') ? mockMatches.wide : false),
}));

const ITEM: DashboardLayoutItem = { id: 'net-worth', width: 'half', height: 'standard' };

const gripHandlers = () => ({
  onPress: vi.fn(),
  onDragStart: vi.fn(),
  onDragMove: vi.fn(),
  onDragEnd: vi.fn(),
  onCancel: vi.fn(),
  onNudge: vi.fn(),
});

function renderOverlay(over: Partial<Parameters<typeof WidgetEditOverlay>[0]> = {}) {
  const props = { item: ITEM, index: 1, count: 3, onMove: vi.fn(), onRemove: vi.fn(), grip: gripHandlers(), ...over };
  render(<WidgetEditOverlay {...props} />);
  return props;
}

describe('WidgetEditOverlay', () => {
  it('places the corner resize grip on a wide screen only', () => {
    const { unmount } = render(
      <WidgetEditOverlay item={ITEM} index={0} count={1} onMove={vi.fn()} onRemove={vi.fn()} onResize={vi.fn()} grip={gripHandlers()} />,
    );
    expect(screen.getByRole('button', { name: 'Resize Net Worth' })).toBeInTheDocument();
    unmount();
    mockMatches.wide = false;
    render(
      <WidgetEditOverlay item={ITEM} index={0} count={1} onMove={vi.fn()} onRemove={vi.fn()} onResize={vi.fn()} grip={gripHandlers()} />,
    );
    expect(screen.queryByRole('button', { name: 'Resize Net Worth' })).not.toBeInTheDocument();
    mockMatches.wide = true;
  });

  it('groups its controls under the widget name, each control named for the widget', () => {
    renderOverlay();
    const group = screen.getByRole('group', { name: 'Net Worth' });
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Move Net Worth',
      'Move Net Worth earlier',
      'Move Net Worth later',
      'Remove Net Worth',
    ]);
  });

  it('moves one place earlier or later', () => {
    const { onMove } = renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: 'Move Net Worth earlier' }));
    expect(onMove).toHaveBeenLastCalledWith(1, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Move Net Worth later' }));
    expect(onMove).toHaveBeenLastCalledWith(1, 2);
  });

  it('cannot move the first widget earlier or the last one later', () => {
    renderOverlay({ index: 0, count: 1 });
    expect(screen.getByRole('button', { name: 'Move Net Worth earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Net Worth later' })).toBeDisabled();
  });

  it('removes the widget', () => {
    const { onRemove } = renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Net Worth' }));
    expect(onRemove).toHaveBeenCalledWith(ITEM);
  });

  it('points up and down in the phone stack, left and right in the wide grid', () => {
    renderOverlay();
    const earlier = screen.getByRole('button', { name: 'Move Net Worth earlier' });
    const [phone, wide] = Array.from(earlier.querySelectorAll('svg'));
    expect(phone).toHaveClass('lg:hidden');
    expect(wide).toHaveClass('hidden', 'lg:block');
  });

  it('rings focus only for the keyboard, and animates its hover only with motion allowed', () => {
    renderOverlay();
    // The grip is the shared DragHandle, whose own ring is `focus:`; its press
    // never takes focus (it prevents the default), so only the keyboard rings it.
    const grip = screen.getByRole('button', { name: 'Move Net Worth' });
    expect(grip.className).toContain('motion-reduce:transition-none');
    for (const button of screen.getAllByRole('button').filter((b) => b !== grip)) {
      expect(button.className).toContain('focus-visible:ring-2');
      expect(button.className).not.toMatch(/(?<![\w-])focus:ring/);
      expect(button.className).toContain('motion-reduce:transition-none');
    }
  });

  it('lets a press on the card through, taking pointer events only on its bar', () => {
    renderOverlay();
    const overlay = screen.getByTestId('widget-edit-overlay-net-worth');
    expect(overlay).toHaveClass('pointer-events-none');
    expect(screen.getByRole('group', { name: 'Net Worth' })).toHaveClass('pointer-events-auto');
  });

  it('keeps a slot for the size choices, and none until they are given', () => {
    renderOverlay({ sizeChoices: <span data-testid="sizes" /> });
    const overlay = screen.getByTestId('widget-edit-overlay-net-worth');
    expect(overlay.querySelector('[data-edit-slot="size"]')).toContainElement(screen.getByTestId('sizes'));
  });

  it('draws no size slot when there is nothing to put in it', () => {
    renderOverlay();
    expect(screen.getByTestId('widget-edit-overlay-net-worth').querySelector('[data-edit-slot="size"]')).toBeNull();
  });
});

describe('WidgetEditOverlay grip', () => {
  it('is the drag handle, named for the widget, saying it drags or takes the arrow keys', () => {
    renderOverlay();
    const grip = screen.getByRole('button', { name: 'Move Net Worth' });
    expect(grip.closest('[data-edit-slot="grip"]')).not.toBeNull();
    expect(grip).toHaveAttribute('title', 'Drag to move Net Worth, or press the arrow keys');
  });

  it('alone takes touch-action none, so a finger anywhere else on the card scrolls the page', () => {
    renderOverlay();
    const grip = screen.getByRole('button', { name: 'Move Net Worth' });
    expect(grip).toHaveClass('touch-none');
    const overlay = screen.getByTestId('widget-edit-overlay-net-worth');
    expect(Array.from(overlay.querySelectorAll('.touch-none'))).toEqual([grip]);
    expect(overlay).not.toHaveClass('touch-none');
  });

  it('reports where the press landed before the drag starts, then the offsets', () => {
    const grip = gripHandlers();
    const order: string[] = [];
    grip.onPress.mockImplementation(() => order.push('press'));
    grip.onDragStart.mockImplementation(() => order.push('start'));
    renderOverlay({ grip });
    const handle = screen.getByRole('button', { name: 'Move Net Worth' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 40, clientY: 60 });
    expect(grip.onPress).toHaveBeenCalledWith(40, 60);
    expect(order).toEqual(['press', 'start']);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 90, clientY: 50 });
    expect(grip.onDragMove).toHaveBeenLastCalledWith(50, -10);
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100, clientY: 70 });
    expect(grip.onDragEnd).toHaveBeenLastCalledWith(60, 10);
    expect(grip.onCancel).not.toHaveBeenCalled();
  });

  it('reports a cancelled pointer before DragHandle reports it as an end', () => {
    const grip = gripHandlers();
    const order: string[] = [];
    grip.onCancel.mockImplementation(() => order.push('cancel'));
    grip.onDragEnd.mockImplementation(() => order.push('end'));
    renderOverlay({ grip });
    const handle = screen.getByRole('button', { name: 'Move Net Worth' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 40, clientY: 60 });
    fireEvent.pointerCancel(handle, { pointerId: 1, clientX: 40, clientY: 60 });
    expect(order).toEqual(['cancel', 'end']);
  });

  it('hands the arrow keys on', () => {
    const grip = gripHandlers();
    renderOverlay({ grip });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Net Worth' }), { key: 'ArrowLeft' });
    expect(grip.onNudge).toHaveBeenCalledTimes(1);
    expect(grip.onNudge.mock.calls[0][0]).toBeLessThan(0);
  });
});

describe('WidgetEditOverlay size choices', () => {
  const pressed = (group: HTMLElement) =>
    within(group)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.getAttribute('aria-label'));

  it('offers the widths from the widget minimum up, and all four heights', () => {
    mockMatches.wide = true;
    // Top Movers' minWidth is half, so it offers no third.
    renderOverlay({ item: { id: 'top-movers', width: 'half', height: 'standard' }, onResize: vi.fn() });
    const widths = screen.getByRole('group', { name: 'Width of Top Movers' });
    expect(within(widths).getAllByRole('button').map((b) => b.textContent)).toEqual(['1/2', '2/3', 'Full']);
    const heights = screen.getByRole('group', { name: 'Height of Top Movers' });
    expect(within(heights).getAllByRole('button').map((b) => b.textContent)).toEqual(['Auto', 'S', 'M', 'L']);
  });

  it('offers a third to a widget that allows it, each preset named in words', () => {
    mockMatches.wide = true;
    renderOverlay({ item: { id: 'expenses-pie', width: 'third', height: 'standard' }, onResize: vi.fn() });
    const widths = screen.getByRole('group', { name: /^Width of / });
    expect(within(widths).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'One third width',
      'Half width',
      'Two thirds width',
      'Full width',
    ]);
  });

  it('marks the current width and height pressed', () => {
    mockMatches.wide = true;
    renderOverlay({ item: { id: 'net-worth', width: 'full', height: 'tall' }, onResize: vi.fn() });
    expect(pressed(screen.getByRole('group', { name: 'Width of Net Worth' }))).toEqual(['Full width']);
    expect(pressed(screen.getByRole('group', { name: 'Height of Net Worth' }))).toEqual(['Tall height']);
  });

  it('dispatches one resize with only the dimension pressed', () => {
    mockMatches.wide = true;
    const { onResize } = renderOverlay({ onResize: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Full width' }));
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith('net-worth', { width: 'full' });
    fireEvent.click(screen.getByRole('button', { name: 'Compact height' }));
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenLastCalledWith('net-worth', { height: 'compact' });
  });

  it('renders neither group below lg, and still offers move and remove', () => {
    mockMatches.wide = false;
    renderOverlay({ onResize: vi.fn() });
    expect(screen.queryByRole('group', { name: 'Width of Net Worth' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Height of Net Worth' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Net Worth' })).toBeInTheDocument();
    mockMatches.wide = true;
  });

  it('lets the bar wrap so a narrow card keeps its move and remove buttons', () => {
    mockMatches.wide = true;
    renderOverlay({ onResize: vi.fn() });
    expect(screen.getByRole('group', { name: 'Net Worth' })).toHaveClass('flex-wrap');
    expect(screen.getByRole('group', { name: 'Width of Net Worth' }).parentElement).toHaveClass('flex-wrap');
  });
});

describe('WidgetDragChip', () => {
  it('shows the widget tint glyph and name, fixed and out of the way of the pointer and the reader', () => {
    const positionRef = vi.fn();
    render(<WidgetDragChip id="top-movers" positionRef={positionRef} />);
    const chip = screen.getByTestId('widget-drag-chip');
    expect(chip).toHaveTextContent('Top Movers');
    expect(within(chip).getByTestId('widget-tint-top-movers')).toBeInTheDocument();
    expect(chip).toHaveClass('fixed', 'pointer-events-none');
    expect(chip).toHaveAttribute('aria-hidden', 'true');
    expect(positionRef).toHaveBeenCalledWith(chip);
  });
});

describe('WidgetPlaceholder', () => {
  it('stands in for the widget with its tint glyph and name', () => {
    render(<WidgetPlaceholder item={{ id: 'top-movers', width: 'half', height: 'standard' }} />);
    const tile = screen.getByTestId('widget-placeholder-top-movers');
    expect(tile).toHaveTextContent('Top Movers');
    expect(within(tile).getByTestId('widget-tint-top-movers')).toBeInTheDocument();
    expect(within(tile).getByTestId('widget-type-icon-table')).toBeInTheDocument();
    expect(tile.className).not.toMatch(/(?<![\w:-])h-full\b/);
  });
});
