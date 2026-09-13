import { describe, it, expect } from 'vitest';
import {
  dayNoteSpanLength,
  dayNoteSpanPosition,
  dayNoteWeekSpans,
  dayNotesByDay,
  isMultiDayNote,
} from './day-note-span';
import type { DayNote } from '@/types/calendar';

function note(startDate: string, endDate: string, body = 'Away'): DayNote {
  return { startDate, endDate, body, updatedAt: '2026-06-09T12:00:00.000Z' };
}

describe('dayNotesByDay', () => {
  it('puts a one-day note on its own day and nowhere else', () => {
    const byDay = dayNotesByDay([note('2026-06-10', '2026-06-10')], '2026-06-01', '2026-06-30');

    expect(byDay.size).toBe(1);
    expect(byDay.get('2026-06-10')?.body).toBe('Away');
  });

  it('puts a run on every day it covers, as the SAME note', () => {
    // The identity matters: the panel opens the editor from whichever day the
    // reader is on, and the save is anchored on that day.
    const vacation = note('2026-06-14', '2026-06-18');
    const byDay = dayNotesByDay([vacation], '2026-06-01', '2026-06-30');

    expect([...byDay.keys()]).toEqual([
      '2026-06-14',
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
    ]);
    for (const day of byDay.values()) expect(day).toBe(vacation);
  });

  it('clips a run to the grid rather than expanding the whole span', () => {
    // A year-long note reaching a 42-day grid must not put 365 entries in a map
    // the grid reads 42 of.
    const byDay = dayNotesByDay([note('2025-01-01', '2026-12-31')], '2026-06-01', '2026-06-30');

    expect(byDay.size).toBe(30);
    expect(byDay.get('2026-06-01')).toBeDefined();
    expect(byDay.get('2026-06-30')).toBeDefined();
  });

  it('carries a run across a month end', () => {
    const byDay = dayNotesByDay([note('2026-01-30', '2026-02-02')], '2026-01-01', '2026-02-28');

    expect([...byDay.keys()]).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
  });

  it('carries a run across a leap day', () => {
    const byDay = dayNotesByDay([note('2024-02-28', '2024-03-01')], '2024-02-01', '2024-03-31');

    expect([...byDay.keys()]).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
  });

  it('drops a note that falls entirely outside the grid', () => {
    // The range query should not have returned one, and stepping backwards from
    // a clipped start past a clipped end is a loop with no end.
    const byDay = dayNotesByDay([note('2025-01-01', '2025-01-05')], '2026-06-01', '2026-06-30');

    expect(byDay.size).toBe(0);
  });

  it('keeps every note when several land in one grid', () => {
    const byDay = dayNotesByDay(
      [note('2026-06-02', '2026-06-03', 'One'), note('2026-06-20', '2026-06-20', 'Two')],
      '2026-06-01',
      '2026-06-30',
    );

    expect(byDay.get('2026-06-02')?.body).toBe('One');
    expect(byDay.get('2026-06-03')?.body).toBe('One');
    expect(byDay.get('2026-06-20')?.body).toBe('Two');
    expect(byDay.size).toBe(3);
  });
});

describe('dayNoteSpanLength', () => {
  it('counts a one-day note as one day', () => {
    expect(dayNoteSpanLength(note('2026-06-10', '2026-06-10'))).toBe(1);
  });

  it('counts both ends of a run', () => {
    expect(dayNoteSpanLength(note('2026-06-14', '2026-06-18'))).toBe(5);
  });
});

describe('isMultiDayNote', () => {
  it('is false for a note that starts and ends on one day', () => {
    expect(isMultiDayNote(note('2026-06-10', '2026-06-10'))).toBe(false);
  });

  it('is true the moment the note reaches a second day', () => {
    expect(isMultiDayNote(note('2026-06-10', '2026-06-11'))).toBe(true);
  });
});

