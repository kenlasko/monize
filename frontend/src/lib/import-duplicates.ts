import type { ImportDuplicateAction } from '@/types/import-preview';

/**
 * The decisions a person makes about the possible duplicates of an import
 * (docs/specs/import-duplicate-review.md section 3), whatever the source. Pure
 * and keyed by an opaque row key; which rows are possible duplicates, and what
 * the keys are, is the source's business.
 *
 * Beside the four actions the server knows, a bank sync offers `later` (leave
 * the row for the next preview; its default) and `except` (add it to the
 * exceptions). A file has neither: its default is `keep`.
 */
export type DuplicateChoice = ImportDuplicateAction | 'later' | 'except';

/** The person's decisions, by row key. A row that is not here has its source's default. */
export type DuplicateChoices = ReadonlyMap<string, DuplicateChoice>;

/** The order the choices are offered in, whatever subset a row allows. */
const CHOICE_ORDER: readonly DuplicateChoice[] = [
  'later',
  'keep',
  'merge',
  'replace',
  'import',
  'except',
];

/**
 * The choices a row offers: the actions the server allows for its pair, plus
 * the source's own (`later`, `except`), in one stable order.
 */
export function duplicateOptions(
  allowed: readonly ImportDuplicateAction[],
  extra: readonly ('later' | 'except')[] = [],
): DuplicateChoice[] {
  const offered = new Set<DuplicateChoice>([...allowed, ...extra]);
  return CHOICE_ORDER.filter((choice) => offered.has(choice));
}

/** What the person decided about `key`, or `fallback`; a choice the row no longer offers falls back too. */
export function duplicateChoiceOf(
  choices: DuplicateChoices,
  key: string,
  fallback: DuplicateChoice,
  options?: readonly DuplicateChoice[],
): DuplicateChoice {
  const choice = choices.get(key);
  if (choice === undefined) return fallback;
  return options === undefined || options.includes(choice) ? choice : fallback;
}

export function withDuplicateChoice(
  choices: DuplicateChoices,
  key: string,
  choice: DuplicateChoice,
): DuplicateChoices {
  return new Map(choices).set(key, choice);
}

/** Drops the decisions about keys a fresh answer no longer offers. */
export function pruneDuplicateChoices(
  choices: DuplicateChoices,
  keys: readonly string[],
): DuplicateChoices {
  const wanted = new Set(keys);
  return new Map([...choices].filter(([key]) => wanted.has(key)));
}

/** The keys of the possible duplicates sorted into the lists a bank sync sends, with how many are left for later. */
export interface BankDuplicateLists {
  importKeys: string[];
  excludeKeys: string[];
  mergeKeys: string[];
  keepKeys: string[];
  replaceKeys: string[];
  laterCount: number;
}

/** Sorts a bank preview's possible duplicates (`later` by default) into the sync's lists. */
export function bankDuplicateLists(
  rows: readonly { key: string; options: readonly DuplicateChoice[] }[],
  choices: DuplicateChoices,
): BankDuplicateLists {
  const lists: BankDuplicateLists = {
    importKeys: [],
    excludeKeys: [],
    mergeKeys: [],
    keepKeys: [],
    replaceKeys: [],
    laterCount: 0,
  };
  for (const { key, options } of rows) {
    switch (duplicateChoiceOf(choices, key, 'later', options)) {
      case 'import':
        lists.importKeys.push(key);
        break;
      case 'except':
        lists.excludeKeys.push(key);
        break;
      case 'merge':
        lists.mergeKeys.push(key);
        break;
      case 'keep':
        lists.keepKeys.push(key);
        break;
      case 'replace':
        lists.replaceKeys.push(key);
        break;
      case 'later':
        lists.laterCount += 1;
        break;
    }
  }
  return lists;
}
