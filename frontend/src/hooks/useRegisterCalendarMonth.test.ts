import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@/test/render';
import { useRegisterCalendarMonth, type RegisterPageRow } from './useRegisterCalendarMonth';

const TODAY = '2026-11-27';

interface Props {
  rows: readonly RegisterPageRow[];
  start: string;
  end: string;
}

function renderMonth(rows: readonly RegisterPageRow[] = [], startDate = '', endDate = '') {
  return renderHook(
    ({ rows: pageRows, start, end }: Props) =>
      useRegisterCalendarMonth(pageRows, start, end, TODAY),
    { initialProps: { rows, start: startDate, end: endDate } },
  );
}

const row = (id: string, transactionDate: string): RegisterPageRow => ({ id, transactionDate });

/** A newest-first page that runs from early April back into late March. */
const APRIL_INTO_MARCH = [
  row('a', '2026-04-03'),
  row('b', '2026-04-01'),
  row('c', '2026-03-30'),
  row('d', '2026-03-28'),
];

function leave(result: { current: { leaveCalendar: () => string | null } }): string | null {
  let month: string | null = 'unset';
  act(() => {
    month = result.current.leaveCalendar();
  });
  return month;
}

describe('useRegisterCalendarMonth', () => {
  it('opens on the earliest month the page reaches, newest-first or oldest-first', () => {
    expect(renderMonth(APRIL_INTO_MARCH).result.current.month).toBe('2026-03');
    expect(renderMonth([...APRIL_INTO_MARCH].reverse()).result.current.month).toBe('2026-03');
  });

  it('reads a row dated by a timestamp as its day', () => {
    const { result } = renderMonth([row('a', '2025-12-31T00:00:00.000Z')]);
    expect(result.current.month).toBe('2025-12');
  });

  it("opens on the date range's month for an empty page, today's with no range", () => {
    expect(renderMonth([]).result.current.month).toBe('2026-11');
    expect(renderMonth([], '2026-06-01', '2026-06-30').result.current.month).toBe('2026-06');
  });

  it('follows the page while the calendar has not been turned', () => {
    const { result, rerender } = renderMonth(APRIL_INTO_MARCH);
    rerender({ rows: [row('e', '2026-02-14')], start: '', end: '' });
    expect(result.current.month).toBe('2026-02');
  });

  it('hands back the month the reader turned to, and no date range', () => {
    const { result } = renderMonth(APRIL_INTO_MARCH);
    act(() => result.current.setMonth('2026-08'));
    expect(result.current.month).toBe('2026-08');
    expect(leave(result)).toBe('2026-08');
    // Handed over once: the next visit starts from the page again.
    expect(result.current.month).toBe('2026-03');
  });

  it('hands back nothing when the calendar was not turned, or turned back', () => {
    const untouched = renderMonth(APRIL_INTO_MARCH);
    expect(leave(untouched.result)).toBeNull();

    const returned = renderMonth(APRIL_INTO_MARCH);
    act(() => returned.result.current.setMonth('2026-04'));
    act(() => returned.result.current.setMonth('2026-03'));
    expect(leave(returned.result)).toBeNull();
  });

  it('reopens on the month it landed the register on while that row is on the page', () => {
    // The page holding March's first row also reaches back into February;
    // the round trip still comes back to March.
    const landedPage = [row('m1', '2026-03-01'), row('f28', '2026-02-28')];
    const { result, rerender } = renderMonth([row('j', '2026-01-20')]);
    act(() => result.current.setMonth('2026-03'));
    expect(leave(result)).toBe('2026-03');

    act(() => result.current.landedOn('2026-03', 'm1'));
    rerender({ rows: landedPage, start: '', end: '' });
    expect(result.current.month).toBe('2026-03');
    expect(leave(result)).toBeNull();

    // Paged away from that row, the page's own earliest month is back.
    rerender({ rows: [row('j', '2026-01-20')], start: '', end: '' });
    expect(result.current.month).toBe('2026-01');
  });

  it('drops the month it was turned to when the date range changes under it', () => {
    const { result, rerender } = renderMonth(APRIL_INTO_MARCH);
    act(() => result.current.setMonth('2026-08'));

    rerender({ rows: [row('x', '2025-02-10')], start: '2025-02-01', end: '2025-02-28' });

    expect(result.current.month).toBe('2025-02');
    expect(leave(result)).toBeNull();
  });
});