describe('dayNoteSpanPosition', () => {
  it('calls a one-day note only, whichever day is asked about', () => {
    expect(dayNoteSpanPosition(note('2026-06-10', '2026-06-10'), '2026-06-10')).toBe('only');
  });

  it('reads the ends and the middle of a run', () => {
    const vacation = note('2026-06-14', '2026-06-18');

    expect(dayNoteSpanPosition(vacation, '2026-06-14')).toBe('start');
    expect(dayNoteSpanPosition(vacation, '2026-06-16')).toBe('middle');
    expect(dayNoteSpanPosition(vacation, '2026-06-18')).toBe('end');
  });

  it('treats a day before the run as its start, which is where a clipped grid begins', () => {
    // A grid that begins inside a running note draws its first visible day the
    // way it draws a start: with the pencil and the text, so the month says
    // what the note is about rather than opening on a bare bar.
    const vacation = note('2026-06-14', '2026-06-18');

    expect(dayNoteSpanPosition(vacation, '2026-06-13')).toBe('start');
    expect(dayNoteSpanPosition(vacation, '2026-06-19')).toBe('end');
  });
});

describe('dayNoteWeekSpans', () => {
  /** The week of Sunday 7 June 2026, the way the grid hands one over. */
  const week = [
    '2026-06-07',
    '2026-06-08',
    '2026-06-09',
    '2026-06-10',
    '2026-06-11',
    '2026-06-12',
    '2026-06-13',
  ];

  function spansFor(...notes: DayNote[]) {
    return dayNoteWeekSpans(week, dayNotesByDay(notes, week[0], week[6]));
  }

  it('finds nothing in a week no note touches', () => {
    expect(spansFor()).toEqual([]);
    expect(spansFor(note('2026-07-01', '2026-07-03'))).toEqual([]);
  });

  it('gives a one-day note a single column', () => {
    const [span] = spansFor(note('2026-06-10', '2026-06-10'));

    // Wednesday is the fourth column of a Sunday-start week.
    expect(span).toMatchObject({ startColumn: 4, columns: 1, opensHere: true, closesHere: true });
  });

  it('gives a run ONE band over all its columns, not one band per day', () => {
    // The whole point: a span is a single element across the days it covers, so
    // there is no seam between days to hide and the text has the run's width.
    const spans = spansFor(note('2026-06-10', '2026-06-13'));

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      startColumn: 4,
      columns: 4,
      opensHere: true,
      closesHere: true,
    });
  });

  it('opens square where a run arrives from the week before', () => {
    // Saturday 6 June to Tuesday 9 June: this week draws Sunday to Tuesday, and
    // the band must not pretend the note begins on Sunday.
    const [span] = spansFor(note('2026-06-06', '2026-06-09'));

    expect(span).toMatchObject({ startColumn: 1, columns: 3, opensHere: false, closesHere: true });
  });

  it('closes square where a run carries on into the week after', () => {
    const [span] = spansFor(note('2026-06-12', '2026-06-20'));

    expect(span).toMatchObject({ startColumn: 6, columns: 2, opensHere: true, closesHere: false });
  });

  it('covers the whole week for a note that spans it entirely', () => {
    const [span] = spansFor(note('2026-05-30', '2026-06-30'));

    expect(span).toMatchObject({ startColumn: 1, columns: 7, opensHere: false, closesHere: false });
  });

  it('keeps two notes in one week apart, left to right', () => {
    const spans = spansFor(
      note('2026-06-12', '2026-06-13', 'Lisbon'),
      note('2026-06-08', '2026-06-09', 'Dentist'),
    );

    expect(spans.map((span) => [span.note.body, span.startColumn, span.columns])).toEqual([
      ['Dentist', 2, 2],
      ['Lisbon', 6, 2],
    ]);
  });

  it('carries the note itself, so a band can print it and be keyed by it', () => {
    const lisbon = note('2026-06-10', '2026-06-11', 'Away in Lisbon');
    const [span] = spansFor(lisbon);

    expect(span.note).toBe(lisbon);
  });
});
