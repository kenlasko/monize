'use client';

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { PlusIcon } from '@heroicons/react/24/outline';

interface RoundAddButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The accessible name and tooltip: the page's own "New ..." label. */
  label: string;
}

/**
 * The "+" in a filled circle, at desktop size: the mobile tab bar's add button
 * (`MobileTabBar`) as a desktop bar carries it. Blue is the theme accent
 * (`themes.css` re-skins the blue ramp), so it follows the colour scheme.
 */
export const RoundAddButton = forwardRef<HTMLButtonElement, RoundAddButtonProps>(
  function RoundAddButton({ label, className, type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-md transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 motion-reduce:transition-none dark:focus-visible:ring-offset-gray-900 ${className ?? ''}`}
        {...rest}
      >
        <PlusIcon aria-hidden="true" className="h-5 w-5" />
      </button>
    );
  },
);
