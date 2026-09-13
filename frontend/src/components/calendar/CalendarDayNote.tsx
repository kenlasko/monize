'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DateInput } from '@/components/ui/DateInput';
import { NOTE_PAPER_CLASS } from '@/components/calendar/note-paper';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { useDateFormat } from '@/hooks/useDateFormat';
import { getErrorMessage } from '@/lib/errors';
import {
  CALENDAR_DAY_NOTE_MAX_LENGTH,
  CALENDAR_DAY_NOTE_MAX_SPAN_DAYS,
} from '@/lib/calendar-day-note';
import { calendarDaysBetween } from '@/lib/calendar-month';
import { dayNoteSpanLength, isMultiDayNote } from '@/lib/day-note-span';
import type { DayNote } from '@/types/calendar';

interface CalendarDayNoteProps {
  /** The day the panel is showing, `YYYY-MM-DD`. */
  date: string;
  /** The note covering that day, if there is one. It may start on another. */
  note?: DayNote;
  onSave: (
    anchorDate: string,
    note: { body: string; startDate: string; endDate: string },
  ) => Promise<unknown>;
  onDelete: (anchorDate: string) => Promise<unknown>;
  /** Told whenever a draft appears or goes, so the grid can ask before leaving. */
  onDirtyChange: (dirty: boolean) => void;
}

/** The draft an open editor holds, and the day it was opened for. */
interface NoteDraft {
  /**
   * The day the editor was opened on. It is what the save is addressed to, so
   * a note reached from its third day is still rewritten whole (I12).
   */
  originDate: string;
  body: string;
  startDate: string;
  endDate: string;
}

/**
 * The reader's own note on one day, or on the run of days that day belongs to:
 * read it, write it, stretch it, remove it.
 *
 * The calendar's only write path, and it moves no money -- which is why it is
 * the one place here that posts anything at all (design I9). The text is stored
 * and rendered as plain text through `LinkifiedText`, never as markup, so a
 * body that looks like a tag reads as the characters that were typed.
 *
 * A note covers `startDate` through `endDate` inclusive, which is how a
 * vacation is one note rather than nine. The editor is reachable from any day
 * the span touches and the save carries the WHOLE span, addressed to the day it
 * was opened on: the server resolves the covering row from that day, so moving
 * either end is one write rather than a delete and a create with a gap between
 * them.
 *
 * The edit captures its date when editing starts (I12): a save that lands after
 * the reader has moved to another day is discarded rather than adopted into
 * whatever is on screen now, and the list refetch is what shows it on the days
 * it belongs to.
 */
