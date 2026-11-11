import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@/test/render';
import { CustomRecurrenceEditor } from './CustomRecurrenceEditor';
import type { CustomRecurrence, CustomRecurrenceUnit } from '@/lib/custom-recurrence';

/** The editor over a rule it can change, as the form holds one. */
function Harness({
  initial,
  weekStartsOn = 1,
  onRule,
  onUnitChange = vi.fn(),
}: {
  initial: CustomRecurrence;
  weekStartsOn?: number;
  onRule?: (rule: CustomRecurrence) => void;
  onUnitChange?: (unit: CustomRecurrenceUnit) => void;
}) {
  const [rule, setRule] = useState(initial);
  return (
    <CustomRecurrenceEditor
      rule={rule}
      onChange={(next) => {
        setRule(next);
        onRule?.(next);
      }}
      onUnitChange={onUnitChange}
      weekStartsOn={weekStartsOn}
      idPrefix="test"
    />
  );
}

const weekly = (weekdays: number[], interval = 1): CustomRecurrence => ({
  unit: 'WEEK',
  interval,
  weekdays,
  weekStartsOn: 1,
});

describe('CustomRecurrenceEditor', () => {
  it('presses the rule\'s weekdays and summarises them', () => {
    render(<Harness initial={weekly([1, 3, 5])} />);
    expect(screen.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Every week on Mon, Wed, and Fri')).toBeInTheDocument();
  });

  it('toggles a weekday on and off', () => {
    const onRule = vi.fn();
    render(<Harness initial={weekly([1])} onRule={onRule} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thursday' }));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ weekdays: [1, 4] }));
    expect(screen.getByText('Every week on Mon and Thu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ weekdays: [4] }));
  });

  it('orders the weekdays from the reader\'s week start', () => {
    render(<Harness initial={weekly([1])} weekStartsOn={0} />);
    const group = screen.getByRole('group', { name: 'Days of the week' });
    const names = Array.from(group.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    expect(names[0]).toBe('Sunday');
    expect(names[6]).toBe('Saturday');
  });

  it('says a day must be picked when none is, instead of a summary', () => {
    render(<Harness initial={weekly([2])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one day of the week.');
    expect(screen.queryByText(/^Every week/)).not.toBeInTheDocument();
  });

  it('asks the form to switch unit, and not when the pressed unit is pressed again', () => {
    const onUnitChange = vi.fn();
    render(<Harness initial={weekly([1])} onUnitChange={onUnitChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    expect(onUnitChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(onUnitChange).toHaveBeenCalledWith('MONTH');
  });

  it('takes an interval and reads it in the summary', async () => {
    const onRule = vi.fn();
    render(<Harness initial={weekly([2, 4])} onRule={onRule} />);
    const box = screen.getByRole('textbox', { name: 'Repeat every' });
    await act(async () => {
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: '2' } });
      fireEvent.blur(box);
    });
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ interval: 2 }));
    expect(screen.getByText('Every 2 weeks on Tue and Thu')).toBeInTheDocument();
    expect(screen.getByText('weeks on')).toBeInTheDocument();
  });

  it('refuses an emptied interval', async () => {
    render(<Harness initial={weekly([2])} />);
    const box = screen.getByRole('textbox', { name: 'Repeat every' });
    await act(async () => {
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: '' } });
      fireEvent.blur(box);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a number from 1 to 12.');
  });

  it('picks days of the month and the last day, with the short-month hint', () => {
    const onRule = vi.fn();
    render(<Harness initial={{ unit: 'MONTH', interval: 1, monthDays: [5] }} onRule={onRule} />);
    const grid = screen.getByRole('group', { name: 'Days of the month' });
    fireEvent.click(Array.from(grid.querySelectorAll('button')).find((b) => b.textContent === '20')!);
    fireEvent.click(screen.getByRole('button', { name: 'Last day' }));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ monthDays: [5, 20, -1] }));
    expect(screen.getByText('Every month on the 5th, 20th, and last day')).toBeInTheDocument();
    expect(screen.getByText(/falls on its last day/)).toBeInTheDocument();
  });

  it('adds and removes yearly dates, and refuses a date already listed', () => {
    const onRule = vi.fn();
    render(<Harness initial={{ unit: 'YEAR', interval: 1, dates: ['06-01'] }} onRule={onRule} />);
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add date' }));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ dates: ['03-15', '06-01'] }));
    expect(screen.getByText('Every year on Mar 15 and Jun 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add date' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Jun 1' }));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ dates: ['03-15'] }));
    expect(screen.getByText(/29 February falls on 28 February/)).toBeInTheDocument();
  });

  it('offers 29 days for February and clamps a day the new month lacks', () => {
    render(<Harness initial={{ unit: 'YEAR', interval: 1, dates: ['01-01'] }} />);
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '31' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2' } });
    const day = screen.getByLabelText('Day') as HTMLSelectElement;
    expect(day.options).toHaveLength(29);
    expect(day.value).toBe('29');
  });
});
