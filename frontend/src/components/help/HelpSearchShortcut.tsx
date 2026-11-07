'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { isEditableTarget } from '@/lib/helpers/is-editable-target';
import { useHelpSearchStore } from '@/store/helpSearchStore';

// Fetched only once the dialog actually opens, like the help panel itself
// (`HelpPanelLoader`) and the assistant.
const HelpSearchDialog = dynamic(
  () => import('./HelpSearchDialog').then((m) => m.HelpSearchDialog),
  { ssr: false },
);

/**
 * Mounted once in the authenticated shell. `Ctrl/Cmd+K` opens help search
 * from anywhere; `?` does too, but only outside a field that consumes
 * ordinary typing, so a payee named with a question mark still gets one.
 */
export function HelpSearchShortcut() {
  const open = useHelpSearchStore((s) => s.open);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        useHelpSearchStore.getState().openSearch();
        return;
      }
      if (
        event.key === '?' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        useHelpSearchStore.getState().openSearch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return open ? <HelpSearchDialog /> : null;
}
