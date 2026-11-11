'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowTopRightOnSquareIcon, QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
import { HOVER_ROW_ON_CARD, HOVER_TOOLBAR_BUTTON } from '@/components/ui/Card';
import { MENU_ENTER_CLASS, MENU_ORIGIN_RIGHT } from '@/components/ui/menu-motion';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { HelpMenuEntries } from '@/hooks/useHelpMenuEntries';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

const ITEM_CLASS = `flex w-full items-center gap-1.5 text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 ${HOVER_ROW_ON_CARD}`;

interface HelpMenuProps {
  /**
   * Built once by the caller (`AppHeader`, via `useHelpMenuEntries`) and
   * shared with `MobileNavDrawer`'s Help section, so the two never disagree
   * -- and a gated tour's data lookup (`useTourRequirements`) never fires
   * twice for the one menu on screen.
   */
  entries: HelpMenuEntries;
}

/**
 * Header `?` menu: help for the current page, search, keyboard shortcuts, the
 * tour, What's new, and the GitHub links `HelpSection` already offers in
 * Settings. Hidden below `sm` -- a phone reaches the same entries through
 * `MobileNavDrawer` instead.
 */
export function HelpMenu({ entries }: HelpMenuProps) {
  const t = useTranslations('navigation');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));
  const { helpForPage, actions, links } = entries;

  return (
    <div className="relative hidden sm:block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        {...tourAnchor(TOUR_ANCHORS.helpMenuButton)}
        aria-label={t('help')}
        title={t('help')}
        className={`p-2 rounded-md text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 ${HOVER_TOOLBAR_BUTTON}`}
      >
        <QuestionMarkCircleIcon className="h-5 w-5" aria-hidden="true" />
      </button>

      {open && (
        <div
          className={`absolute right-0 mt-1 w-56 bg-white dark:bg-gray-800 rounded-md shadow-lg dark:shadow-gray-700/50 border border-gray-200 dark:border-gray-700 z-50 ${MENU_ENTER_CLASS} ${MENU_ORIGIN_RIGHT}`}
        >
          <div className="py-1">
            {helpForPage && (
              <button
                type="button"
                onClick={() => {
                  helpForPage.onClick();
                  setOpen(false);
                }}
                className={ITEM_CLASS}
              >
                <helpForPage.Icon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true" />
                {helpForPage.label}
              </button>
            )}
            {actions.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => {
                  entry.onClick();
                  setOpen(false);
                }}
                className={ITEM_CLASS}
              >
                <entry.Icon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true" />
                {entry.label}
              </button>
            ))}
            <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
            {links.map((link) => (
              <a
                key={link.key}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className={ITEM_CLASS}
              >
                <link.Icon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true" />
                <span className="flex-1">{link.label}</span>
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
