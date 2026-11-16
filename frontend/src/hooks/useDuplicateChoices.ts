'use client';

import { useCallback, useState } from 'react';
import {
  pruneDuplicateChoices,
  withDuplicateChoice,
  type DuplicateChoice,
  type DuplicateChoices,
} from '@/lib/import-duplicates';

export interface DuplicateChoicesApi {
  choices: DuplicateChoices;
  setChoice: (key: string, choice: DuplicateChoice) => void;
  /** Forget the decisions about keys a fresh answer no longer offers. */
  prune: (keys: readonly string[]) => void;
}

/**
 * The person's decisions about the possible duplicates of an import
 * (docs/specs/import-duplicate-review.md section 3). It knows keys and nothing
 * else; each source composes it with its own rows and default.
 */
export function useDuplicateChoices(): DuplicateChoicesApi {
  const [choices, setChoices] = useState<DuplicateChoices>(new Map());
  const setChoice = useCallback(
    (key: string, choice: DuplicateChoice) =>
      setChoices((current) => withDuplicateChoice(current, key, choice)),
    [],
  );
  const prune = useCallback(
    (keys: readonly string[]) => setChoices((current) => pruneDuplicateChoices(current, keys)),
    [],
  );
  return { choices, setChoice, prune };
}
