'use client';

import { useCallback, useState } from 'react';
import {
  checkState,
  pruneChoices,
  selectionFor,
  withChoice,
  withKeysChecked,
  withRowChecked,
  type CheckState,
  type ImportPreviewSelection,
  type RowChoices,
  type UncheckedChoice,
} from '@/lib/import-preview';

export interface ImportPreviewSelectionApi {
  choices: RowChoices;
  /** Whether the row will be imported: every row is, until it is unchecked. */
  isChecked: (key: string) => boolean;
  /** What an unchecked row does; `skip` for a row that has no choice yet. */
  choiceOf: (key: string) => UncheckedChoice;
  setChecked: (key: string, checked: boolean) => void;
  setChoice: (key: string, choice: UncheckedChoice) => void;
  /** The header checkbox: check or uncheck every one of `keys`. */
  setAllChecked: (keys: readonly string[], checked: boolean) => void;
  /** None, some or all of `keys` checked. */
  stateOf: (keys: readonly string[]) => CheckState;
  /** Forget the choices about keys a fresh preview no longer offers. */
  prune: (keys: readonly string[]) => void;
  /** What an import of `keys` would do. */
  selectionFor: (keys: readonly string[]) => ImportPreviewSelection;
}

/**
 * The person's choices about the rows of an import preview: which are checked,
 * and what each unchecked one does (skipped for now, or added to the
 * exceptions). Every row starts checked. The preview of any source composes it
 * with its own rows; it knows keys and nothing else.
 */
export function useImportPreviewSelection(): ImportPreviewSelectionApi {
  const [choices, setChoices] = useState<RowChoices>(new Map());

  const isChecked = useCallback((key: string) => !choices.has(key), [choices]);
  const choiceOf = useCallback((key: string) => choices.get(key) ?? 'skip', [choices]);
  const setChecked = useCallback(
    (key: string, checked: boolean) => setChoices((current) => withRowChecked(current, key, checked)),
    [],
  );
  const setChoice = useCallback(
    (key: string, choice: UncheckedChoice) => setChoices((current) => withChoice(current, key, choice)),
    [],
  );
  const setAllChecked = useCallback(
    (keys: readonly string[], checked: boolean) =>
      setChoices((current) => withKeysChecked(current, keys, checked)),
    [],
  );
  const stateOf = useCallback((keys: readonly string[]) => checkState(keys, isChecked), [isChecked]);
  const prune = useCallback(
    (keys: readonly string[]) => setChoices((current) => pruneChoices(current, keys)),
    [],
  );
  const select = useCallback((keys: readonly string[]) => selectionFor(keys, choices), [choices]);

  return {
    choices,
    isChecked,
    choiceOf,
    setChecked,
    setChoice,
    setAllChecked,
    stateOf,
    prune,
    selectionFor: select,
  };
}
