import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@/test/render';
import { useRegisterCalendarMonth } from './useRegisterCalendarMonth';

const TODAY = '2026-11-27';

function renderMonth(startDate = '', endDate = '') {
  return renderHook(
    ({ start, end }) => useRegisterCalendarMonth(start, end, TODAY),
    { initialProps: { start: startDate, end: endDate } },
  );
}

describe('useRegisterCalendarMonth', () => {
  it("opens on today's month when the register has no date range", () => {
    const { result } = renderMonth();
    expect(result.current.month).toBe('2026-11');
  });

  it("opens on the register's month when its range is one month", () => {
    const { result } = renderMonth('2026-06-01', '2026-06-30');
    expect(result.current.month).toBe('2026-06');
  });

  it('hands the month the reader turned to back to the register as its range', () => {
    const { result } = renderMonth();
    act(() => result.current.setMonth('2026-08'));
    expect(result.current.month).toBe('2026-08');

    let range: ReturnType<typeof result.current.leaveCalendar> = null;
    act(() => {
      range = result.current.leaveCalendar();
    });
    expect(range).toEqual({ startDate: '2026-08-01', endDate: '2026-08-31' });
  });

  it("leaves the register's range alone when the calendar was not turned", () => {
    const { result } = renderMonth('2026-09-01', '2026-11-27');
    let range: ReturnType<typeof result.current.leaveCalendar> = { startDate: '', endDate: '' };
    act(() => {
      range = result.current.leaveCalendar();
    });
    expect(range).toBeNull();
  });

  it('leaves the range alone when the reader turned back to where the calendar opened', () => {
    const { result } = renderMonth('2026-09-01', '2026-11-27');
    act(() => result.current.setMonth('2026-10'));
    act(() => result.current.setMonth('2026-11'));
    let range: ReturnType<typeof result.current.leaveCalendar> = { startDate: '', endDate: '' };
    act(() => {
      range = result.current.leaveCalendar();
    });
    expect(range).toBeNull();
  });

  it('reopens on the month it handed over, so switching back and forth stays put', () => {
    const { result, rerender } = renderMonth();
    act(() => result.current.setMonth('2026-03'));
    let range = { startDate: '', endDate: '' };
    act(() => {
      range = result.current.leaveCalendar() ?? range;
    });
    rerender({ start: range.startDate, end: range.endDate });

    expect(result.current.month).toBe('2026-03');
    let again: ReturnType<typeof result.current.leaveCalendar> = { startDate: '', endDate: '' };
    act(() => {
      again = result.current.leaveCalendar();
    });
    expect(again).toBeNull();
  });

  it('follows a range that changes under it, dropping the month it had been turned to', () => {
    const { result, rerender } = renderMonth();
    act(() => result.current.setMonth('2026-08'));

    rerender({ start: '2025-02-01', end: '2025-02-28' });

    expect(result.current.month).toBe('2025-02');
    let range: ReturnType<typeof result.current.leaveCalendar> = { startDate: '', endDate: '' };
    act(() => {
      range = result.current.leaveCalendar();
    });
    expect(range).toBeNull();
  });
});
