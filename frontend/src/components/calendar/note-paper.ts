/**
 * A note's own ground, wherever a note is shown.
 *
 * A note is the one thing on the calendar that is not a figure the server
 * decided, so it is the one thing that looks like paper: Post-It yellow, in the
 * band across the days it covers and in the day panel that reads it. One
 * constant, because the two must not drift into two different yellows.
 *
 * Deliberately not a `bg-<hue>-100`: that shade is the chip palette's
 * (`ACCOUNT_TYPE_META`, `SCHEDULED_KIND_CHIP_CLASSES`), and a note is not a
 * chip -- `calendar.guard.test.ts` holds that line.
 */
export const NOTE_PAPER_CLASS =
  'bg-yellow-200 text-gray-900 ring-1 ring-inset ring-yellow-300 dark:bg-yellow-200/15 dark:text-yellow-100 dark:ring-yellow-200/25';
