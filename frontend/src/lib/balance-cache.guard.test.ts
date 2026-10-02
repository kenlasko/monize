import { describe, it, expect } from 'vitest';

/**
 * Guard test for the balance-cache rule in `docs/frontend/api-and-cache.md`.
 *
 * `accountsApi.getAll` caches for two minutes, so any write that moves money
 * has to call `invalidateBalanceCaches()` (or `clearAllCache()`) before it
 * returns. A write that skips it leaves the Accounts page showing the
 * pre-write balance until the entry ages out or the browser reloads -- and
 * navigating back to the page does not fix it, because the page's refetch on
 * mount is served from that same cache.
 *
 * This was originally missed on `scheduledTransactionsApi.post`, which
 * invalidated only `scheduled:`. A test around that one method would not have
 * caught the identical omission sitting in `updateSplits`, `addSplit`,
 * `deleteSplit` and the import endpoints, so this scans the source instead --
 * the pattern used by `src/test/ui-conventions.test.ts`.
 *
 * Modelled on that file: add an endpoint here when a new route starts writing
 * transaction rows.
 */
const sources = import.meta.glob('/src/lib/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Routes whose writes change a balance the Accounts page reads. */
const BALANCE_WRITING_ROUTES = [
  /['`]\/transactions/,
  /['`]\/scheduled-transactions\/\$\{[^}]+\}\/post['`]/,
  /['`]\/investment-transactions/,
  /['`]\/import\/(qif|ofx|csv)['`]/,
  // Bank sync: the two sync routes create transaction rows from the bank's
  // booked entries. The credential, connection and link writes move none.
  /['`]\/bank-sync\/(accounts|connections)\/\$\{[^}]+\}\/sync['`]/,
];

/**
 * Sub-routes that hang off a balance-affecting path but write no money. A
 * receipt attached to a transaction changes nothing any balance sums.
 */
const NO_MONEY_ROUTES = [/\/attachments/];

/**
 * Writes on a balance-affecting route that move no money, so they are allowed
 * to leave the cache in place. `AccountsService.getProjectedBalance` -- and its
 * `onlyBalanceAffecting` helper on the backend -- is the definition being
 * tracked: a balance sums every non-VOID, non-child transaction. Clearing and
 * reconciling touch neither the amount nor the VOID flag. (Voiding goes through
 * `updateStatus`, which is *not* on this list and does invalidate.)
 */
const NO_MONEY_MOVED = ['markCleared', 'reconcile', 'unreconcile'];

const INVALIDATES = /invalidateBalanceCaches\(\)|clearAllCache\(\)/;
const MUTATION = /apiClient\.(post|put|patch|delete)/;

/**
 * Split a feature API module into its `name: async (...) => { ... },` methods.
 * They are all one indent level inside the exported object literal, so the
 * two-space `},` that closes one is an unambiguous terminator.
 */
function methodsOf(source: string): { name: string; body: string }[] {
  const lines = source.split('\n');
  const methods: { name: string; body: string }[] = [];
  let current: { name: string; body: string[] } | null = null;

  for (const line of lines) {
    const start = /^ {2}([a-zA-Z][a-zA-Z0-9_]*): async /.exec(line);
    if (start) {
      if (current) methods.push({ name: current.name, body: current.body.join('\n') });
      current = { name: start[1], body: [line] };
      continue;
    }
    if (!current) continue;
    current.body.push(line);
    if (/^ {2}\},?$/.test(line)) {
      methods.push({ name: current.name, body: current.body.join('\n') });
      current = null;
    }
  }
  if (current) methods.push({ name: current.name, body: current.body.join('\n') });
  return methods;
}

describe('a write that moves money drops the cached balances', () => {
  it('has no balance-writing API method that skips invalidation', () => {
    const offenders: string[] = [];

    for (const [path, source] of Object.entries(sources)) {
      if (/\.test\.ts$/.test(path)) continue;
      for (const { name, body } of methodsOf(source)) {
        if (NO_MONEY_MOVED.includes(name)) continue;
        if (!MUTATION.test(body)) continue;
        if (NO_MONEY_ROUTES.some((route) => route.test(body))) continue;
        if (!BALANCE_WRITING_ROUTES.some((route) => route.test(body))) continue;
        if (INVALIDATES.test(body)) continue;
        offenders.push(`${path} -> ${name}`);
      }
    }

    // Each of these writes transaction rows. Add `invalidateBalanceCaches()`
    // after the await, before the return.
    expect(offenders).toEqual([]);
  });

  it('still matches the methods it is meant to police', () => {
    // Were a module renamed, or the object-literal style replaced, the check
    // above would pass trivially over an empty set. This fails first and says
    // what to update.
    const covered = Object.entries(sources)
      .filter(([path]) => !/\.test\.ts$/.test(path))
      .flatMap(([, source]) => methodsOf(source))
      .filter(({ body }) => BALANCE_WRITING_ROUTES.some((r) => r.test(body)))
      .filter(({ body }) => MUTATION.test(body))
      .map(({ name }) => name);

    expect(covered).toContain('post'); // scheduledTransactionsApi.post
    expect(covered).toContain('updateSplits');
    expect(covered).toContain('createTransfer');
    expect(covered).toContain('importCsv');
    expect(covered).toContain('createTransaction'); // investmentsApi
    expect(covered).toContain('syncAccount'); // bankSyncApi
    expect(covered).toContain('syncConnection'); // bankSyncApi
  });
});
