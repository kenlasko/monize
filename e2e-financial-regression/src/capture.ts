import type { Page } from '@playwright/test';
import { installReadonlyGuard, assertNoWrites } from './readonly-guard';
import { loginExistingUser, userFromEnv } from './auth';
import { normalize, type ValueKind, type ValueStatus } from './money';
import { API_CAPTURE_MATCHERS, SCREENS, jsonLeaves } from './signals';

// Passive settling knobs. See the screen loop for why active waits are avoided.
const SCREEN_SETTLE_MS = 5000; // let each screen hydrate + fetch + paint
const DOM_POLL_INTERVAL_MS = 500;
const DOM_POLL_TRIES = 24; // up to ~12s waiting for a DOM value to appear/settle

export interface CapturedSignal {
  screen: string;
  field: string;
  layer: 'api' | 'dom';
  kind: ValueKind;
  rawText: string | null;
  numeric: number | null;
  status: ValueStatus;
}

export interface CaptureResult {
  phase: string;
  revisionRef: string | null;
  baseURL: string;
  capturedAt: string;
  signals: CapturedSignal[];
}

function pathKey(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function pathOnly(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Log in as the configured existing user and capture every targeted financial
 * value on the affected screens, strictly read-only. Returns a flat list of
 * signals keyed by (screen, field) for the comparison step.
 *
 * `capturedAt` is stamped by the caller from the real clock (Playwright specs
 * may run under faked time elsewhere; here we pass it in to keep this pure).
 */
export async function capture(
  page: Page,
  opts: { phase: string; revisionRef?: string | null; capturedAt: string },
): Promise<CaptureResult> {
  let currentScreen = 'login';
  const violations = installReadonlyGuard(page, () => currentScreen);

  // Passive API snapshotting. Last response per (path+query) wins; bodies are
  // parsed off the wire and awaited before we build signals.
  const apiBodies = new Map<string, unknown>();
  const pending: Promise<void>[] = [];
  page.on('response', (resp) => {
    const req = resp.request();
    if (req.method().toUpperCase() !== 'GET') return;
    const url = resp.url();
    if (!API_CAPTURE_MATCHERS.some((re) => re.test(pathOnly(url)))) return;
    if (resp.status() !== 200) return;
    const ct = resp.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    pending.push(
      resp
        .json()
        .then((body) => {
          apiBodies.set(pathKey(url), body);
        })
        .catch(() => {
          /* non-JSON or disposed body: ignore, it just won't be captured */
        }),
    );
  });

  await loginExistingUser(page, userFromEnv());

  const domSignals: CapturedSignal[] = [];

  for (const spec of SCREENS) {
    currentScreen = spec.screen;
    // 'commit' (not 'domcontentloaded'): with route interception active on a
    // Next.js App Router app that streams RSC, the DOMContentLoaded event does
    // not reliably fire, hanging the navigation. 'commit' resolves once the
    // response headers arrive; the render is then proven by ready().waitFor.
    // Bounded, non-fatal navigation. The backend is a single small pod; under
    // load a response can stall, and an unbounded goto would hang the whole run
    // on one slow screen. Cap it and continue -- the API layer still captured
    // whatever earlier screens fetched, and a skipped screen is a visible gap,
    // not a corrupted run.
    await page.goto(spec.path, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
    // PASSIVE settle only. On this Next.js RSC app under route interception,
    // ACTIVE waits after 'commit' (waitForLoadState('networkidle') or
    // locator.waitFor()) were observed to STALL the client render entirely --
    // the screen stayed blank and every DOM read came back "missing", while a
    // plain timer let it hydrate and paint. The API layer is captured passively
    // by the response listener regardless, so a timer gives it the same settling
    // time without the stall. `ready` is polled (not awaited) below.
    await page.waitForTimeout(SCREEN_SETTLE_MS);

    for (const field of spec.domFields) {
      const locator = field.locate(page).first();
      // Poll passively (no locator.waitFor, which stalls render here) until the
      // value node exists and its text is non-empty and stable across two reads
      // -- summary cards mount with a "zł 0.00" placeholder that settles ~1-2s
      // after data loads, so a bare first read would capture the placeholder.
      let present = false;
      let rawText: string | null = null;
      let prev: string | null = null;
      for (let i = 0; i < DOM_POLL_TRIES; i++) {
        const count = await locator.count().catch(() => 0);
        if (count > 0) {
          const t = (await locator.innerText().catch(() => null))?.trim() ?? null;
          if (t) {
            present = true;
            rawText = t;
            if (t === prev) break; // stable, non-empty: done
          }
          prev = t;
        }
        await page.waitForTimeout(DOM_POLL_INTERVAL_MS);
      }
      const norm = normalize(present, rawText, field.kind);
      domSignals.push({
        screen: spec.screen,
        field: field.field,
        layer: 'dom',
        kind: field.kind,
        rawText: norm.rawText,
        numeric: norm.numeric,
        status: norm.status,
      });
    }
  }

  // Ensure every in-flight body parse has resolved before flattening.
  await Promise.allSettled(pending);

  const apiSignals: CapturedSignal[] = [];
  for (const [key, body] of [...apiBodies.entries()].sort()) {
    const endpoint = key.split('?')[0];
    for (const leaf of jsonLeaves(body)) {
      apiSignals.push({
        screen: `api ${endpoint}`,
        field: leaf.path,
        layer: 'api',
        kind: leaf.kind,
        rawText: leaf.rawText,
        numeric: leaf.numeric,
        status: leaf.status,
      });
    }
  }

  // Fail the whole capture loudly if any write slipped through.
  assertNoWrites(violations);

  const signals = [...domSignals, ...apiSignals].sort(
    (a, b) => a.screen.localeCompare(b.screen) || a.field.localeCompare(b.field),
  );

  return {
    phase: opts.phase,
    revisionRef: opts.revisionRef ?? null,
    baseURL: process.env.BASE_URL ?? '',
    capturedAt: opts.capturedAt,
    signals,
  };
}
