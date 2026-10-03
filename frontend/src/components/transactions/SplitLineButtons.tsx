'use client';

/**
 * The trash button at the end of a split line. The transaction form's
 * `SplitEditor` and the rule editor's split action both draw it, so a line is
 * removed the same way on both screens.
 */

const REMOVE_CLASS =
  'text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed';

interface RemoveSplitLineButtonProps {
  onClick: () => void;
  disabled?: boolean;
  /** The tooltip; it is the accessible name too, as the icon has no text. */
  title: string;
}

export function RemoveSplitLineButton({ onClick, disabled, title }: RemoveSplitLineButtonProps) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={REMOVE_CLASS} title={title}>
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
        />
      </svg>
    </button>
  );
}
