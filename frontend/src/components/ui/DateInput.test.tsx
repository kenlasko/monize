import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@/test/render';
import { DateInput } from './DateInput';

// Default to browser format (native date input mode)
const mockUseDateFormat = vi.fn(() => ({
  formatDate: (d: string) => d,
  dateFormat: 'browser',
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
    mockUseDateFormat.mockReturnValue({ formatDate: (d: string) => d, dateFormat: 'browser' });
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

    it('PageUp sets first day of previous month', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'PageUp' });
      expect(onDateChange).toHaveBeenCalledWith('2025-05-01');
    });

    it('PageDown sets first day of following month', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'PageDown' });
      expect(onDateChange).toHaveBeenCalledWith('2025-07-01');
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
      const { getByLabelText } = renderDateInput('2025-01-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 'PageUp' });
      expect(onDateChange).toHaveBeenCalledWith('2024-12-01');
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
      getByLabelText('Date').dispatchEvent(event);
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

    it('renders as type="date" in browser format mode', () => {
      const { getByLabelText } = renderDateInput();
      expect(getByLabelText('Date')).toHaveAttribute('type', 'date');
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

  describe('text mode (non-browser format)', () => {
    beforeEach(() => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'DD/MM/YYYY',
      });
    });

    it('renders as type="text" in non-browser format mode', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      expect(getByLabelText('Date')).toHaveAttribute('type', 'text');
    });

    it('shows placeholder with format pattern', () => {
      const { getByLabelText } = renderDateInput();
      expect(getByLabelText('Date')).toHaveAttribute('placeholder', 'DD/MM/YYYY');
    });

    it('displays date in user preferred format', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      expect(getByLabelText('Date')).toHaveValue('15/06/2025');
    });

    it('parses typed date in user format and calls onDateChange', () => {
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date');
      fireEvent.change(input, { target: { value: '25/12/2025' } });
      expect(onDateChange).toHaveBeenCalledWith('2025-12-25');
    });

    it('keyboard shortcuts work in text mode', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 't' });
      expect(onDateChange).toHaveBeenCalledWith('2026-04-01');
    });

    it('reformats display on blur', () => {
      const { getByLabelText } = renderDateInput('');
      const input = getByLabelText('Date');
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '5/3/2025' } });
      fireEvent.blur(input);
      expect(input).toHaveValue('05/03/2025');
    });

    it('reverts to last valid value on blur with invalid input', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      const input = getByLabelText('Date');
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'invalid' } });
      fireEvent.blur(input);
      expect(input).toHaveValue('15/06/2025');
    });

    it('works with MM/DD/YYYY format', () => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'MM/DD/YYYY',
      });
      const { getByLabelText } = renderDateInput('2025-06-15');
      expect(getByLabelText('Date')).toHaveValue('06/15/2025');
    });

    it('works with DD-MMM-YYYY format', () => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'DD-MMM-YYYY',
      });
      const { getByLabelText } = renderDateInput('2025-06-15');
      expect(getByLabelText('Date')).toHaveValue('15-Jun-2025');
    });

    it('works with YYYY-MM-DD format', () => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'YYYY-MM-DD',
      });
      const { getByLabelText } = renderDateInput('2025-06-15');
      expect(getByLabelText('Date')).toHaveValue('2025-06-15');
    });

    it('reads initial value from DOM ref when no value prop is provided (react-hook-form pattern)', async () => {
      // Simulate react-hook-form: no value prop, value set through the ref after mount
      const refCallback = vi.fn();
      const { getByLabelText } = render(
        <DateInput
          label="Date"
          ref={(node) => {
            refCallback(node);
            // Simulate react-hook-form setting the value through the ref
            if (node) {
              node.value = '2025-09-20';
            }
          }}
          onDateChange={onDateChange}
          onChange={() => {}}
        />
      );

      // Wait for the microtask/timeout that reads the DOM value
      await vi.advanceTimersByTimeAsync(0);

      const input = getByLabelText('Date');
      expect(input).toHaveValue('20/09/2025');
    });
  });
});
