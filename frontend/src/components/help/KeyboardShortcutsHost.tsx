'use client';

import dynamic from 'next/dynamic';
import { useHelpShortcutsStore } from '@/store/helpShortcutsStore';

// Dynamic like the search dialog and the help panel, so nothing about it ships
// with a page that never opens it.
const KeyboardShortcutsDialog = dynamic(
  () => import('./KeyboardShortcutsDialog').then((m) => m.KeyboardShortcutsDialog),
  { ssr: false },
);

/** Mounted once in the authenticated shell, beside `HelpSearchShortcut`. */
export function KeyboardShortcutsHost() {
  const open = useHelpShortcutsStore((s) => s.open);
  return open ? <KeyboardShortcutsDialog /> : null;
}
