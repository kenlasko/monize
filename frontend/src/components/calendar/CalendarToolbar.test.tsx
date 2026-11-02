import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { CalendarToolbar } from './CalendarToolbar';

function renderToolbar() {
  render(
    <CalendarToolbar
      month="2026-06"
      onMonthChange={vi.fn()}
      today="2026-06-15"
      monthLabelId="month-label"
      availableLayers={['transactions', 'balances'] as const}
      activeLayers={['transactions']}
      onToggleLayer={vi.fn()}
      legendAccountTypes={['CHEQUING']}
      legendHasScheduled
      viewToggle={<button type="button">Switch view</button>}
    />,
  );
}

describe('CalendarToolbar', () => {
  it('reads switch, month navigation, the layers, then the legend', () => {
    // The switch leads the row, where the register's toolbar has it, the month
    // sits in the middle, the layer buttons hold the right-hand end, and the
    // legend is a line of its own below them.
    renderToolbar();

    const toggle = screen.getByRole('button', { name: 'Switch view' });
    const month = screen.getByRole('heading', { level: 2 });
    const legend = screen.getByRole('list', { name: 'Legend' });
    const layers = screen.getByRole('group', { name: 'Layers' });

    expect(toggle.compareDocumentPosition(month)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(month.compareDocumentPosition(layers)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(layers.compareDocumentPosition(legend)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('centres the month in a three-column row from sm up', () => {
    // Equal outer columns centre the month on the page rather than in whatever
    // room the switch leaves; the layers group is pushed to the far end.
    renderToolbar();

    const row = screen.getByRole('button', { name: 'Switch view' }).parentElement!.parentElement!;
    expect(row.className.split(' ')).toContain('sm:grid-cols-[1fr_auto_1fr]');
    const end = screen.getByRole('group', { name: 'Layers' }).parentElement!;
    expect(end.className.split(' ')).toContain('sm:justify-self-end');
    // The legend spans the row beneath rather than sharing the layers' column.
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(legend.parentElement).toBe(row);
    expect(legend.className.split(' ')).toContain('sm:col-span-3');
  });
});
