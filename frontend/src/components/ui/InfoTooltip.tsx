'use client';

import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';

interface InfoTooltipProps {
  /** Tooltip body text. Shown in the popover and exposed via aria-label. */
  text: string;
  /** Where the popover renders relative to the icon. Defaults to 'bottom'. */
  placement?: 'top' | 'bottom';
  /** Tailwind size classes for the icon. Defaults to 'h-4 w-4'. */
  iconClassName?: string;
}

/**
 * Inline help icon with a desktop-only hover popover. Hidden below the md
 * breakpoint because a hover popover can't be triggered on touch. The text
 * is exposed via aria-label for screen readers; no native title attribute
 * is used so the browser tooltip doesn't duplicate the styled popover.
 */
export function InfoTooltip({
  text,
  placement = 'bottom',
  iconClassName = 'h-4 w-4',
}: InfoTooltipProps) {
  const popoverClasses =
    placement === 'top'
      ? 'left-1/2 -translate-x-1/2 bottom-full mb-2'
      : 'left-0 top-full mt-1';
  return (
    <span
      aria-label={text}
      className="relative hidden md:inline-flex items-center align-middle ml-1 group/tip text-gray-400 hover:text-blue-500 transition-colors cursor-help"
    >
      <QuestionMarkCircleIcon className={iconClassName} />
      <span
        role="tooltip"
        className={`pointer-events-none hidden md:group-hover/tip:block absolute z-20 w-64 whitespace-normal rounded-md bg-gray-900 dark:bg-gray-700 px-2.5 py-2 text-xs font-normal leading-snug text-white shadow-lg ${popoverClasses}`}
      >
        {text}
      </span>
    </span>
  );
}
