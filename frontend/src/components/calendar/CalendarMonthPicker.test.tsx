import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent } from '@/test/render';
import { CalendarMonthPicker } from './CalendarMonthPicker';
import calendarNs from '@/i18n/messages/en/calendar.json';
import common from '@/i18n/messages/en/common.json';

const MONTHS = common.monthsShort as string[];

function renderPicker(month = '2026-06') {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  // The panel measures a real anchor rect; an element in the document is enough
  // for jsdom to answer with zeroes, which is a position like any other.
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const anchorRef = createRef<HTMLElement>() as React.MutableRefObject<HTMLElement | null>;
  anchorRef.current = anchor;

  render(
    <CalendarMonthPicker
      month={month}
      onSelect={onSelect}
      onClose={onClose}
      anchorRef={anchorRef}
    />,
  );
  return { onSelect, onClose };
}

describe('CalendarMonthPicker', () => {
  it('marks the month the calendar is on', () => {
    renderPicker('2026-06');

    expect(screen.getByRole('button', { name: MONTHS[5] })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: MONTHS[0] })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('jumps to a month that is picked', () => {
    const { onSelect, onClose } = renderPicker('2026-06');

    fireEvent.click(screen.getByRole('button', { name: MONTHS[2] }));

    expect(onSelect).toHaveBeenCalledWith('2026-03');
    expect(onClose).toHaveBeenCalled();
  });

  it('steps the year without moving the calendar until a month is picked', () => {
    const { onSelect } = renderPicker('2026-06');

    fireEvent.click(screen.getByRole('button', { name: calendarNs.monthPicker.previousYear }));
    expect(onSelect).not.toHaveBeenCalled();
    // Nothing is pressed once the buttons are for another year: June 2025 is
    // not the month on screen.
    expect(screen.getByRole('button', { name: MONTHS[5] })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: MONTHS[5] }));
    expect(onSelect).toHaveBeenCalledWith('2025-06');
  });

  it('jumps to a month that is typed', () => {
    // Twelve buttons and a year stepper reach next spring in one click and
    // March 1998 in eighty; typing is what makes a distant month reachable.
    const { onSelect, onClose } = renderPicker('2026-06');

    const field = screen.getByLabelText(calendarNs.monthPicker.typeLabel);
    fireEvent.change(field, { target: { value: 'Mar 1998' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('1998-03');
    expect(onClose).toHaveBeenCalled();
  });

  it('reads a bare year as that year of the month on screen', () => {
    const { onSelect } = renderPicker('2026-09');

    const field = screen.getByLabelText(calendarNs.monthPicker.typeLabel);
    fireEvent.change(field, { target: { value: '1998' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('1998-09');
  });

  it('says so at the field rather than moving the calendar somewhere else', () => {
    const { onSelect, onClose } = renderPicker('2026-06');

    const field = screen.getByLabelText(calendarNs.monthPicker.typeLabel);
    fireEvent.change(field, { target: { value: 'tuesday' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(calendarNs.monthPicker.unreadable);
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears the complaint as soon as the reader types again', () => {
    renderPicker('2026-06');

    const field = screen.getByLabelText(calendarNs.monthPicker.typeLabel);
    fireEvent.change(field, { target: { value: 'tuesday' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.change(field, { target: { value: 't' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reaches another year through the stepper, and only through it', () => {
    // The stepper moves the twelve buttons' year without moving the calendar, so
    // the month is chosen in one place. A second pair of whole-year shortcuts
    // under the grid said the same thing twice and is gone.
    const { onSelect } = renderPicker('2026-06');

    fireEvent.click(screen.getByRole('button', { name: calendarNs.monthPicker.previousYear }));
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: MONTHS[5] }));
    expect(onSelect).toHaveBeenCalledWith('2025-06');
  });
});
