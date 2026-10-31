'use client';

import { useRelativeTime } from '@/hooks/useRelativeTime';
import { cn } from '@/lib/utils';

interface RefreshButtonLabelProps {
  /** The action, "Refresh Rates" or "Refresh". */
  label: string;
  /**
   * ISO timestamp of the data the button refreshes. Nothing is drawn under the
   * label while it is absent.
   */
  updatedAt?: string | null;
  /** Display classes for the whole label, e.g. `hidden sm:flex` to collapse it on a phone. */
  className?: string;
}

/**
 * The text of a refresh button: the action on one line and the age of what it
 * refreshes, "(2 hours ago)", on its own line beneath it, so the age does not
 * widen the button until the header actions beside it wrap. Refresh Rates and
 * the quote-price Refresh both draw it from here, so the age reads the same on
 * every page, worded by the one `useRelativeTime` formatter.
 */
export function RefreshButtonLabel({ label, updatedAt, className }: RefreshButtonLabelProps) {
  const formatRelativeTime = useRelativeTime();
  const age = updatedAt ? formatRelativeTime(updatedAt) : '';

  return (
    <span className={cn('flex flex-col items-start text-left', className)}>
      <span className="leading-5">{label}</span>
      {age && (
        <span className="text-xs font-normal leading-4 text-gray-500 dark:text-gray-400">
          ({age})
        </span>
      )}
    </span>
  );
}
