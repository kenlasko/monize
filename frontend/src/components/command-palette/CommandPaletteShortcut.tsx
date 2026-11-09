'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { isPublicPath } from '@/lib/public-paths';
import { useAuthStore } from '@/store/authStore';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import { useHelpSearchStore } from '@/store/helpSearchStore';

// Fetched only once the palette actually opens, like the help search dialog.
const CommandPalette = dynamic(
  () => import('./CommandPalette').then((m) => m.CommandPalette),
  { ssr: false },
);

/**
 * Mounted once in the authenticated shell. `Ctrl/Cmd+K` toggles the palette
 * from anywhere, including inside a field, because no input binds it.
 *
 * Over another dialog it opens help search instead: every palette result
 * navigates, and a form dialog's history entry undoes a navigation made while
 * it is open, whereas help search only hands off to the side panel. It does
 * the same on a signed-out page: the shell mounts on some public routes, and
 * the palette's reads would 401 and redirect the visitor to the login screen.
 */
export function CommandPaletteShortcut() {
  const open = useCommandPaletteStore((s) => s.open);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      // It toggles, so a held key must not flicker it.
      if (event.repeat) return;
      const palette = useCommandPaletteStore.getState();
      if (palette.open) {
        palette.closePalette();
      } else if (
        document.querySelector('[aria-modal="true"]') ||
        !useAuthStore.getState().isAuthenticated ||
        isPublicPath(window.location.pathname)
      ) {
        useHelpSearchStore.getState().openSearch();
      } else {
        palette.openPalette();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return open ? <CommandPalette /> : null;
}
