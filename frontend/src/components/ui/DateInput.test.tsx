import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@/test/render';
import { DateInput } from './DateInput';

// Default to the browser preference, resolved to the pattern jsdom's en-US
// locale produces. `browser` is no longer a mode of its own -- every desktop
// field is the same text input reading a concrete pattern (issue #1201).
const mockUseDateFormat = vi.fn(() => ({
  formatDate: (d: string) => d,
  dateFormat: 'browser',
  datePattern: 'MM/DD/YYYY',
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => mockUseDateFormat(),
}));

describe('DateInput', () => {
  const onDateChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 1)); // 2026-04-01
    mockUseDateFormat.mockReturnValue({
      formatDate: (d: string) => d,
      dateFormat: 'browser',
      datePattern: 'MM/DD/YYYY',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderDateInput(value = '') {
    return render(
      <DateInput
        label="Date"
        value={value}
        onDateChange={onDateChange}
        onChange={() => {}}
      />
    );
  }

  describe('keyboard shortcuts', () => {
    it('T sets today', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 't' });
      expect(onDateChange).toHaveBeenCalledWith('2026-04-01');
    });

    it('Y sets first day of year from existing date', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'y' });
      expect(onDateChange).toHaveBeenCalledWith('2025-01-01');
    });

    it('Y sets first day of current year when field is empty', () => {
      const { getByLabelText } = renderDateInput('');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'Y' });
      expect(onDateChange).toHaveBeenCalledWith('2026-01-01');
    });

    it('R sets last day of year from existing date', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'r' });
      expect(onDateChange).toHaveBeenCalledWith('2025-12-31');
    });

    it('R sets last day of current year when field is empty', () => {
      const { getByLabelText } = renderDateInput('');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'R' });
      expect(onDateChange).toHaveBeenCalledWith('2026-12-31');
    });

    it('M sets first day of month from existing date', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'm' });
      expect(onDateChange).toHaveBeenCalledWith('2025-06-01');
    });

    it('M sets first day of current month when field is empty', () => {
      const { getByLabelText } = renderDateInput('');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'M' });
      expect(onDateChange).toHaveBeenCalledWith('2026-04-01');
    });

    it('H sets last day of month from existing date', () => {
      const { getByLabelText } = renderDateInput('2025-02-10');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'h' });
      expect(onDateChange).toHaveBeenCalledWith('2025-02-28');
    });

    it('H sets last day of current month when field is empty', () => {
      const { getByLabelText } = renderDateInput('');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'H' });
      expect(onDateChange).toHaveBeenCalledWith('2026-04-30');
    });

    it('+ adds one day to existing date', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: '+' });
      expect(onDateChange).toHaveBeenCalledWith('2025-06-16');
    });

    it('+ sets tomorrow when field is empty', () => {
      const { getByLabelText } = renderDateInput('');
      fireEvent.keyDown(getByLabelText('Date'), { key: '+' });
      expect(onDateChange).toHaveBeenCalledWith('2026-04-02');
    });

    it('= also adds one day (same key as + without shift)', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: '=' });
      expect(onDateChange).toHaveBeenCalledWith('2025-06-16');
    });

    it('- subtracts one day from existing date', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: '-' });
      expect(onDateChange).toHaveBeenCalledWith('2025-06-14');
    });

    it('- subtracts one day from today when field is empty', () => {
      const { getByLabelText } = renderDateInput('');
      fireEvent.keyDown(getByLabelText('Date'), { key: '-' });
      expect(onDateChange).toHaveBeenCalledWith('2026-03-31');
    });

    it('PageUp sets first day of next month', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'PageUp' });
      expect(onDateChange).toHaveBeenCalledWith('2025-07-01');
    });

    it('PageDown sets first day of previous month', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'PageDown' });
      expect(onDateChange).toHaveBeenCalledWith('2025-05-01');
    });

    it('handles month boundary correctly with +', () => {
      const { getByLabelText } = renderDateInput('2025-01-31');
      fireEvent.keyDown(getByLabelText('Date'), { key: '+' });
      expect(onDateChange).toHaveBeenCalledWith('2025-02-01');
    });

    it('handles year boundary correctly with +', () => {
      const { getByLabelText } = renderDateInput('2025-12-31');
      fireEvent.keyDown(getByLabelText('Date'), { key: '+' });
      expect(onDateChange).toHaveBeenCalledWith('2026-01-01');
    });

    it('handles year boundary correctly with -', () => {
      const { getByLabelText } = renderDateInput('2026-01-01');
      fireEvent.keyDown(getByLabelText('Date'), { key: '-' });
      expect(onDateChange).toHaveBeenCalledWith('2025-12-31');
    });

    it('handles PageUp across year boundary', () => {
      const { getByLabelText } = renderDateInput('2025-12-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'PageUp' });
      expect(onDateChange).toHaveBeenCalledWith('2026-01-01');
    });

    it('handles February last day correctly with H', () => {
      const { getByLabelText } = renderDateInput('2024-02-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'h' });
      // 2024 is a leap year
      expect(onDateChange).toHaveBeenCalledWith('2024-02-29');
    });

    it('does not fire onDateChange for unrecognized keys', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'a' });
      expect(onDateChange).not.toHaveBeenCalled();
    });

    it('prevents default on shortcut keys', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      const event = new KeyboardEvent('keydown', { key: 't', bubbles: true });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      // `fireEvent(element, event)`, not `element.dispatchEvent(event)`: the
      // spy needs this exact event object, and a bare dispatch skips the act()
      // wrapper, so the date the 't' shortcut sets commits outside it.
      fireEvent(getByLabelText('Date'), event);
      expect(preventSpy).toHaveBeenCalled();
    });

    it('calls external onKeyDown handler', () => {
      const externalHandler = vi.fn();
      const { getByLabelText } = render(
        <DateInput
          label="Date"
          value="2025-06-15"
          onDateChange={onDateChange}
          onKeyDown={externalHandler}
          onChange={() => {}}
        />
      );
      fireEvent.keyDown(getByLabelText('Date'), { key: 'a' });
      expect(externalHandler).toHaveBeenCalled();
    });
  });

  describe('rendering', () => {
    it('renders with label', () => {
      const { getByLabelText } = renderDateInput();
      expect(getByLabelText('Date')).toBeInTheDocument();
    });

    it('renders as a text input on desktop even when the format is the browser default', () => {
      // The native date input is what made this field behave unlike every
      // other one: it jumps between its own segments after two keystrokes and
      // will not take a partial date at all (issue #1201).
      const { getByLabelText } = renderDateInput();
      expect(getByLabelText('Date')).toHaveAttribute('type', 'text');
    });

    it('displays error message', () => {
      const { getByText } = render(
        <DateInput
          label="Date"
          error="Date is required"
          onDateChange={onDateChange}
          onChange={() => {}}
        />
      );
      expect(getByText('Date is required')).toBeInTheDocument();
    });

    it('shows keyboard shortcuts tooltip on hover', () => {
      const { container } = renderDateInput();
      const icon = container.querySelector('svg.cursor-help')!;
      expect(icon).toBeInTheDocument();

      // Tooltip content not visible before hover
      expect(document.querySelector('[role="tooltip"]')).not.toBeInTheDocument();

      // Hover to show tooltip
      fireEvent.mouseEnter(icon.parentElement!);
      const tooltip = document.querySelector('[role="tooltip"]')!;
      expect(tooltip).toBeInTheDocument();
      expect(tooltip.textContent).toContain('Keyboard shortcuts');
      expect(tooltip.textContent).toContain('Today');
      expect(tooltip.textContent).toContain('First day of year');
      expect(tooltip.textContent).toContain('Last day of year');
      expect(tooltip.textContent).toContain('First day of month');
      expect(tooltip.textContent).toContain('Last day of month');
      expect(tooltip.textContent).toContain('Next day');
      expect(tooltip.textContent).toContain('Previous day');
      expect(tooltip.textContent).toContain('Previous month');
      expect(tooltip.textContent).toContain('Next month');

      // Mouse leave hides tooltip
      fireEvent.mouseLeave(icon.parentElement!);
      expect(document.querySelector('[role="tooltip"]')).not.toBeInTheDocument();
    });

    it('keeps the shortcuts tooltip inside the viewport near the left edge', () => {
      const { container } = renderDateInput();
      const wrapper = container.querySelector('svg.cursor-help')!.parentElement!;
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        top: 100, bottom: 114, left: 2, right: 16, width: 14, height: 14, x: 2, y: 100,
        toJSON: () => ({}),
      } as DOMRect);
      const originalWidth = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
      try {
        fireEvent.mouseEnter(wrapper);
        const tooltip = document.querySelector('[role="tooltip"]') as HTMLElement;
        expect(parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(8);
        expect(tooltip.className).not.toContain('-translate-x-1/2');
      } finally {
        Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true });
      }
    });

    it('does not show tooltip icon when label is not provided', () => {
      const { container } = render(
        <DateInput
          onDateChange={onDateChange}
          onChange={() => {}}
        />
      );
      expect(container.querySelector('svg.cursor-help')).not.toBeInTheDocument();
    });
  });

  describe('custom format mode (non-browser format)', () => {
    beforeEach(() => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'DD/MM/YYYY',
        datePattern: 'DD/MM/YYYY',
      });
    });

    it('renders as type="text" with formatted display in non-browser format mode on desktop', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      const input = getByLabelText('Date') as HTMLInputElement;
      expect(input).toHaveAttribute('type', 'text');
      expect(input.value).toBe('15/06/2025');
    });

    it('keeps ISO value in a hidden input so react-hook-form reads the canonical format', () => {
      const { container } = renderDateInput('2025-06-15');
      const hidden = container.querySelector('input[type="hidden"]') as HTMLInputElement;
      expect(hidden).not.toBeNull();
      expect(hidden.value).toBe('2025-06-15');
    });

    it('reformats the typed date on blur', () => {
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '25/12/2025' } });
      fireEvent.blur(input);
      expect(input.value).toBe('25/12/2025');
      expect(onDateChange).toHaveBeenCalledWith('2025-12-25');
    });

    it('does not reinterpret a partial date while editing (e.g. backspace leaving month 0)', () => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'MM/DD/YYYY',
        datePattern: 'MM/DD/YYYY',
      });
      const { getByLabelText } = renderDateInput('2026-09-11');
      const input = getByLabelText('Date') as HTMLInputElement;
      // Simulate backspace turning "09/11/2026" into "0/11/2026"
      fireEvent.change(input, { target: { value: '0/11/2026' } });
      // The partial value stays as typed rather than being treated as month 0
      // and rewritten as December 2025
      expect(input.value).toBe('0/11/2026');
      expect(onDateChange).not.toHaveBeenCalled();
    });

    it('reverts to the last valid date on blur when the field contains a partial edit', () => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'MM/DD/YYYY',
        datePattern: 'MM/DD/YYYY',
      });
      const { getByLabelText } = renderDateInput('2026-09-11');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '0/11/2026' } });
      fireEvent.blur(input);
      expect(input.value).toBe('09/11/2026');
    });

    it('lets the user replace a digit by backspacing and retyping (09/11/2026 -> 02/11/2026)', () => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'MM/DD/YYYY',
        datePattern: 'MM/DD/YYYY',
      });
      const { getByLabelText } = renderDateInput('2026-09-11');
      const input = getByLabelText('Date') as HTMLInputElement;
      // Step 1: backspace removes the '9' from '09/11/2026'
      fireEvent.change(input, { target: { value: '0/11/2026' } });
      expect(input.value).toBe('0/11/2026');
      // Step 2: user types '2' at the position, forming a new valid date
      fireEvent.change(input, { target: { value: '02/11/2026' } });
      expect(input.value).toBe('02/11/2026');
      expect(onDateChange).toHaveBeenLastCalledWith('2026-02-11');
    });

    it('does not auto-pad a partial day while the user is mid-edit (12/03/2026 -> 12/23/2026)', () => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'MM/DD/YYYY',
        datePattern: 'MM/DD/YYYY',
      });
      const { getByLabelText } = renderDateInput('2026-12-03');
      const input = getByLabelText('Date') as HTMLInputElement;
      // Simulate removing the '0' from '03' -- "12/3/2026" is a valid partial
      // but we must NOT pad it back to "12/03/2026" while typing.
      fireEvent.change(input, { target: { value: '12/3/2026' } });
      expect(input.value).toBe('12/3/2026');
      // User types '2' to prepend and form '23'
      fireEvent.change(input, { target: { value: '12/23/2026' } });
      expect(input.value).toBe('12/23/2026');
      expect(onDateChange).toHaveBeenLastCalledWith('2026-12-23');
    });

    it('does not auto-pad a partial month while the user is mid-edit (12/03/2026 -> 02/03/2026)', () => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'MM/DD/YYYY',
        datePattern: 'MM/DD/YYYY',
      });
      const { getByLabelText } = renderDateInput('2026-12-03');
      const input = getByLabelText('Date') as HTMLInputElement;
      // Backspace removes the '2' from '12' -- "1/03/2026" parses as Jan 3
      // but must NOT be re-padded to "01/03/2026" mid-edit.
      fireEvent.change(input, { target: { value: '1/03/2026' } });
      expect(input.value).toBe('1/03/2026');
      // User backspaces the '1' and types '0' then '2' -> '02/03/2026'
      fireEvent.change(input, { target: { value: '/03/2026' } });
      fireEvent.change(input, { target: { value: '0/03/2026' } });
      fireEvent.change(input, { target: { value: '02/03/2026' } });
      expect(input.value).toBe('02/03/2026');
      expect(onDateChange).toHaveBeenLastCalledWith('2026-02-03');
    });

    it('reformats to canonical padding on blur after the user types an unpadded date', () => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'MM/DD/YYYY',
        datePattern: 'MM/DD/YYYY',
      });
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '3/5/2025' } });
      expect(input.value).toBe('3/5/2025');
      fireEvent.blur(input);
      expect(input.value).toBe('03/05/2025');
    });

    it('uses the user date format as placeholder when empty', () => {
      const { getByLabelText } = renderDateInput('');
      expect(getByLabelText('Date')).toHaveAttribute('placeholder', 'DD/MM/YYYY');
    });

    it('leaves room for a date typed the long way round', () => {
      const { getByLabelText } = renderDateInput('');
      // The pattern's own length (10) would cut "September 14, 2026" off
      // mid-word. A bound is still worth having; it is just not that one.
      expect(getByLabelText('Date')).toHaveAttribute('maxLength', '24');
    });

    it('keeps a month name typed into a numeric format', () => {
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '15 Jun 2025' } });
      expect(input.value).toBe('15 Jun 2025');
      fireEvent.blur(input);
      expect(onDateChange).toHaveBeenLastCalledWith('2025-06-15');
    });

    it('strips a character that could not be part of any date', () => {
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '15#06#2025' } });
      expect(input.value).toBe('15062025');
    });

    it('accepts a separator the pattern does not itself use', () => {
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date') as HTMLInputElement;
      // '.' is not the separator in DD/MM/YYYY, but it is what a person may
      // type; stripping it turned "15.06.2025" into "15062025".
      fireEvent.change(input, { target: { value: '15.06.2025' } });
      expect(input.value).toBe('15.06.2025');
      fireEvent.blur(input);
      expect(onDateChange).toHaveBeenLastCalledWith('2025-06-15');
    });

    it('reads a slash-separated date in DD-MMM-YYYY', () => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'DD-MMM-YYYY',
        datePattern: 'DD-MMM-YYYY',
      });
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '15/Jun/2025' } });
      expect(input.value).toBe('15/Jun/2025');
      fireEvent.blur(input);
      expect(onDateChange).toHaveBeenLastCalledWith('2025-06-15');
      expect(input.value).toBe('15-Jun-2025');
    });

    describe('segment navigation', () => {
      it('ArrowUp increments the day when the cursor is in the day segment', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        const input = getByLabelText('Date') as HTMLInputElement;
        // "15/06/2025" - cursor in day segment (positions 0-2)
        input.setSelectionRange(1, 1);
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        expect(onDateChange).toHaveBeenCalledWith('2025-06-16');
      });

      it('ArrowDown decrements the month when the cursor is in the month segment', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        const input = getByLabelText('Date') as HTMLInputElement;
        // "15/06/2025" - cursor in month segment (positions 3-5)
        input.setSelectionRange(4, 4);
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(onDateChange).toHaveBeenCalledWith('2025-05-15');
      });

      it('ArrowUp increments the year when the cursor is in the year segment', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        const input = getByLabelText('Date') as HTMLInputElement;
        // "15/06/2025" - cursor in year segment (positions 6-10)
        input.setSelectionRange(8, 8);
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        expect(onDateChange).toHaveBeenCalledWith('2026-06-15');
      });

      it('wraps December to January of the next year on ArrowUp', () => {
        const { getByLabelText } = renderDateInput('2025-12-15');
        const input = getByLabelText('Date') as HTMLInputElement;
        input.setSelectionRange(4, 4);
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        expect(onDateChange).toHaveBeenCalledWith('2026-01-15');
      });

      it('clamps the day when the target month has fewer days', () => {
        const { getByLabelText } = renderDateInput('2025-01-31');
        const input = getByLabelText('Date') as HTMLInputElement;
        input.setSelectionRange(4, 4);
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        // Jan 31 + 1 month -> Feb 28 in 2025 (non-leap year)
        expect(onDateChange).toHaveBeenCalledWith('2025-02-28');
      });

      it('does not handle arrow keys when the field is empty', () => {
        const { getByLabelText } = renderDateInput('');
        const input = getByLabelText('Date') as HTMLInputElement;
        input.setSelectionRange(0, 0);
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        expect(onDateChange).not.toHaveBeenCalled();
      });

      it('re-selects the segment after adjusting so repeated arrows step the same segment', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        const input = getByLabelText('Date') as HTMLInputElement;
        input.setSelectionRange(4, 4);
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        // Month segment range in "15/07/2025" is still 3-5
        expect(input.selectionStart).toBe(3);
        expect(input.selectionEnd).toBe(5);
      });

      it('handles the DD-MMM-YYYY format where the month segment is 3 chars', () => {
        mockUseDateFormat.mockReturnValue({
          formatDate: (d: string) => d,
          dateFormat: 'DD-MMM-YYYY',
          datePattern: 'DD-MMM-YYYY',
        });
        const { getByLabelText } = renderDateInput('2025-06-15');
        const input = getByLabelText('Date') as HTMLInputElement;
        // "15-Jun-2025" - cursor in month name segment (positions 3-6)
        input.setSelectionRange(5, 5);
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        expect(onDateChange).toHaveBeenCalledWith('2025-07-15');
        // Segment range preserved on next render (still 3-6 in "15-Jul-2025")
        expect(input.selectionStart).toBe(3);
        expect(input.selectionEnd).toBe(6);
      });
    });

    it('shows calendar icon button on desktop', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      const calendarBtn = getByLabelText('Open date picker');
      expect(calendarBtn).toBeInTheDocument();
      expect(calendarBtn.tagName).toBe('BUTTON');
    });

    it('opens calendar popover when calendar icon is clicked', () => {
      const { getByLabelText, getByText } = renderDateInput('2025-06-15');
      const calendarBtn = getByLabelText('Open date picker');

      fireEvent.click(calendarBtn);
      // Calendar popover should show with the current month header
      expect(getByText('Jun 2025')).toBeInTheDocument();
    });

    it('updates value when date is picked from calendar popover', () => {
      const { getByLabelText, getByText } = renderDateInput('2025-06-15');

      // Open the calendar
      fireEvent.click(getByLabelText('Open date picker'));
      // Click day 25
      fireEvent.click(getByText('25'));

      expect(onDateChange).toHaveBeenCalledWith('2025-06-25');
    });

    it('shows formatted date in display on touch devices', () => {
      // Simulate a touch device by temporarily overriding matchMedia
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      const { getByText } = renderDateInput('2025-06-15');
      // Touch mode renders the formatted date in a decorative display
      expect(getByText('15/06/2025')).toBeInTheDocument();

      // Restore the original mock
      window.matchMedia = originalMatchMedia;
    });

    it('renders native date input as tappable overlay in touch mode', () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      const { getByLabelText } = renderDateInput('2025-06-15');
      // The native date input is the labelled, interactive element. Tapping it
      // opens the iOS native picker via real user gesture (no showPicker needed).
      const nativeInput = getByLabelText('Date') as HTMLInputElement;
      expect(nativeInput.tagName).toBe('INPUT');
      expect(nativeInput.getAttribute('type')).toBe('date');
      expect(nativeInput.value).toBe('2025-06-15');
      // Positioned to overlay the formatted display so taps reach it directly
      expect(nativeInput.className).toContain('absolute');
      expect(nativeInput.className).toContain('opacity-0');

      window.matchMedia = originalMatchMedia;
    });

    it('updates formatted display when native picker value changes in touch mode', () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      const { getByLabelText, getByText } = renderDateInput('2025-06-15');
      const nativeInput = getByLabelText('Date');

      // Simulate picking a new date from the native picker
      fireEvent.change(nativeInput, { target: { value: '2025-12-25' } });

      expect(onDateChange).toHaveBeenCalledWith('2025-12-25');
      expect(getByText('25/12/2025')).toBeInTheDocument();

      window.matchMedia = originalMatchMedia;
    });

    describe('keyboard shortcuts in custom format mode', () => {
      it('T sets today and updates the formatted display', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        const input = getByLabelText('Date') as HTMLInputElement;
        fireEvent.keyDown(input, { key: 't' });
        expect(onDateChange).toHaveBeenCalledWith('2026-04-01');
        expect(input.value).toBe('01/04/2026');
      });

      it('Y sets the first day of the year', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        fireEvent.keyDown(getByLabelText('Date'), { key: 'y' });
        expect(onDateChange).toHaveBeenCalledWith('2025-01-01');
      });

      it('R sets the last day of the year', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        fireEvent.keyDown(getByLabelText('Date'), { key: 'r' });
        expect(onDateChange).toHaveBeenCalledWith('2025-12-31');
      });

      it('M sets the first day of the month', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        fireEvent.keyDown(getByLabelText('Date'), { key: 'm' });
        expect(onDateChange).toHaveBeenCalledWith('2025-06-01');
      });

      it('H sets the last day of the month', () => {
        const { getByLabelText } = renderDateInput('2025-02-10');
        fireEvent.keyDown(getByLabelText('Date'), { key: 'h' });
        // 2025 is non-leap
        expect(onDateChange).toHaveBeenCalledWith('2025-02-28');
      });

      it('+ adds one day', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        fireEvent.keyDown(getByLabelText('Date'), { key: '+' });
        expect(onDateChange).toHaveBeenCalledWith('2025-06-16');
      });

      it('- subtracts one day', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        fireEvent.keyDown(getByLabelText('Date'), { key: '-' });
        expect(onDateChange).toHaveBeenCalledWith('2025-06-14');
      });

      it('PageUp sets the first day of the next month', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        fireEvent.keyDown(getByLabelText('Date'), { key: 'PageUp' });
        expect(onDateChange).toHaveBeenCalledWith('2025-07-01');
      });

      it('PageDown sets the first day of the previous month', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        fireEvent.keyDown(getByLabelText('Date'), { key: 'PageDown' });
        expect(onDateChange).toHaveBeenCalledWith('2025-05-01');
      });

      it('refreshes the formatted display after a shortcut fires', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        const input = getByLabelText('Date') as HTMLInputElement;
        fireEvent.keyDown(input, { key: '+' });
        // "15/06/2025" -> "16/06/2025"
        expect(input.value).toBe('16/06/2025');
      });
    });

    // When "-" is the literal separator of the active format (e.g. YYYY-MM-DD)
    // it must be typable as a separator instead of being swallowed by the
    // "previous day" shortcut. The +/- shortcuts still work for every format
    // that does not use that character as a separator (covered above).
    describe('separator vs. shortcut collision (YYYY-MM-DD)', () => {
      beforeEach(() => {
        mockUseDateFormat.mockReturnValue({
          formatDate: (d: string) => d,
          dateFormat: 'YYYY-MM-DD',
          datePattern: 'YYYY-MM-DD',
        });
      });

      it('still steps the day back with "-" when a complete date is shown', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        const input = getByLabelText('Date') as HTMLInputElement;
        fireEvent.keyDown(input, { key: '-' });
        // A full canonical date is displayed, so "-" resumes its shortcut role
        expect(onDateChange).toHaveBeenCalledWith('2025-06-14');
      });

      it('does not hijack "-" while the date is incomplete (mid-typing)', () => {
        const { getByLabelText } = renderDateInput('');
        const input = getByLabelText('Date') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '2026' } });
        fireEvent.keyDown(input, { key: '-' });
        // The shortcut must not fire -- "-" is a separator while typing
        expect(onDateChange).not.toHaveBeenCalled();
      });

      it('does not preventDefault on "-" mid-typing so it can be typed as a separator', () => {
        const { getByLabelText } = renderDateInput('');
        const input = getByLabelText('Date') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '2026' } });
        const event = new KeyboardEvent('keydown', { key: '-', bubbles: true, cancelable: true });
        const preventSpy = vi.spyOn(event, 'preventDefault');
        input.dispatchEvent(event);
        expect(preventSpy).not.toHaveBeenCalled();
      });

      it('lets the user type a full YYYY-MM-DD date by hand including the "-"', () => {
        const { getByLabelText } = renderDateInput('');
        const input = getByLabelText('Date') as HTMLInputElement;
        // Type the year then the separator -- the separator survives stripping
        fireEvent.change(input, { target: { value: '2026' } });
        fireEvent.change(input, { target: { value: '2026-' } });
        expect(input.value).toBe('2026-');
        fireEvent.change(input, { target: { value: '2026-06-26' } });
        expect(onDateChange).toHaveBeenLastCalledWith('2026-06-26');
      });

      it('still fires the "+" next-day shortcut (not a separator)', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        fireEvent.keyDown(getByLabelText('Date'), { key: '+' });
        expect(onDateChange).toHaveBeenCalledWith('2025-06-16');
      });

      it('still fires letter shortcuts like T', () => {
        const { getByLabelText } = renderDateInput('2025-06-15');
        fireEvent.keyDown(getByLabelText('Date'), { key: 't' });
        expect(onDateChange).toHaveBeenCalledWith('2026-04-01');
      });
    });
  });

  describe('partial dates (issue #1201)', () => {
    function withPattern(pattern: string) {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: pattern,
        datePattern: pattern,
      });
    }

    it('completes a month and day with the current year on blur', () => {
      withPattern('MM/DD/YYYY');
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '9-14' } });
      fireEvent.blur(input);
      expect(onDateChange).toHaveBeenLastCalledWith('2026-09-14');
      expect(input.value).toBe('09/14/2026');
    });

    it('lets the pattern decide what 7/8 means', () => {
      withPattern('MM/DD/YYYY');
      const { getByLabelText, unmount } = renderDateInput('');
      const monthFirst = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(monthFirst, { target: { value: '7/8' } });
      fireEvent.blur(monthFirst);
      expect(onDateChange).toHaveBeenLastCalledWith('2026-07-08');
      unmount();

      withPattern('DD/MM/YYYY');
      const { getByLabelText: get2 } = renderDateInput('');
      const dayFirst = get2('Date') as HTMLInputElement;
      fireEvent.change(dayFirst, { target: { value: '7/8' } });
      fireEvent.blur(dayFirst);
      expect(onDateChange).toHaveBeenLastCalledWith('2026-08-07');
    });

    it('completes a lone day from the date the field is showing, not today', () => {
      withPattern('MM/DD/YYYY');
      const { getByLabelText } = renderDateInput('2025-03-02');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '14' } });
      fireEvent.blur(input);
      expect(onDateChange).toHaveBeenLastCalledWith('2025-03-14');
    });

    it('accepts a short year', () => {
      withPattern('MM/DD/YYYY');
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '4/1/26' } });
      fireEvent.blur(input);
      expect(onDateChange).toHaveBeenLastCalledWith('2026-04-01');
    });

    it('commits the partial date on Enter, so a form submit carries it', () => {
      withPattern('MM/DD/YYYY');
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '9-14' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onDateChange).toHaveBeenLastCalledWith('2026-09-14');
    });

    it('does not report a partial date while it is still being typed', () => {
      // "9" is a valid day on its own. Announcing it on the keystroke would
      // send a report off fetching a date nobody asked for, mid-word.
      withPattern('MM/DD/YYYY');
      const { getByLabelText } = renderDateInput('2026-01-05');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '9' } });
      fireEvent.change(input, { target: { value: '9-' } });
      fireEvent.change(input, { target: { value: '9-1' } });
      expect(onDateChange).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: '9-14' } });
      fireEvent.blur(input);
      expect(onDateChange).toHaveBeenCalledTimes(1);
      expect(onDateChange).toHaveBeenCalledWith('2026-09-14');
    });

    it('keeps the date it holds when the text cannot be read at all', () => {
      withPattern('MM/DD/YYYY');
      const { getByLabelText } = renderDateInput('2026-01-05');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '13/45' } });
      fireEvent.blur(input);
      expect(input.value).toBe('01/05/2026');
      expect(onDateChange).not.toHaveBeenCalled();
    });

    it('clears the value when the field is emptied', () => {
      // An empty box is the one way to mean "no date"; unreadable text is not.
      withPattern('MM/DD/YYYY');
      const { getByLabelText } = renderDateInput('2026-01-05');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);
      expect(onDateChange).toHaveBeenLastCalledWith('');
    });

    it('reports nothing when a field nobody edited is blurred', () => {
      // Blur runs on every tab-through, and `onDateChange` is not always a
      // plain setter: the transactions filter flips its time period to Custom
      // from it. Re-emitting the value already held is a change the user did
      // not make.
      withPattern('MM/DD/YYYY');
      const { getByLabelText } = renderDateInput('2026-01-05');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.blur(input);
      expect(onDateChange).not.toHaveBeenCalled();
      expect(input.value).toBe('01/05/2026');
    });

    it('still canonicalizes an unpadded date on blur without reporting a change', () => {
      withPattern('MM/DD/YYYY');
      const { getByLabelText } = renderDateInput('2026-01-05');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '1/5/2026' } });
      onDateChange.mockClear();
      fireEvent.blur(input);
      expect(input.value).toBe('01/05/2026');
      expect(onDateChange).not.toHaveBeenCalled();
    });

    it('reads a date typed with a month name', () => {
      withPattern('MM/DD/YYYY');
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '14 sep 2026' } });
      fireEvent.blur(input);
      expect(onDateChange).toHaveBeenLastCalledWith('2026-09-14');
    });
  });
});
