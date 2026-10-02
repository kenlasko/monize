import { describe, it, expect } from 'vitest';

/**
 * Every cache family is classified as transaction-derived or not.
 *
 * `balance-cache.guard.test.ts` polices one half of the rule: a write that moves
 * money must call `invalidateBalanceCaches()`. This is the other half, and it is
 * the half that failed. `budgets:` was added to the cache without being added to
 * the invalidator, so every money-moving write correctly called a function that
 * did not drop the budget progress bar sitting next to it -- the number a user
 * makes the next spending decision from. Both guards were green.
 *
 * A prefix is transaction-derived when its cached value is computed from
 * transaction rows: an account balance, a portfolio valuation, a budget's
 * progress. It is reference data when a transaction write cannot change it: the
 * payee list, the category tree, a report *definition* (as opposed to a report
 * result), an institution, a tag.
 *
 * A new prefix in neither list fails this test, which is the point: the decision
 * is cheap to make while writing the cache call and invisible afterwards.
 */

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Dropped by `invalidateBalanceCaches()` -- derived from transaction rows. */
const TRANSACTION_DERIVED: ReadonlyArray<[string, string]> = [
  ['accounts:', 'balances are summed live from transactions'],
  [
    'investments:',
    'holdings and portfolio value follow investment transactions, and a trade moves the INVESTMENT_CASH balance',
  ],
  [
    'budgets:',
    'dashboard progress and per-category status are sums of categorised transactions',
  ],
];

/** Kept -- a transaction write cannot change these. */
const REFERENCE_DATA: ReadonlyArray<[string, string]> = [
  ['payees:', 'payee records; a transaction referencing one does not change it'],
  ['categories:', 'category tree'],
  ['institutions:', 'institution records'],
  ['tags:', 'tag records'],
  [
    'scheduled:',
    'schedule definitions plus their #1167 FX-derived forecast fields. A transaction write does not touch it, so it stays out of invalidateBalanceCaches; its own writers invalidate it, and an FX-input change (rate refresh, account/security currency edit) drops it via invalidateScheduledFxReadModel',
  ],
  [
    'reports:',
    'custom report DEFINITIONS, not their results -- the list of saved reports',
  ],
  [
    'investment-reports:',
    'investment report definitions, same as above',
  ],
  ['attachments:', 'attachment metadata; carries no amount'],
  [
    'exchange-rates:',
    'rate snapshots from the provider; a user transaction does not move a rate',
  ],
  [
    'ai:',
    "the AI provider status -- whether this user has a provider that can answer a lookup at all. It follows the provider rows in Settings, which drop it themselves; a transaction cannot change it",
  ],
  [
    'calendar:',
    "the reader's own notes on calendar dates. A note moves no money and nothing financial reads it, so a transaction write cannot change one; its own writes drop it",
  ],
  [
    'payee-lookup:',
    "whether a payee contact lookup can run and which source would answer it -- the Google Places configuration and cap, plus whether an AI provider exists. Its own settings writes drop it, and so does every AI provider mutation, because the answer depends on both; a transaction cannot change it",
  ],
  [
    'bank-sync:',
    "bank sync status, institutions and connections with their bank accounts: the bank's own balance and the sync outcome, none of it summed from Monize transactions. The sync routes drop it themselves and, when a row was written, the balance caches as well",
  ],
];

/** Prefix literals passed to any cache call, e.g. `'accounts:all'` -> `accounts:`. */
function prefixesIn(source: string): Set<string> {
  const found = new Set<string>();
  const call =
    /(?:dedupe|setCache|getCached|invalidateCache)\s*(?:<[^>]*>)?\s*\(\s*['"`]([a-zA-Z][a-zA-Z0-9_-]*):/g;
  for (const match of source.matchAll(call)) found.add(`${match[1]}:`);
  return found;
}

const allPrefixes = new Set<string>();
for (const [path, source] of Object.entries(sources)) {
  if (/\.test\.tsx?$/.test(path)) continue;
  if (path.endsWith('/src/lib/apiCache.ts')) continue;
  for (const prefix of prefixesIn(source)) allPrefixes.add(prefix);
}

const apiCacheSource = sources['/src/lib/apiCache.ts'];
// Bound the slice to `invalidateBalanceCaches`'s own body -- not to end of file.
// Other invalidators live below it now (e.g. invalidateScheduledFxReadModel,
// which drops the FX-derived `scheduled:` prefix by design); a slice running to
// EOF would read their bodies and wrongly report `scheduled:` as dropped by the
// balance helper.
const invalidatorStart = apiCacheSource.indexOf(
  'export function invalidateBalanceCaches',
);
const invalidatorEnd = apiCacheSource.indexOf('\n}', invalidatorStart);
const invalidatorBody = apiCacheSource.slice(invalidatorStart, invalidatorEnd);

describe('cache prefix classification', () => {
  it('finds the prefixes it is meant to police', () => {
    // A renamed helper or a changed call style would leave the checks below
    // passing over an empty set. This fails first and says so.
    expect(allPrefixes.size).toBeGreaterThanOrEqual(9);
    expect(allPrefixes).toContain('accounts:');
    expect(allPrefixes).toContain('budgets:');
  });

  it('classifies every cache prefix as transaction-derived or reference data', () => {
    const classified = new Set([
      ...TRANSACTION_DERIVED.map(([prefix]) => prefix),
      ...REFERENCE_DATA.map(([prefix]) => prefix),
    ]);
    const unclassified = [...allPrefixes].filter(
      (prefix) => !classified.has(prefix),
    );

    // Decide which it is and add it to the matching list above. If it is
    // transaction-derived, also add it to `invalidateBalanceCaches()`.
    expect(unclassified).toEqual([]);
  });

  it('drops every transaction-derived prefix in invalidateBalanceCaches', () => {
    const missing = TRANSACTION_DERIVED.filter(
      ([prefix]) => !invalidatorBody.includes(`invalidateCache('${prefix}')`),
    ).map(([prefix, why]) => `${prefix} (${why})`);

    expect(missing).toEqual([]);
  });

  it('leaves reference data alone in invalidateBalanceCaches', () => {
    const wronglyDropped = REFERENCE_DATA.filter(([prefix]) =>
      invalidatorBody.includes(`invalidateCache('${prefix}')`),
    ).map(([prefix]) => prefix);

    // Dropping reference data on every write is not a correctness bug, but it
    // refetches the payee and category lists on every save. If a prefix really
    // is transaction-derived, move it to the other list with a reason.
    expect(wronglyDropped).toEqual([]);
  });

  it('has no classification entry for a prefix nothing uses', () => {
    const stale = [...TRANSACTION_DERIVED, ...REFERENCE_DATA]
      .map(([prefix]) => prefix)
      .filter((prefix) => !allPrefixes.has(prefix));

    expect(stale).toEqual([]);
  });
});
