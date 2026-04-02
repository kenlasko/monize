import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@/test/render';
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

    it('renders as type="date" in browser format mode on desktop', () => {
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

  describe('custom format mode (non-browser format)', () => {
    beforeEach(() => {
      mockUseDateFormat.mockReturnValue({
        formatDate: (d: string) => d,
        dateFormat: 'DD/MM/YYYY',
      });
    });

    it('renders as type="date" in non-browser format mode on desktop', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      // Desktop custom-format mode now uses native date input for segment navigation
      expect(getByLabelText('Date')).toHaveAttribute('type', 'date');
    });

    it('uses YYYY-MM-DD value in native date input regardless of format preference', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      expect(getByLabelText('Date')).toHaveValue('2025-06-15');
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

    it('shows formatted date in tappable display on touch devices', () => {
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

      const { getByLabelText } = renderDateInput('2025-06-15');
      const display = getByLabelText('Date');
      // Touch mode renders a button with the formatted date
      expect(display.tagName).toBe('BUTTON');
      expect(display.textContent).toBe('15/06/2025');

      // Restore the original mock
      window.matchMedia = originalMatchMedia;
    });

    it('opens native picker on tap in touch mode', () => {
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

      const { getByLabelText, container } = renderDateInput('2025-06-15');
      const display = getByLabelText('Date');
      const nativeInput = container.querySelector('input[type="date"]') as HTMLInputElement;

      // Mock showPicker
      nativeInput.showPicker = vi.fn();
      fireEvent.click(display);
      expect(nativeInput.showPicker).toHaveBeenCalled();
      expect(nativeInput.value).toBe('2025-06-15');

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

      const { getByLabelText, container } = renderDateInput('2025-06-15');
      const nativeInput = container.querySelector('input[type="date"]') as HTMLInputElement;

      // Simulate picking a new date from the native picker
      fireEvent.change(nativeInput, { target: { value: '2025-12-25' } });

      expect(onDateChange).toHaveBeenCalledWith('2025-12-25');
      const display = getByLabelText('Date');
      expect(display.textContent).toBe('25/12/2025');

      window.matchMedia = originalMatchMedia;
    });

    it('keyboard shortcuts work in custom format mode', () => {
      const { getByLabelText } = renderDateInput('2025-06-15');
      fireEvent.keyDown(getByLabelText('Date'), { key: 't' });
      expect(onDateChange).toHaveBeenCalledWith('2026-04-01');
    });
  });
});
