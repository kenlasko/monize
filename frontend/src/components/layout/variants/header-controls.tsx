'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import type { StyleVariants } from '@/hooks/useUiStyle';

/**
 * The app header's search slot and user button, per UI style. Every style's
 * search is the "search or jump to" field, which opens the command palette
 * (the same Ctrl/Cmd+K box, whose results include a transaction search);
 * Folio draws a bordered box, Pebble a pill, and Standard a bare magnifying
 * glass that opens the same palette. The user
 * button differs: Standard keeps its settings gear, which `AppHeader` builds
 * and hands over unchanged, while Folio and Pebble show the reader's name or
 * initial.
 */

/** The search slot takes no props: every style opens the same palette. */
export type HeaderSearchSlotProps = Record<never, never>;

/**
 * Standard's search is the magnifying glass alone: its nav links run on a
 * full-width row, and a labelled field made "Bills & Deposits" wrap onto two
 * lines. The label stays for a screen reader, and the palette it opens shows
 * the Ctrl/Cmd+K hint.
 */
function SearchIconTrigger() {
  const t = useTranslations('navigation');
  return (
    <button
      type="button"
      onClick={() => useCommandPaletteStore.getState().openPalette()}
      aria-keyshortcuts="Control+K Meta+K"
      className={`ui-search-trigger rounded-md p-2 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 ${HOVER_ROW_ON_PAGE} focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
    >
      <MagnifyingGlassIcon aria-hidden="true" className="h-5 w-5" />
      <span className="sr-only">{t('commandPalette.trigger')}</span>
    </button>
  );
}

function PaletteTrigger({ variant }: { variant: 'folio' | 'pebble' }) {
  const t = useTranslations('navigation');
  const tHelp = useTranslations('help');
  const pebble = variant === 'pebble';
  return (
    <button
      type="button"
      onClick={() => useCommandPaletteStore.getState().openPalette()}
      aria-keyshortcuts="Control+K Meta+K"
      className={
        pebble
          ? 'ui-search-trigger flex h-11 items-center gap-6 rounded-full bg-white pr-1.5 pl-4 text-sm text-gray-500 transition-colors hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none max-2xl:pr-4 dark:bg-gray-800 dark:text-gray-400 dark:hover:text-gray-100'
          : 'ui-search-trigger flex h-10 items-center gap-6 rounded-(--ui-radius-control) border border-gray-200 bg-white px-3 text-sm text-gray-500 transition-colors hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-gray-500'
      }
    >
      <span className="flex items-center gap-2">
        <MagnifyingGlassIcon aria-hidden="true" className="h-4 w-4 flex-shrink-0" />
        <span className="max-sm:sr-only">{t('commandPalette.trigger')}</span>
      </span>
      <kbd
        aria-hidden="true"
        className={
          pebble
            ? 'hidden rounded-full bg-gray-50 px-2.5 py-1.5 text-xs font-semibold text-gray-900 2xl:inline dark:bg-gray-900 dark:text-gray-100'
            : 'hidden rounded-[3px] border border-gray-300 px-1.5 font-mono text-xs 2xl:inline dark:border-gray-600'
        }
      >
        {tHelp('shortcuts.paletteKeys')}
      </kbd>
    </button>
  );
}

export const HEADER_SEARCH_VARIANTS: StyleVariants<HeaderSearchSlotProps> = {
  standard: SearchIconTrigger,
  folio: () => <PaletteTrigger variant="folio" />,
  pebble: () => <PaletteTrigger variant="pebble" />,
};

export interface HeaderUserSlotProps {
  /** The Standard header's settings button. */
  standard: ReactNode;
  /** The reader's first name, or their email. */
  name: string;
  /** On the settings page. */
  active: boolean;
  onOpen: () => void;
  /** The guided tour's anchor for Settings. */
  anchor: Record<string, string>;
}

function NameButton({ name, active, onOpen, anchor }: HeaderUserSlotProps) {
  const t = useTranslations('navigation');
  return (
    <button
      type="button"
      {...anchor}
      onClick={onOpen}
      aria-current={active ? 'page' : undefined}
      aria-label={t('accountButton', { name })}
      title={t('settings')}
      className="ui-nav-link flex h-10 items-center px-2 text-sm text-gray-900 max-sm:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-100"
    >
      {name}
    </button>
  );
}

function AvatarButton({ name, active, onOpen, anchor }: HeaderUserSlotProps) {
  const t = useTranslations('navigation');
  return (
    <button
      type="button"
      {...anchor}
      onClick={onOpen}
      aria-current={active ? 'page' : undefined}
      aria-label={t('accountButton', { name })}
      title={t('settings')}
      className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-gray-900 font-bold text-gray-50 max-sm:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:bg-gray-100 dark:text-gray-900 dark:focus-visible:ring-offset-gray-900"
    >
      <span aria-hidden="true">{Array.from(name || '?')[0].toUpperCase()}</span>
    </button>
  );
}

export const HEADER_USER_VARIANTS: StyleVariants<HeaderUserSlotProps> = {
  standard: ({ standard }) => <>{standard}</>,
  folio: NameButton,
  pebble: AvatarButton,
};
