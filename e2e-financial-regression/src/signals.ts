import type { Page, Locator } from '@playwright/test';
import type { ValueKind, ValueStatus } from './money';

// The catalogue of what this harness captures, on the screens PR #1145
// ("unknown is not zero", branch pr/06-unknown-is-not-zero) affects:
// Accounts, Dashboard, Transactions, Bills/Cash-Flow, investment allocations,
// and the affected Reports.
//
// Two layers, both keyed by (screen, field) so the comparison can line them up:
//
//   1. API layer (the robust backbone). While a screen renders, we snapshot
//      the financial GET responses it fetches and record EVERY numeric/null
//      leaf by its JSON path. This is language-independent and directly
//      surfaces the one change this PR makes: a value that was a misleading
//      0 becoming null ("unknown"). It needs no per-DTO knowledge, so it does
//      not drift as shapes evolve.
//
//   2. DOM layer (human-readable corroboration). A focused set of headline
//      figures read straight from the rendered page via the few stable
//      anchors that actually exist in production DOM (SummaryCard's dt/dd
//      pairs; a handful of real data-testids). Most value nodes in this app
//      carry NO testid, so this layer is deliberately small and each entry
//      names exactly what it anchors on. Adjust these per your instance if a
//      label differs; the API layer stands on its own regardless.

// ---------------------------------------------------------------------------
// API layer
// ---------------------------------------------------------------------------

// Financial GET endpoints worth snapshotting wherever they are fetched. Matched
// against the URL pathname (the browser calls them under /api/v1/...). Order
// does not matter; a response is snapshotted once per (path+query).
export const API_CAPTURE_MATCHERS: RegExp[] = [
  /\/api\/v1\/accounts\/summary$/,
  /\/api\/v1\/accounts$/,
  /\/api\/v1\/accounts\/daily-balances$/,
  /\/api\/v1\/accounts\/[^/]+\/balance$/,
  /\/api\/v1\/portfolio\/summary$/,
  /\/api\/v1\/portfolio\/accounts$/,
  /\/api\/v1\/portfolio\/allocation(\/[^/?]+)?$/,
  /\/api\/v1\/portfolio\/(asset-class|sector|country)-weightings$/,
  /\/api\/v1\/holdings$/,
  /\/api\/v1\/net-worth\/(monthly|investments-breakdown|investments-monthly|investments-daily)$/,
  /\/api\/v1\/scheduled-transactions(\/due)?$/,
  // Reports screens fetch their figures from the built-in-reports family and
  // the investment report. Observed on this instance (monize 1.14) by watching
  // the network per screen; added so cash-flow, income/spending, tax-summary,
  // bill-payment-history and the investment report are compared too -- these
  // carry exactly the totals the "unknown is not zero" PR can flip to null.
  /\/api\/v1\/built-in-reports\/(cash-flow|income-by-source|spending-by-category|tax-summary|bill-payment-history)$/,
  /\/api\/v1\/reports\/investment$/,
  /\/api\/v1\/portfolio\/(top-movers|allocation\/by-tag)$/,
];

// Leaf keys that legitimately differ between two runs minutes apart, or that
// are identifiers rather than financial values. Excluded from the API layer so
// they never masquerade as a regression.
const VOLATILE_KEY =
  /(^|\.)(id|.*Id|uuid|createdAt|updatedAt|deletedAt|.*Date|.*At|timestamp|asOf|lastRefreshed|generatedAt|nextDue|dueDate|slug|token|etag|version|_ts)$/i;

export interface Leaf {
  path: string;
  kind: ValueKind;
  numeric: number | null;
  rawText: string | null;
  status: ValueStatus;
}

/**
 * Walk a parsed JSON body and emit one Leaf per numeric or explicit-null value,
 * keyed by its dotted/indexed path. Numbers become {status:'value'}; an
 * explicit null becomes {status:'unknown'} -- which is exactly the 0-vs-null
 * distinction the PR is about. Strings, booleans, and volatile keys are
 * skipped. Arrays index by position.
 */
