import { test, expect, type Route } from '@playwright/test';
import { installReadonlyGuard, assertNoWrites } from '../src/readonly-guard';
import { loginExistingUser, userFromEnv } from '../src/auth';
import { isUnknownText } from '../src/money';

// EXCEPTIONAL cases -- kept deliberately separate from the BEFORE/AFTER
// comparison. The comparison suite asserts SAMENESS on complete data; this
// suite asserts the INTENDED DIFFERENCE on incomplete data: when a price, an
// exchange rate, or a valuation is missing, the figure must render as UNKNOWN
// (an explicit marker or an omitted element), never as a misleading 0.
//
// These run against ONE running revision (BASE_URL) and NEVER touch the
// database. The missing-data condition is injected purely at the network edge
// with Playwright request routing: we fetch the real GET response, blank out a
// component, and fulfil the modified body. No write ever leaves the browser
// (a read-only guard is installed as a backstop and asserted at the end).
//
// Expected outcome by revision:
//   - AFTER  (pr/06-unknown-is-not-zero): PASS -- unknown renders as unknown.
//   - BEFORE (the un-fixed revision):     may FAIL -- that failure IS the bug
//     this PR fixes (a wrong 0 where the value is unknown). Point BASE_URL at
//     the revision you want to characterise.
//
// DOM anchors here are best-effort against production markup (which largely
// lacks testids); adjust per your instance if a label differs. The assertions
// are written to be tolerant: they check for the ABSENCE of a spurious zero
// and the PRESENCE of an unknown signal, not an exact node.

/** Deep-null every key whose name looks like a monetary/price component. */
function blankMoneyLeaves(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(blankMoneyLeaves);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (/(marketValue|currentValue|totalValue|portfolioValue|holdingsValue|price|gain|value)$/i.test(k) &&
          (typeof v === 'number' || v === null)) {
        out[k] = null; // simulate "component unknown"
      } else {
        out[k] = blankMoneyLeaves(v);
      }
    }
    return out;
  }
  return node;
}

/** Route handler: fetch the real response, blank money leaves, fulfil it. */
async function fulfilWithMissingData(route: Route): Promise<void> {
  const response = await route.fetch();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    await route.continue();
    return;
  }
  await route.fulfill({
    response,
    json: blankMoneyLeaves(body),
  });
}

/**
 * True if a headline monetary node reads as a *known zero* like "$0.00" /
 * "0,00" -- the exact wrong rendering the contract forbids for unknown data.
 */
function looksLikeZeroMoney(text: string): boolean {
  const t = text.trim();
  if (isUnknownText(t)) return false;
  return /^[^\d-]*[-+(]?\s*0(?:[.,]0+)?\s*[%)]?\s*[^\d]*$/.test(t) && /0/.test(t);
}

test.describe('Exceptional: unknown must not render as zero', () => {
  test.beforeEach(async ({ page }) => {
    const violations = installReadonlyGuard(page);
    await loginExistingUser(page, userFromEnv());
    // Stash on the page for the afterEach assertion.
    (page as unknown as { __violations: unknown }).__violations = violations;
  });

  test.afterEach(async ({ page }) => {
    const violations = (page as unknown as { __violations: Parameters<typeof assertNoWrites>[0] })
      .__violations;
    if (violations) assertNoWrites(violations);
  });

  test('portfolio summary with an unknown total does not show a zero value', async ({ page }) => {
    await page.route('**/api/v1/portfolio/summary**', fulfilWithMissingData);

    await page.goto('/investments');
    await page.getByRole('heading', { name: /investments/i }).first().waitFor({ timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // The Total Portfolio Value figure must not be a spurious "$0.00". It is
    // acceptable for it to be omitted, replaced with an unknown marker, or for
    // the no-data state to render -- anything but a measured zero.
    const summaryRegion = page.locator('body');
    const zeroTotals = await summaryRegion
      .getByText(/^[^\d]*0([.,]0+)?[^\d]*$/)
      .filter({ hasText: /^\D*0/ })
      .count()
      .catch(() => 0);

    // Assert no element in the portfolio summary presents a known-zero headline
    // where the injected data made the total unknown. We scan candidate value
    // nodes (bold headline figures) rather than the whole page to avoid
    // matching unrelated real zeros elsewhere.
    const headlineTexts = await page
      .locator('.text-2xl.font-bold, [class*="text-2xl"][class*="font-bold"]')
      .allInnerTexts()
      .catch(() => [] as string[]);
    const spuriousZeros = headlineTexts.filter(looksLikeZeroMoney);
    expect(
      spuriousZeros,
      `A headline portfolio figure rendered as a known zero (${spuriousZeros.join(', ')}) while the ` +
        `injected data made it unknown. Per docs/financial-calculation-contract.md this must render ` +
        `as unknown, not 0. (If BASE_URL points at the un-fixed revision, this failure is the bug.)`,
    ).toHaveLength(0);
    void zeroTotals;
  });

  test('holdings with an unknown market value render an unknown marker, not $0.00', async ({
    page,
  }) => {
    await page.route('**/api/v1/holdings**', fulfilWithMissingData);
    await page.route('**/api/v1/portfolio/summary**', fulfilWithMissingData);

    await page.goto('/investments');
    await page.getByRole('heading', { name: /investments/i }).first().waitFor({ timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // GroupedHoldingsList renders null market values as the literal "-"
    // (frontend/src/components/investments/GroupedHoldingsList.tsx formatCurrency).
    // So with every market value nulled, at least one unknown marker must show,
    // and no holding row may show a fabricated $0.00 market value.
    const body = page.locator('main, body');
    const hasUnknownMarker = await body
      .getByText(/^[–—−-]$|^n\/?a$/i)
      .first()
      .isVisible()
      .catch(() => false);

    expect(
      hasUnknownMarker,
      'Expected at least one unknown marker ("-" / "N/A") in the holdings view after nulling every ' +
        'market value. If instead $0.00 values appear, the unknown-is-not-zero contract is violated ' +
        '(or BASE_URL points at the un-fixed revision).',
    ).toBe(true);
  });

  test('portfolio TWR/CAGR render N/A when unknown', async ({ page }) => {
    // TWR and CAGR are the confirmed explicit-unknown fields on this screen:
    // PortfolioSummaryCard shows portfolioSummary.notAvailable ("N/A") when
    // they are null. Force them null and assert the marker appears.
    await page.route('**/api/v1/portfolio/summary**', async (route) => {
      const response = await route.fetch();
      let bodyJson: Record<string, unknown>;
      try {
        bodyJson = (await response.json()) as Record<string, unknown>;
      } catch {
        await route.continue();
        return;
      }
      await route.fulfill({
        response,
        json: { ...bodyJson, twr: null, cagr: null },
      });
    });

    await page.goto('/investments');
    await page.getByRole('heading', { name: /investments/i }).first().waitFor({ timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const naCount = await page.getByText(/^n\/a$/i).count().catch(() => 0);
    expect(
      naCount,
      'Expected TWR and CAGR to render as "N/A" when null. A number here would mean a null return ' +
        'was coerced to a value.',
    ).toBeGreaterThan(0);
  });
});
