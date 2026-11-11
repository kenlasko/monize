import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { WidgetEditOverlay, WidgetPlaceholder } from './WidgetEditOverlay';
import type { DashboardLayoutItem } from './dashboard-layout';

const ITEM: DashboardLayoutItem = { id: 'net-worth', width: 'half', height: 'standard' };

function renderOverlay(over: Partial<Parameters<typeof WidgetEditOverlay>[0]> = {}) {
  const props = { item: ITEM, index: 1, count: 3, onMove: vi.fn(), onRemove: vi.fn(), ...over };
  render(<WidgetEditOverlay {...props} />);
  return props;
}

describe('WidgetEditOverlay', () => {
  it('groups its controls under the widget name, each control named for the widget', () => {
    renderOverlay();
    const group = screen.getByRole('group', { name: 'Net Worth' });
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
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
    for (const button of screen.getAllByRole('button')) {
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

  it('keeps a slot for the grip and one for the size choices', () => {
    renderOverlay({
      grip: <button type="button">grip</button>,
      sizeChoices: <span data-testid="sizes" />,
    });
    const overlay = screen.getByTestId('widget-edit-overlay-net-worth');
    expect(overlay.querySelector('[data-edit-slot="grip"]')).toContainElement(
      screen.getByRole('button', { name: 'grip' }),
    );
    expect(overlay.querySelector('[data-edit-slot="size"]')).toContainElement(screen.getByTestId('sizes'));
  });

  it('draws a plain grip glyph and no size slot until those are given', () => {
    renderOverlay();
    const overlay = screen.getByTestId('widget-edit-overlay-net-worth');
    expect(overlay.querySelector('[data-edit-slot="grip"] [aria-hidden="true"]')).not.toBeNull();
    expect(overlay.querySelector('[data-edit-slot="size"]')).toBeNull();
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
