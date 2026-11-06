'use client';

import dynamic from 'next/dynamic';
import { useHelpStore } from '@/store/helpStore';

// The panel and its Markdown renderer are fetched only when someone asks for
// help, and never on the server, so none of it ships with the pages that
// merely carry a `?` icon.
const HelpPanel = dynamic(() => import('./HelpPanel').then((m) => m.HelpPanel), {
  ssr: false,
});

/**
 * Mounted once in the authenticated shell beside the assistant. Renders
 * nothing, and loads nothing, until the help store says the panel is open.
 */
export function HelpPanelLoader() {
  const open = useHelpStore((s) => s.open);
  return open ? <HelpPanel /> : null;
}
