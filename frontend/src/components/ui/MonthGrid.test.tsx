import { createRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, renderInLocale, screen, fireEvent, within, act } from '@/test/render';
import { MonthGrid, type MonthGridDay, type MonthGridHandle } from './MonthGrid';
import { monthGridDays } from '@/lib/calendar-month';
import commonNs from '@/i18n/messages/en/common.json';
import ptCommonNs from '@/i18n/messages/pt/common.json';
import ptCalendarNs from '@/i18n/messages/pt/calendar.json';

const MONTH = '2026-06';
const TODAY = '2026-06-15';

function grid(overrides: Partial<React.ComponentProps<typeof MonthGrid>> = {}) {
  return (
    <MonthGrid
      month={MONTH}
      weekStartsOn={0}
      today={TODAY}
      renderDay={(day: MonthGridDay) => <span>{day.date.slice(-2)}</span>}
      {...overrides}
    />
  );
}

function renderGrid(overrides: Partial<React.ComponentProps<typeof MonthGrid>> = {}) {
  return render(grid(overrides));
}

function cells() {
  return screen.getAllByRole('gridcell');
}

describe('MonthGrid', () => {
  it('draws whole weeks of the month with the adjacent days that complete them', () => {
    renderGrid();
    expect(cells()).toHaveLength(monthGridDays(MONTH, 0).length);
  });

  it('labels the columns in the reader week order', () => {
    renderGrid({ weekStartsOn: 1 });

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    expect(commonNs.weekdaysMin).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
  });

  it('keeps seven columns under a locale whose abbreviations repeat', () => {
    // pt writes quarta and quinta alike ("qu"), and segunda and sexta alike
    // ("se"). Keyed by label, the second of each pair collides with the first,
    // and moving the week start reconciles the row into nine headers in the
    // wrong order -- weekday names sitting over days they do not name.
    expect(ptCommonNs.weekdaysMin).toEqual(['do', 'se', 'te', 'qu', 'qu', 'se', 'sá']);

    const { rerender } = renderInLocale(grid({ weekStartsOn: 0 }), {
      locale: 'pt',
      messages: { common: ptCommonNs, calendar: ptCalendarNs },
    });
    rerender(grid({ weekStartsOn: 1 }));

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['se', 'te', 'qu', 'qu', 'se', 'sá', 'do']);
  });

  it('starts the first row on the reader week start', () => {
    renderGrid({ weekStartsOn: 1 });
    // 2026-06-01 is a Monday, so a Monday-start grid borrows nothing at the front.
    expect(cells()[0]).toHaveAttribute('aria-label', '06/01/2026');
  });

  it('marks the server today, and only it', () => {
    renderGrid();

    const current = cells().filter((cell) => cell.getAttribute('aria-current') === 'date');
    expect(current).toHaveLength(1);
    expect(within(current[0]).getByText('15')).toBeInTheDocument();
  });

  it('takes today from its prop, never from the browser clock', () => {
    // Design I2: which day is "today" is the server's answer, so a grid handed
    // a different one must mark that one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'));
    try {
      renderGrid({ today: '2026-06-20' });
      const current = cells().filter((cell) => cell.getAttribute('aria-current') === 'date');
      expect(within(current[0]).getByText('20')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the open day selected and the rest not', () => {
    renderGrid({ selectedDate: '2026-06-10' });

    const selected = cells().filter((cell) => cell.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAttribute('aria-label', '06/10/2026');
  });

  it('reports the day the reader clicked', () => {
    const onSelectDay = vi.fn();
    renderGrid({ onSelectDay });

    fireEvent.click(screen.getByLabelText('06/10/2026'));

    expect(onSelectDay).toHaveBeenCalledWith('2026-06-10');
  });

  it('leaves a control inside a cell to its own handler', () => {
    // A chip is its own destination; a click on it must not also open the day.
    const onSelectDay = vi.fn();
    const onChip = vi.fn();
    renderGrid({
      onSelectDay,
      renderDay: (day) => (
        <button type="button" onClick={onChip}>
          chip {day.date}
        </button>
      ),
    });

    fireEvent.click(screen.getByRole('button', { name: 'chip 2026-06-10' }));

    expect(onChip).toHaveBeenCalled();
    expect(onSelectDay).not.toHaveBeenCalled();
  });

  describe('keyboard', () => {
    it('holds one tab stop, on today', () => {
      renderGrid();

      const stops = cells().filter((cell) => cell.getAttribute('tabindex') === '0');
      expect(stops).toHaveLength(1);
      expect(stops[0]).toHaveAttribute('aria-label', '06/15/2026');
    });

    it('puts the tab stop on the open day when there is one', () => {
      renderGrid({ selectedDate: '2026-06-10' });
      expect(screen.getByLabelText('06/10/2026')).toHaveAttribute('tabindex', '0');
    });

    it('falls back to the 1st when neither today nor the open day is in the grid', () => {
      renderGrid({ month: '2026-09', today: TODAY });
      expect(screen.getByLabelText('09/01/2026')).toHaveAttribute('tabindex', '0');
    });

    it.each([
      ['ArrowRight', '06/16/2026'],
      ['ArrowLeft', '06/14/2026'],
      ['ArrowDown', '06/22/2026'],
      ['ArrowUp', '06/08/2026'],
    ])('moves focus a day or a week on %s', (key, expected) => {
      renderGrid();

      fireEvent.keyDown(screen.getByLabelText('06/15/2026'), { key });

      const moved = screen.getByLabelText(expected);
      expect(moved).toHaveAttribute('tabindex', '0');
      expect(moved).toHaveFocus();
    });

    it('stops at the edge of the grid rather than wrapping into another month', () => {
      renderGrid();
      const first = cells()[0];
      fireEvent.click(first);

      fireEvent.keyDown(first, { key: 'ArrowLeft' });
      fireEvent.keyDown(first, { key: 'ArrowUp' });

      expect(first).toHaveAttribute('tabindex', '0');
      expect(cells().filter((cell) => cell.getAttribute('tabindex') === '0')).toHaveLength(1);
    });

    it.each(['Enter', ' '])('opens the focused day on %s', (key) => {
      const onSelectDay = vi.fn();
      renderGrid({ onSelectDay });

      fireEvent.keyDown(screen.getByLabelText('06/15/2026'), { key });

      expect(onSelectDay).toHaveBeenCalledWith('2026-06-15');
    });

    it('leaves a key pressed on a control inside a cell to that control', () => {
      // The click handler has always deferred to a chip inside the cell. The
      // keyboard is the other half of the same rule: Enter on a chip activates
      // the chip, and the grid claiming it means the day panel opens while the
      // chip's own action is cancelled by the preventDefault that claimed it.
      const onSelectDay = vi.fn();
      renderGrid({
        onSelectDay,
        renderDay: (day) => (
          <button type="button">chip {day.date}</button>
        ),
      });

      const chip = screen.getByRole('button', { name: 'chip 2026-06-10' });
      fireEvent.keyDown(chip, { key: 'Enter' });
      fireEvent.keyDown(chip, { key: ' ' });

      expect(onSelectDay).not.toHaveBeenCalled();
    });

    it('does not steal an arrow key from a control inside a cell', () => {
      renderGrid({
        renderDay: (day) => <button type="button">chip {day.date}</button>,
      });

      const before = screen.getByLabelText('06/15/2026');
      expect(before).toHaveAttribute('tabindex', '0');

      fireEvent.keyDown(screen.getByRole('button', { name: 'chip 2026-06-10' }), {
        key: 'ArrowRight',
      });

      expect(before).toHaveAttribute('tabindex', '0');
    });

    it('moves the tab stop back into the grid when the month changes', () => {
      const { rerender } = renderGrid();
      fireEvent.keyDown(screen.getByLabelText('06/15/2026'), { key: 'ArrowRight' });

      rerender(
        <MonthGrid
          month="2026-07"
          weekStartsOn={0}
          today={TODAY}
          renderDay={(day) => <span>{day.date.slice(-2)}</span>}
        />,
      );

      const stops = cells().filter((cell) => cell.getAttribute('tabindex') === '0');
      expect(stops).toHaveLength(1);
      expect(stops[0]).toHaveAttribute('aria-label', '07/01/2026');
    });
  });

  describe('the grid keyboard pattern, at its ends', () => {
    it.each([
      ['Home', '06/14/2026'],
      ['End', '06/20/2026'],
    ])('%s moves to the end of the week the reader is in', (key, expected) => {
      renderGrid();

      fireEvent.keyDown(screen.getByLabelText('06/15/2026'), { key });

      const moved = screen.getByLabelText(expected);
      expect(moved).toHaveAttribute('tabindex', '0');
      expect(moved).toHaveFocus();
    });

    it.each([
      ['Home', '05/31/2026'],
      ['End', '07/04/2026'],
    ])('ctrl+%s moves to the end of the grid', (key, expected) => {
      renderGrid();

      fireEvent.keyDown(screen.getByLabelText('06/15/2026'), { key, ctrlKey: true });

      expect(screen.getByLabelText(expected)).toHaveFocus();
    });

    it('leaves Home and End pressed on a control inside a cell to that control', () => {
      renderGrid({ renderDay: (day) => <button type="button">chip {day.date}</button> });

      fireEvent.keyDown(screen.getByRole('button', { name: 'chip 2026-06-10' }), {
        key: 'Home',
      });

      expect(screen.getByLabelText('06/15/2026')).toHaveAttribute('tabindex', '0');
    });

    it('puts focus back on a day when its host asks', () => {
      const ref = createRef<MonthGridHandle>();
      render(grid({ ref }));

      act(() => ref.current?.focusDay('2026-06-18'));

      expect(screen.getByLabelText('06/18/2026')).toHaveFocus();
      expect(screen.getByLabelText('06/18/2026')).toHaveAttribute('tabindex', '0');
    });
  });

  describe('layout', () => {
    it('lays seven equal columns that cannot push the page sideways', () => {
      const { container } = renderGrid();

      const rows = container.querySelectorAll('[role="row"]');
      rows.forEach((row) => expect(row.className).toContain('grid-cols-7'));
      cells().forEach((cell) => expect(cell.className).toContain('min-w-0'));
      cells().forEach((cell) => expect(cell.className).not.toMatch(/\bw-\[|\bmin-w-\[/));
    });

    it('tells the borrowed days from the month on show', () => {
      renderGrid({
        renderDay: (day) => <span>{day.isCurrentMonth ? 'in' : 'out'}</span>,
      });

      expect(screen.getByLabelText('05/31/2026')).toHaveTextContent('out');
      expect(screen.getByLabelText('06/01/2026')).toHaveTextContent('in');
    });
  });

  describe('what spans days', () => {
    it('hands each week its own dates, in the order it drew them', () => {
      const weeks: string[][] = [];
      renderGrid({
        renderWeekSpans: (week) => {
          weeks.push([...week]);
          return null;
        },
      });

      const days = monthGridDays(MONTH, 0);
      expect(weeks).toHaveLength(days.length / 7);
      expect(weeks[0]).toEqual(days.slice(0, 7));
      expect(weeks.flat()).toEqual(days);
    });

    it('draws the layer over the week, under no cell, and only from sm up', () => {
      const { container } = renderGrid({
        renderWeekSpans: () => <div data-testid="span">Away</div>,
      });

      const layer = screen.getAllByTestId('span')[0].parentElement!;
      // Absolute at the bottom of the week's cells, so a band sits at the bottom
      // of every day it crosses however tall the row is.
      expect(layer.className).toContain('absolute');
      expect(layer.className).toContain('bottom-0');
      // Last in the row, so it paints over the cell borders it crosses.
      expect(layer.previousElementSibling).toBe(
        within(container.querySelectorAll('[role="row"]')[1] as HTMLElement)
          .getAllByRole('gridcell')
          .at(-1),
      );
      // A phone column is 50px wide, which is no room for a band.
      expect(layer.className).toContain('hidden');
      expect(layer.className).toContain('sm:grid');
    });

    it('keeps the layer out of the grid semantics and out of the way of a click', () => {
      const { container } = renderGrid({
        renderWeekSpans: () => <div data-testid="span">Away</div>,
      });

      const layer = screen.getAllByTestId('span')[0].parentElement!;
      expect(layer).toHaveAttribute('aria-hidden', 'true');
      // A click over a band is a click on the day beneath it.
      expect(layer.className).toContain('pointer-events-none');
      // Every row still holds seven gridcells and nothing else a reader meets.
      container.querySelectorAll('[role="row"]').forEach((row, index) => {
        if (index === 0) return; // the weekday header row
        expect(within(row as HTMLElement).getAllByRole('gridcell')).toHaveLength(7);
      });
    });

    it('draws no layer at all when the view has nothing that spans days', () => {
      const { container } = renderGrid();

      expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    });
  });
});