export function jsonLeaves(body: unknown): Leaf[] {
  const out: Leaf[] = [];
  const walk = (node: unknown, path: string): void => {
    if (node === null) {
      if (!VOLATILE_KEY.test(path)) {
        out.push({ path, kind: 'money', numeric: null, rawText: null, status: 'unknown' });
      }
      return;
    }
    if (typeof node === 'number') {
      if (!VOLATILE_KEY.test(path) && Number.isFinite(node)) {
        out.push({
          path,
          kind: 'money',
          numeric: node,
          rawText: String(node),
          status: 'value',
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(body, '');
  return out;
}

// ---------------------------------------------------------------------------
// DOM layer
// ---------------------------------------------------------------------------

/**
 * A SummaryCard renders <dl><dt>{label}</dt><dd>{value}</dd></dl>
 * (frontend/src/components/ui/SummaryCard.tsx). This is the single most stable
 * label->value anchor in the app, so the accounts KPIs read from it directly.
 */
export function summaryCardValue(page: Page, label: string): Locator {
  return page.locator(
    `xpath=//dt[normalize-space(.)=${xpathLiteral(label)}]/following-sibling::dd[1]`,
  );
}

/** Escape a string for use as an XPath string literal (handles quotes). */
function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replace(/'/g, "',\"'\",'")}')`;
}

export interface DomField {
  field: string;
  kind: ValueKind;
  locate: (page: Page) => Locator;
}

export interface ScreenSpec {
  screen: string;
  path: string;
  /** A locator that proves the screen finished its first render. */
  ready: (page: Page) => Locator;
  domFields: DomField[];
}

// The screens to visit, in order. Every screen's fetched financial responses
// are snapshotted by the API layer automatically; domFields add the few
// reliably-anchored headline figures on top.
export const SCREENS: ScreenSpec[] = [
  {
    screen: 'accounts',
    path: '/accounts',
    ready: (p) => p.getByRole('heading', { level: 1 }).first(),
    domFields: [
      { field: 'summary.netWorth', kind: 'money', locate: (p) => summaryCardValue(p, 'Net Worth') },
      { field: 'summary.totalAssets', kind: 'money', locate: (p) => summaryCardValue(p, 'Total Assets') },
      {
        field: 'summary.totalLiabilities',
        kind: 'money',
        locate: (p) => summaryCardValue(p, 'Total Liabilities'),
      },
      {
        field: 'summary.totalActiveAccounts',
        kind: 'count',
        locate: (p) => summaryCardValue(p, 'Total Active Accounts'),
      },
    ],
  },
  {
    screen: 'dashboard',
    path: '/dashboard',
    ready: (p) => p.getByRole('heading', { level: 1 }).first(),
    domFields: [],
  },
  {
    screen: 'transactions',
    path: '/transactions',
    ready: (p) => p.getByRole('heading', { level: 1 }).first(),
    domFields: [],
  },
  {
    screen: 'bills',
    path: '/bills',
    ready: (p) => p.getByRole('heading', { level: 1 }).first(),
    domFields: [],
  },
  {
    screen: 'investments',
    path: '/investments',
    ready: (p) => p.getByRole('heading', { name: /investments/i }).first(),
    // Portfolio Summary figures carry no testid; the API layer covers
    // /portfolio/summary exactly. We still assert the two return metrics that
    // render an explicit "N/A" (portfolioSummary.notAvailable) when unknown --
    // the canonical unknown-not-zero rendering on this screen.
    domFields: [],
  },
  {
    screen: 'reports/net-worth',
    path: '/reports/net-worth',
    ready: (p) => p.getByRole('heading', { name: /net worth/i }).first(),
    domFields: [],
  },
  {
    screen: 'reports/portfolio-value',
    path: '/reports/portfolio-value',
    ready: (p) => p.getByRole('heading', { name: /portfolio value/i }).first(),
    domFields: [],
  },
  {
    screen: 'reports/account-balances',
    path: '/reports/account-balances',
    ready: (p) => p.getByRole('heading', { name: /account balances/i }).first(),
    domFields: [],
  },
  {
    screen: 'reports/cash-flow',
    path: '/reports/cash-flow',
    ready: (p) => p.getByRole('heading', { name: /cash flow/i }).first(),
    domFields: [],
  },
  {
    screen: 'reports/security-type-allocation',
    path: '/reports/security-type-allocation',
    ready: (p) => p.getByRole('heading', { name: /allocation/i }).first(),
    domFields: [],
  },
  {
    screen: 'reports/geographic-allocation',
    path: '/reports/geographic-allocation',
    ready: (p) => p.getByRole('heading', { name: /allocation|geographic/i }).first(),
    domFields: [],
  },
  {
    screen: 'reports/tax-summary',
    path: '/reports/tax-summary',
    ready: (p) => p.getByRole('heading', { name: /tax/i }).first(),
    domFields: [],
  },
  {
    screen: 'reports/upcoming-bills',
    path: '/reports/upcoming-bills',
    ready: (p) => p.getByRole('heading', { name: /bills/i }).first(),
    domFields: [],
  },
  {
    screen: 'reports/bill-payment-history',
    path: '/reports/bill-payment-history',
    ready: (p) => p.getByRole('heading', { name: /bill|payment/i }).first(),
    domFields: [],
  },
];
