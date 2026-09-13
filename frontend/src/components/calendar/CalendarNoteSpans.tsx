'use client';

import { PencilSquareIcon } from '@heroicons/react/24/outline';
import { dayNoteWeekSpans } from '@/lib/day-note-span';
import type { DayNote } from '@/types/calendar';

interface CalendarNoteSpansProps {
  /** The week's seven days, in the order the grid draws them. */
  week: readonly string[];
  /** The note covering each day of the grid, from `useCalendarDayNotes`. */
  byDay: ReadonlyMap<string, DayNote>;
}

/**
 * A week's notes, as bands across the bottom of the days they cover.
 *
 * One element per run rather than one strip per day: a week in Lisbon is a
 * single band from Wednesday to Sunday with the note read across the whole of
 * it, which is the difference between a span and five cells that happen to
 * agree. A run crossing into the next week closes square on Saturday and opens
 * square again on Sunday, so the break reads as the week ending rather than as
 * the note ending.
 *
 * Decoration only. Every covered day carries the note in its own cell for a
 * screen reader (`CalendarDayCell`), the layer above the cells is `aria-hidden`,
 * and it lets every click through to the day underneath -- so reading or editing
 * a note is the same click on the same day it has always been.
 */
export function CalendarNoteSpans({ week, byDay }: CalendarNoteSpansProps) {
  const spans = dayNoteWeekSpans(week, byDay);

  return (
    <>
      {spans.map((span) => (
        <div
          key={span.note.startDate}
          data-testid="calendar-note-span"
          data-note-columns={span.columns}
          style={{ gridColumn: `${span.startColumn} / span ${span.columns}` }}
          className={`flex min-w-0 items-center gap-1 overflow-hidden bg-gray-50 px-1 py-0.5 text-xs text-gray-600 ring-1 ring-inset ring-gray-200 dark:bg-gray-700/60 dark:text-gray-300 dark:ring-gray-600 ${
            span.opensHere ? 'ml-1 rounded-l' : ''
          } ${span.closesHere ? 'mr-1 rounded-r' : ''}`}
        >
          {/* The pencil marks where the note begins; a band continuing from the
              week above carries the text alone, so the glyph never claims a
              second start for one note. */}
          {span.opensHere && <PencilSquareIcon aria-hidden className="h-3 w-3 shrink-0" />}
          <span className="truncate">{noteLine(span.note)}</span>
        </div>
      ))}
    </>
  );
}

/**
 * The note's first non-empty line, which is what a band has room for.
 *
 * The body is the reader's own text and carries no translated wording of its
 * own, so a band that finds nothing to print prints nothing rather than a label
 * the reader never wrote.
 */
function noteLine(note: DayNote): string {
  return note.body.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
}
