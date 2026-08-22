import type { Page, Route, Request } from '@playwright/test';

// Machine-checked read-only guarantee.
//
// The browser talks to the backend same-origin under `/api/v1/` with
// credentials (frontend/src/lib/api.ts: baseURL '/api/v1', withCredentials).
// Every user-data mutation is therefore a POST/PUT/PATCH/DELETE to that path.
// This guard intercepts exactly those requests and BLOCKS every mutating verb
// except the tiny allowlist required to authenticate and keep the session
// alive. A blocked request is recorded so the capture can fail loudly: if a
// "read-only" navigation ever tries to write, that is a finding, not noise.

export interface Violation {
  method: string;
  url: string;
  when: string;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The ONLY writes allowed: logging in, satisfying CSRF, refreshing the token,
// verifying 2FA, and logging out. Matched against the URL path. Anything else
// that mutates is a violation. Keep this list minimal and explicit -- widening
// it is a reviewed decision, mirroring the codebase's allowlist convention.
const AUTH_WRITE_ALLOWLIST: RegExp[] = [
  /\/api\/v1\/auth\/login$/,
  /\/api\/v1\/auth\/2fa\/verify$/,
  /\/api\/v1\/auth\/refresh$/,
  /\/api\/v1\/auth\/csrf-refresh$/,
  /\/api\/v1\/auth\/logout$/,
];

// Read-style POSTs: endpoints that use POST only to carry a request body (e.g.
// a list of ids) and return data WITHOUT mutating anything. Verified read-only
// against the backend controllers. Let them through so the screen's figures
// render -- blocking them would corrupt the capture with false "unknown"s.
const READ_POST_ALLOWLIST: RegExp[] = [
  // budgets.controller.ts getCategoryBudgetStatus: returns a status map, no writes.
  /\/api\/v1\/budgets\/category-budget-status$/,
];

// App-initiated navigation side-effects we intentionally SUPPRESS during a
// read-only capture. The app auto-fires these when a screen mounts; the harness
// never asked for them. We block the request (so nothing is written and stored
// values stay frozen -- exactly the read-only behaviour we want) but do NOT
// record it as a violation, because suppressing it is correct, not a finding.
const SUPPRESS_WRITE_ALLOWLIST: RegExp[] = [
  // securities.controller.ts refreshSelectedPrices: fetches Yahoo prices, writes
  // price snapshots and recalculates net worth. Freezing prices is what we want.
  /\/api\/v1\/securities\/prices\/refresh\/selected$/,
];

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function matchesAny(url: string, list: RegExp[]): boolean {
  const path = pathOf(url);
  return list.some((re) => re.test(path));
}

function isAllowedAuthWrite(url: string): boolean {
  return matchesAny(url, AUTH_WRITE_ALLOWLIST);
}

/**
 * Install the guard on a page. Returns a live array of violations; assert it
 * is empty after each capture. `label` is recorded on each violation so a
 * failure names which screen tried to write.
 */
export function installReadonlyGuard(
  page: Page,
  getLabel: () => string = () => 'capture',
): Violation[] {
  const violations: Violation[] = [];

  const handler = async (route: Route, request: Request): Promise<void> => {
    const method = request.method().toUpperCase();
    const url = request.url();

    if (
      !MUTATING_METHODS.has(method) ||
      isAllowedAuthWrite(url) ||
      matchesAny(url, READ_POST_ALLOWLIST)
    ) {
      await route.continue();
      return;
    }

    // An app-initiated navigation side-effect we suppress on purpose: block it
    // (freeze data) but do not treat it as a violation.
    if (matchesAny(url, SUPPRESS_WRITE_ALLOWLIST)) {
      await route.abort('failed');
      return;
    }

    // A mutating request that is not allowed and not suppressed. Record and block.
    violations.push({ method, url, when: getLabel() });
    await route.abort('failed');
  };

  // Intercept only the API surface; navigations and assets are untouched.
  void page.route('**/api/v1/**', handler);

  return violations;
}

/** Throw a loud, specific error if any write was attempted. */
export function assertNoWrites(violations: Violation[]): void {
  if (violations.length === 0) return;
  const lines = violations
    .map((v) => `  - [${v.when}] ${v.method} ${v.url}`)
    .join('\n');
  throw new Error(
    `Read-only guarantee VIOLATED: the app attempted ${violations.length} ` +
      `data-mutating request(s) during a read-only capture:\n${lines}\n` +
      `This harness must never write user data. If one of these is genuinely ` +
      `safe, add it to AUTH_WRITE_ALLOWLIST in src/readonly-guard.ts as a ` +
      `reviewed decision -- do not loosen the guard blindly.`,
  );
}