export function CalendarDayNote({
  date,
  note,
  onSave,
  onDelete,
  onDirtyChange,
}: CalendarDayNoteProps) {
  const t = useTranslations('calendar');
  const common = useTranslations('common');
  const { formatDate } = useDateFormat();

  /** One problem's message, each key named where next-intl can see it. */
  const spanMessage = useCallback(
    (problem: SpanProblem): string =>
      problem === 'backwards'
        ? t('notes.spanBackwards')
        : problem === 'tooLong'
          ? t('notes.spanTooLong', { days: CALENDAR_DAY_NOTE_MAX_SPAN_DAYS + 1 })
          : t('notes.spanMissesDay'),
    [t],
  );

  const [editing, setEditing] = useState<NoteDraft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // The panel moved to another day while an editor was open: the draft belongs
  // to the day it was opened for, so it does not follow. Handled as information
  // from the previous render rather than an effect.
  const [renderedDate, setRenderedDate] = useState(date);
  if (renderedDate !== date) {
    setRenderedDate(date);
    if (editing !== null && editing.originDate !== date) {
      setEditing(null);
      setError(null);
      onDirtyChange(false);
    }
  }

  /** The stored span, or the open day alone when there is nothing stored. */
  const storedStart = note?.startDate ?? date;
  const storedEnd = note?.endDate ?? date;

  const startEditing = useCallback(() => {
    setEditing({
      originDate: date,
      body: note?.body ?? '',
      startDate: note?.startDate ?? date,
      endDate: note?.endDate ?? date,
    });
    setError(null);
    onDirtyChange(false);
  }, [date, note, onDirtyChange]);

  const cancelEditing = useCallback(() => {
    setEditing(null);
    setError(null);
    onDirtyChange(false);
  }, [onDirtyChange]);

  /**
   * Adopt one field of the draft and report whether anything now differs from
   * what is stored.
   *
   * A change is a value difference, not a field being touched: retyping the
   * same body leaves nothing to discard, so the month may still be stepped
   * without a confirmation.
   */
  const updateDraft = useCallback(
    (patch: Partial<Omit<NoteDraft, 'originDate'>>) => {
      setEditing((current) => {
        if (current === null) return current;
        const next = { ...current, ...patch };
        onDirtyChange(
          next.body !== (note?.body ?? '') ||
            next.startDate !== storedStart ||
            next.endDate !== storedEnd,
        );
        return next;
      });
    },
    [note, storedStart, storedEnd, onDirtyChange],
  );

  const handleSave = useCallback(async () => {
    if (editing === null) return;
    const { originDate, startDate, endDate } = editing;
    const body = editing.body.trim();
    // A blank body is not a delete: removing a note is Delete, which says so.
    if (body.length === 0) return;

    const invalid = spanProblem(originDate, startDate, endDate);
    if (invalid !== null) {
      setError(spanMessage(invalid));
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      await onSave(originDate, { body, startDate, endDate });
      onDirtyChange(false);
      // Adopted only while the panel still shows the day the edit was for.
      setEditing((current) => (current?.originDate === originDate ? null : current));
    } catch (caught) {
      // The draft is kept: a failed save is a reason to try again, not a reason
      // to lose what was written.
      setError(getErrorMessage(caught, t('notes.saveFailed')));
    } finally {
      setIsSaving(false);
    }
  }, [editing, onSave, onDirtyChange, spanMessage, t]);

  const handleDelete = useCallback(async () => {
    setConfirmingDelete(false);
    setIsSaving(true);
    setError(null);
    try {
      await onDelete(date);
      setEditing(null);
      onDirtyChange(false);
    } catch (caught) {
      setError(getErrorMessage(caught, t('notes.deleteFailed')));
    } finally {
      setIsSaving(false);
    }
  }, [date, onDelete, onDirtyChange, t]);

  const deleteMessage = note && isMultiDayNote(note)
    ? t('notes.deleteSpanMessage', { count: dayNoteSpanLength(note) })
    : t('notes.deleteMessage');

  if (editing !== null) {
    const problem = spanProblem(editing.originDate, editing.startDate, editing.endDate);

    return (
      <section className="mb-3 border-b border-gray-200 pb-3 dark:border-gray-700">
        <label
          className="block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
          htmlFor={`day-note-${date}`}
        >
          {t('notes.title')}
        </label>
        <textarea
          id={`day-note-${date}`}
          rows={3}
          value={editing.body}
          maxLength={CALENDAR_DAY_NOTE_MAX_LENGTH}
          onChange={(event) => updateDraft({ body: event.target.value })}
          className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm focus-visible:border-blue-500 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:focus-visible:border-blue-400 dark:focus-visible:ring-blue-400"
        />

        {/* A vacation is one note over a run of days, so the span is edited
            here rather than by writing the same text on each of them. Both ends
            move: the note is addressed to the day it was opened on, which the
            span must still cover. */}
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <DateInput
            label={t('notes.startDate')}
            value={editing.startDate}
            onDateChange={(value) => updateDraft({ startDate: value })}
          />
          <DateInput
            label={t('notes.endDate')}
            value={editing.endDate}
            onDateChange={(value) => updateDraft({ endDate: value })}
          />
        </div>

        {problem === null && editing.endDate > editing.startDate && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('notes.spanCount', {
              count: calendarDaysBetween(editing.startDate, editing.endDate),
            })}
          </p>
        )}

        {(error !== null || problem !== null) && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400" role="alert">
            {error ?? spanMessage(problem!)}
          </p>
        )}

        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving || editing.body.trim().length === 0 || problem !== null}
          >
            {common('save')}
          </Button>
          <Button variant="secondary" size="sm" onClick={cancelEditing} disabled={isSaving}>
            {common('cancel')}
          </Button>
          {note && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
              disabled={isSaving}
            >
              {common('delete')}
            </Button>
          )}
        </div>

        <ConfirmDialog
          isOpen={confirmingDelete}
          title={t('notes.deleteTitle')}
          message={deleteMessage}
          confirmLabel={common('delete')}
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      </section>
    );
  }

  return (
    <section
      className="mb-3 border-b border-gray-200 pb-3 dark:border-gray-700"
      aria-label={t('notes.title')}
    >
      <h4 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('notes.title')}
      </h4>
      {note ? (
        <>
          {/* Which days this note is about, whenever that is not the day being
              read. Without it a note reached from the middle of a vacation
              reads as a note about that one day, and editing it would look like
              it had silently spread. */}
          {isMultiDayNote(note) && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('notes.spanRange', {
                start: formatDate(note.startDate),
                end: formatDate(note.endDate),
              })}
            </p>
          )}
          {/* The same paper the band on the grid is drawn on, so a note is one
              recognisable thing in both places it is read. */}
          <p
            className={`mt-1 whitespace-pre-wrap break-words rounded-md px-2 py-1.5 text-sm ${NOTE_PAPER_CLASS}`}
          >
            <LinkifiedText text={note.body} />
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={startEditing}>
              {common('edit')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
              disabled={isSaving}
            >
              {common('delete')}
            </Button>
          </div>
        </>
      ) : (
        <Button variant="secondary" size="sm" className="mt-1" onClick={startEditing}>
          {t('notes.add')}
        </Button>
      )}

      {error !== null && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <ConfirmDialog
        isOpen={confirmingDelete}
        title={t('notes.deleteTitle')}
        message={deleteMessage}
        confirmLabel={common('delete')}
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </section>
  );
}

/** What is wrong with the span in the editor, if anything. */
type SpanProblem = 'backwards' | 'tooLong' | 'missesDay';

/**
 * What is wrong with a span, or `null` when nothing is.
 *
 * The same three rules the server applies (`resolveDayNoteSpan`), applied here
 * so the reader is told at the field rather than by a 400 with nothing pointing
 * at one. The server is still the one that decides: this disables the button,
 * it does not make the save safe.
 */
function spanProblem(
  anchorDate: string,
  startDate: string,
  endDate: string,
): SpanProblem | null {
  if (endDate < startDate) return 'backwards';
  if (calendarDaysBetween(startDate, endDate) > CALENDAR_DAY_NOTE_MAX_SPAN_DAYS + 1) {
    return 'tooLong';
  }
  if (anchorDate < startDate || anchorDate > endDate) return 'missesDay';
  return null;
}
