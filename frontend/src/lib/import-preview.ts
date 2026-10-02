import type { ImportPreviewPayee } from '@/types/import-preview';

/**
 * The choices a person makes about the rows of an import preview, whatever the
 * source. Pure and keyed by an opaque row key; which rows can be chosen, and
 * what the keys are, is the source's business.
 */

/** What the person decided for a row they unchecked: leave it for next time, or except it for good. */
export type UncheckedChoice = 'skip' | 'except';

/**
 * The rows the person unchecked, by key. A row that is not here is checked and
 * will be imported: every row starts checked, so an untouched preview imports
 * what it always did.
 */
export type RowChoices = ReadonlyMap<string, UncheckedChoice>;

/** The keys to import, the keys to add to the exceptions, and how many unchecked rows are only skipped for now. */
export interface ImportPreviewSelection {
  importKeys: string[];
  excludeKeys: string[];
  skipCount: number;
}

/** Sorts `keys` (every row that can be chosen) by what the person decided. */
export function selectionFor(keys: readonly string[], choices: RowChoices): ImportPreviewSelection {
  const importKeys: string[] = [];
  const excludeKeys: string[] = [];
  let skipCount = 0;
  for (const key of keys) {
    const choice = choices.get(key);
    if (choice === undefined) importKeys.push(key);
    else if (choice === 'except') excludeKeys.push(key);
    else skipCount += 1;
  }
  return { importKeys, excludeKeys, skipCount };
}

/** Drops the choices about keys a fresh answer no longer offers. */
export function pruneChoices(choices: RowChoices, keys: readonly string[]): RowChoices {
  const wanted = new Set(keys);
  return new Map([...choices].filter(([key]) => wanted.has(key)));
}

/** One row checked or unchecked. An unchecked row is skipped for now unless it already had a choice. */
export function withRowChecked(choices: RowChoices, key: string, checked: boolean): RowChoices {
  const next = new Map(choices);
  if (checked) next.delete(key);
  else if (!next.has(key)) next.set(key, 'skip');
  return next;
}

/** All of `keys` checked or unchecked at once (the header checkbox). */
export function withKeysChecked(choices: RowChoices, keys: readonly string[], checked: boolean): RowChoices {
  return keys.reduce((acc, key) => withRowChecked(acc, key, checked), choices);
}

/** What an unchecked row does now: skipped for now, or added to the exceptions. */
export function withChoice(choices: RowChoices, key: string, choice: UncheckedChoice): RowChoices {
  return new Map(choices).set(key, choice);
}

/** How many of a set of keys are checked, as the state of a header checkbox. */
export type CheckState = 'none' | 'some' | 'all';

export function checkState(keys: readonly string[], isChecked: (key: string) => boolean): CheckState {
  const checked = keys.filter(isChecked).length;
  if (checked === 0) return 'none';
  return checked === keys.length ? 'all' : 'some';
}

/**
 * The text of the tooltip beside a payee, as a catalog key and its arguments,
 * or null when the payee needs no explanation (the source's text is the payee).
 */
export type PayeeTip =
  | {
      kind: 'name' | 'alias' | 'aliasNoPattern' | 'new' | 'rule' | 'ruleNone';
      original: string;
      name: string;
      pattern: string;
    }
  | null;

export function payeeTip(payee: ImportPreviewPayee | null): PayeeTip {
  // An answer from a server that sent no payee detail has nothing to explain.
  if (!payee || payee.original === null) return null;
  const name = payee.name ?? '';
  const base = { original: payee.original, name, pattern: payee.aliasPattern ?? '' };
  switch (payee.via) {
    case 'alias':
      return { kind: payee.aliasPattern === null ? 'aliasNoPattern' : 'alias', ...base };
    case 'new':
      return { kind: 'new', ...base };
    case 'rule':
      return { kind: payee.name === null ? 'ruleNone' : 'rule', ...base };
    case 'name':
      return payee.name !== null && payee.name !== payee.original ? { kind: 'name', ...base } : null;
    default:
      return null;
  }
}
