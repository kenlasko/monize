import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_MAX_PAGE_LIMIT } from '@/lib/api-page-limits';

/**
 * No call site may ask a paged endpoint for more rows than it accepts.
 *
 * The server does not clamp an over-cap `limit`, it rejects the request, and
 * every one of these calls sits behind a `.catch()` that degrades to an empty
 * list. So the 400 never surfaces as an error -- it surfaces as a number that
 * is quietly, permanently zero. That is issue #1229 (the recurring-charges
 * panel found no subscriptions at all) and it is the same defect that made the
 * investment detail page report every year's dividends and interest as 0.00.
 * Both were one literal, in one file, and neither failed a test.
 *
 * Lowering the literal to the cap is not the fix either: that turns a visible
 * zero into a plausible undercount, which is worse. Walk the pages
 * (`transactionsApi.getAllPages`, `investmentsApi.getAllTransactionPages`) or
 * narrow the query until one page is enough.
 *
 * Modelled on `src/test/ui-conventions.test.ts` -- a scan of the whole tree,
 * because a test around the one component that was fixed cannot catch the next
 * instance, and there was always a next instance.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

const REPO_ROOT = join(__dirname, '..', '..', '..');

/**
 * The client methods that reach a capped endpoint, and the parameter that
 * becomes the server's `limit`. A page-walk helper is listed too: its
 * `pageSize` is passed straight through as `limit`, so an over-cap page size
 * fails on the first request exactly as a raw one does.
 */
const CAPPED_CALLS = [
  { object: 'transactionsApi', method: 'getAll', key: 'limit' },
  { object: 'transactionsApi', method: 'getAllPages', key: 'pageSize' },
  { object: 'investmentsApi', method: 'getTransactions', key: 'limit' },
  { object: 'investmentsApi', method: 'getAllTransactionPages', key: 'pageSize' },
] as const;

/**
 * Call sites that are still over the cap, with the change that fixes each one.
 * An entry here is a live defect, not an exemption -- the test below fails once
 * the violation is gone, so a stale entry cannot outlive the fix it names.
 *
 * Empty, and worth keeping empty: the register's one entry (the recurring
 * charges panel, issue #1229) was removed when PR #1230 landed, and the test
 * below is what reported that it had become stale.
 */
const KNOWN_VIOLATIONS: {
  path: string;
  object: string;
  method: string;
  key: string;
  fix: string;
}[] = [];

/** Source files only: a test legitimately contains the call it asserts on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

/**
 * The argument text of each `object.method(...)` call in `source`, found by
 * balancing parentheses from the opening one. Whitespace between the object and
 * the method is tolerated because that is how the formatter writes these:
 * `transactionsApi\n  .getAll({ ... })`.
 */
function callArguments(source: string, object: string, method: string): string[] {
  const opener = new RegExp(`\\b${object}\\s*\\.\\s*${method}\\s*\\(`, 'g');
  const found: string[] = [];
  let match = opener.exec(source);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    found.push(source.slice(open + 1, end));
    opener.lastIndex = end;
    match = opener.exec(source);
  }
  return found;
}

/** Numeric literals given to `key` inside one call's arguments. */
function literalsFor(args: string, key: string): number[] {
  return [...args.matchAll(new RegExp(`\\b${key}\\s*:\\s*(\\d+)`, 'g'))].map((m) => Number(m[1]));
}

interface Offence {
  path: string;
  object: string;
  method: string;
  key: string;
  value: number;
}

/** Every over-cap call site in the tree, whether or not it is a known one. */
function overCapCallSites(): Offence[] {
  return productionSources().flatMap(([path, content]) =>
    CAPPED_CALLS.flatMap(({ object, method, key }) =>
      callArguments(content, object, method)
        .flatMap((args) => literalsFor(args, key))
        .filter((value) => value > API_MAX_PAGE_LIMIT)
        .map((value) => ({ path, object, method, key, value })),
    ),
  );
}

function isKnown(offence: Offence): boolean {
  return KNOWN_VIOLATIONS.some(
    (known) =>
      known.path === offence.path &&
      known.object === offence.object &&
      known.method === offence.method &&
      known.key === offence.key,
  );
}

describe('paged endpoints are never asked for more than they accept', () => {
  it('has no new over-cap call site', () => {
    const offenders = overCapCallSites()
      .filter((offence) => !isKnown(offence))
      .map((o) => `${o.path}: ${o.object}.${o.method}({ ${o.key}: ${o.value} })`);

    // The server answers 400, the call site's .catch() turns that into an empty
    // list, and the user reads a zero. Walk the pages or narrow the query.
    expect(offenders).toEqual([]);
  });

  it('lists no known violation that has already been fixed', () => {
    const live = overCapCallSites();
    const stale = KNOWN_VIOLATIONS.filter(
      (known) =>
        !live.some(
          (offence) =>
            offence.path === known.path &&
            offence.object === known.object &&
            offence.method === known.method &&
            offence.key === known.key,
        ),
    ).map((known) => `${known.path}: ${known.object}.${known.method} -- fixed by ${known.fix}`);

    // A known violation is a defect being tracked, not a permitted one. Once
    // its fix lands the entry is wrong, and leaving it behind would quietly
    // re-permit the literal it names.
    expect(stale).toEqual([]);
  });

  it('still finds the calls it polices, so the scan cannot pass by accident', () => {
    // Were a client method renamed, both checks above would sweep an empty set
    // and report success. This fails first and says what to update.
    const missing = CAPPED_CALLS.filter(
      ({ object, method }) =>
        !productionSources().some(([, content]) => callArguments(content, object, method).length),
    ).map(({ object, method }) => `${object}.${method}`);

    expect(missing).toEqual([]);
  });
});

describe('the client cap matches the caps the server enforces', () => {
  /**
   * The server states this ceiling twice, in two unrelated shapes, and neither
   * knows about the other: a shared DTO constant, and a hand-written check in
   * the investment register's controller whose 400 message spells the number
   * out in prose. Both are read here so a change to either fails against the
   * client rather than reaching a user as a swallowed 400.
   */
  function backendSource(relativePath: string): string {
    return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
  }

  it('matches PAGINATION_MAX_LIMIT on GET /transactions', () => {
    const dto = backendSource('backend/src/common/dto/pagination-query.dto.ts');
    const declared = /export const PAGINATION_MAX_LIMIT\s*=\s*(\d+)/.exec(dto);

    expect(declared, 'PAGINATION_MAX_LIMIT not found -- update this test').toBeTruthy();
    expect(Number(declared![1])).toBe(API_MAX_PAGE_LIMIT);
  });

  it('matches the hand-written cap on GET /investment-transactions', () => {
    const controller = backendSource(
      'backend/src/securities/investment-transactions.controller.ts',
    );
    const declared = /limitNum\s*>\s*(\d+)/.exec(controller);

    expect(declared, 'the limit check was rewritten -- update this test').toBeTruthy();
    expect(Number(declared![1])).toBe(API_MAX_PAGE_LIMIT);
  });
});
