'use client';

import { useEffect, useState } from 'react';
import { helpApi, type HelpManifest } from '@/lib/help';

/**
 * The bundled guide's manifest (`GET /help`): its version and whether a guide
 * is bundled at all. `null` while unread or on failure -- a consumer that
 * needs the version (the panel's footer) simply shows nothing until it
 * arrives, same as a failed read. `helpApi.getManifest` dedupes and caches, so
 * mounting this alongside `useHelpPrefetch` costs nothing extra.
 */
export function useHelpManifest(): HelpManifest | null {
  const [manifest, setManifest] = useState<HelpManifest | null>(null);

  useEffect(() => {
    let cancelled = false;
    helpApi.getManifest().then(
      (result) => {
        if (!cancelled) setManifest(result);
      },
      () => {
        // Unknown stays unknown; the footer just omits the version.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return manifest;
}
