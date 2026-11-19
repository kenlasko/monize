'use client';

import { useEffect, useState } from 'react';
import { institutionsApi } from '@/lib/institutions';
import type { InstitutionLogoData } from '@/components/institutions/InstitutionLogo';

const EMPTY: ReadonlyMap<string, InstitutionLogoData> = new Map();

/**
 * The user's institutions by id, for drawing an account's institution logo in
 * a picker that is handed only the accounts. `institutionsApi.getAll` is
 * deduplicated and cached, so every picker on a page shares one request. A
 * failed read leaves the map empty: the pickers then draw each account's type
 * icon, which is decoration lost, not a figure withheld.
 */
export function useInstitutionLogos(): ReadonlyMap<string, InstitutionLogoData> {
  const [logos, setLogos] = useState(EMPTY);

  useEffect(() => {
    let cancelled = false;
    institutionsApi
      .getAll()
      .then((institutions) => {
        // No institutions leaves the empty map in place rather than a new one,
        // so the pickers built from it are not rebuilt for nothing.
        if (cancelled || institutions.length === 0) return;
        setLogos(
          new Map(
            institutions.map((institution) => [
              institution.id,
              { id: institution.id, name: institution.name, hasLogo: institution.hasLogo },
            ]),
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return logos;
}
