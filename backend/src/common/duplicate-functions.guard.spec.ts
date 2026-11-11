import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";

import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * A function body is written once and imported, not copied into the next file
 * that needs it. This guard finds every top-level function (a declaration, or a
 * `const` holding an arrow or function expression) whose parameters, return
 * type and body are the same token sequence as another's in the same layer, and
 * fails on each one that is neither registered nor in `BASELINE`. Names,
 * modifiers, comments, formatting and the names of simple parameters do not
 * count; class methods are out of scope. The layers share no package, so a
 * deliberate cross-layer mirror is held by a parity test, not by this guard.
 *
 * A deliberate copy carries `// allow-duplicate: <reason>` on the line above
 * it; the marker is checked in both directions (a reason is required, and a
 * marker on a function that no longer has a twin is stale). Where the copies
 * belong and what to import is in `docs/shared-helpers.md`.
 */

/** Below this many tokens a body is too small to be worth a shared import. */
const MIN_TOKENS = 25;

/** Test-support code is allowed to repeat itself; it is not shipped. */
const TEST_SUPPORT =
  /(^|\/)(__tests__|__mocks__|[^/]*fixture[^/]*)(\/|$)|^frontend\/src\/test\/|\.(spec|test|e2e-spec|harness)\.tsx?$|\.d\.ts$/i;

const MARKER = "allow-duplicate:";
const MIN_REASON = 10;

/**
 * Shrink-only: copies that existed when the guard was added, as
 * `<path>#<name>`. An entry is deleted by importing one copy instead
 * (`docs/shared-helpers.md`); a new copy is never made to pass by adding one.
 */
const BASELINE: readonly string[] = [
  "backend/src/accounts/annuity-relevel.util.ts#toYmd",
  "backend/src/loan-rate-changes/loan-rate-changes.service.ts#toYmd",
  "backend/src/accounts/statement-cycle.util.ts#daysInMonth",
  "backend/src/warranties/warranty-expiry.util.ts#daysInMonth",
  "backend/src/backup/auto-backup.service.ts#utcDateString",
  "backend/src/backup/offsite/backup-offsite-dispatch.service.ts#utcDateString",
  "backend/src/backup/offsite/backup-offsite-config.ts#normalizeOffsitePrefix",
  "backend/src/backup/storage/backup-store-location.ts#normalizeStorePrefix",
  "backend/src/budgets/budget-alert.service.ts#isReminderReEmit",
  "backend/src/notification-center/notification-reminder.service.ts#isReminderReEmit",
  "backend/src/common/time-series/price-boundary.util.ts#addDays",
  "backend/src/strategies/gem-performance.service.ts#addDays",
  "backend/src/database/add-skip-price-updates-column.ts#requiredEnv",
  "backend/src/database/fix-linked-transactions.ts#requiredEnv",
  "backend/src/database/demo-seed-data/securities.ts#seededRandom",
  "backend/src/database/demo-seed-data/transactions.ts#seededRandom",
  "backend/src/email-receipts/ai/email-receipt-ai.service.ts#receiptNotFound",
  "backend/src/email-receipts/parsers/email-receipt-parser-tools.service.ts#receiptNotFound",
  "backend/src/email-receipts/parsers/email-receipt-parsers.service.ts#receiptNotFound",
  "backend/src/email-receipts/pipeline/email-receipt-pipeline.service.ts#receiptNotFound",
  "backend/src/email-receipts/receipts/receipt-disposal.ts#receiptNotFound",
  "backend/src/email-receipts/imap/html-lines.util.ts#cutText",
  "backend/src/email-receipts/imap/mail-text.util.ts#cap",
  "backend/src/email-receipts/parsing/receipt-glob.ts#clean",
  "backend/src/transaction-rules/rule-glob-capture.ts#clean",
  "backend/src/email-receipts/parsing/receipt-glob.ts#toSegments",
  "backend/src/transaction-rules/rule-glob-capture.ts#toSegments",
  "backend/src/import/csv-parser.ts#truncate",
  "backend/src/import/ofx-parser.ts#truncate",
  "backend/src/import/qif-parser.ts#truncate",
  "backend/src/notifications/email-templates.ts#notificationAccentColour",
  "backend/src/notifications/email-templates.ts#severityColor",
  "backend/src/transaction-rules/rule-name-mapping.ts#stringsOf",
  "backend/src/transaction-rules/rule-references.ts#toList",
  "backend/src/transaction-rules/rule-validation.loan-settlement.ts#checkKeys",
  "backend/src/transaction-rules/rule-validation.ts#checkKeys",
  "frontend/src/app/ai-reviews/layout.tsx#AiReviewsLayout",
  "frontend/src/app/email-receipts/layout.tsx#EmailReceiptsLayout",
  "frontend/src/app/ai/layout.tsx#AiSectionLayout",
  "frontend/src/app/insights/layout.tsx#InsightsSectionLayout",
  "frontend/src/app/categories/[id]/page.tsx#isoDaysAgo",
  "frontend/src/app/payees/[id]/page.tsx#isoDaysAgo",
  "frontend/src/app/categories/[id]/page.tsx#tabFromQuery",
  "frontend/src/app/payees/[id]/page.tsx#tabFromQuery",
  "frontend/src/app/securities/[id]/page.tsx#tabFromQuery",
  "frontend/src/app/categories/loading.tsx#CategoriesLoading",
  "frontend/src/app/payees/loading.tsx#PayeesLoading",
  "frontend/src/components/accounts/AccountList.tsx#getStoredValue",
  "frontend/src/hooks/useTransactionFilters.ts#getStoredValue",
  "frontend/src/components/accounts/asset-detail/AssetSummaryCards.tsx#toLocalDate",
  "frontend/src/components/accounts/credit-card-detail/PayoffCalculator.tsx#toLocalDate",
  "frontend/src/components/accounts/credit-card-detail/StatementPanel.tsx#toLocalDate",
  "frontend/src/components/accounts/shared/ForeignCurrencyFeeChart.tsx#quarterOf",
  "frontend/src/components/transactions/CategoryPayeeBarChart.tsx#quarterOf",
  "frontend/src/components/categories/ImportDefaultCategoriesDialog.tsx#countryLabel",
  "frontend/src/components/securities/BondProgramSelect.tsx#bondCountryName",
  "frontend/src/components/dashboard/FavouriteSecurities.tsx#RefreshButton",
  "frontend/src/components/dashboard/TopMovers.tsx#RefreshButton",
  "frontend/src/components/ui/CalendarPopover.tsx#getDaysInMonth",
  "frontend/src/lib/frequency.ts#daysInMonth",
  "frontend/src/hooks/useDailyBalanceTotals.ts#dailyBalanceTotalsKey",
  "frontend/src/hooks/useDailyMovements.ts#dailyMovementsKey",
  "frontend/src/hooks/useInvestmentDailyValues.ts#investmentDailyValuesKey",
  "frontend/src/lib/aiActionSignal.ts#subscribeAiAction",
  "frontend/src/lib/pushDevicesSignal.ts#subscribePushDevices",
  "frontend/src/lib/reconciliationSignal.ts#subscribeReconciliation",
  "frontend/src/lib/undoRedoSignal.ts#subscribeUndoRedo",
  "frontend/src/lib/external-url.ts#externalUrlLabel",
  "frontend/src/lib/security-detail.ts#documentHost",
  "frontend/src/lib/loan-history.ts#daysBetween",
  "frontend/src/lib/loan-schedule-rows.ts#daysBetween",
];

interface Fn {
  path: string;
  line: number;
  name: string;
  shape: string;
  marker: string | null; // the marker comment text, or null
}

const layerOf = (path: string) => path.split("/")[0];

function leaves(node: ts.Node, sf: ts.SourceFile, out: ts.Node[]): void {
  if (
    ts.isJSDoc(node) ||
    (node.kind >= ts.SyntaxKind.FirstJSDocNode &&
      node.kind <= ts.SyntaxKind.LastJSDocNode)
  )
    return;
  const kids = node.getChildren(sf);
  if (kids.length === 0) out.push(node);
  else kids.forEach((k) => leaves(k, sf, out));
}

/** Token sequence of type parameters, parameters, return type and body. */
function tokensOf(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string[] {
  const own = new Map<string, string>();
  fn.parameters.forEach((p, i) => {
    if (ts.isIdentifier(p.name)) own.set(p.name.text, `p${i}`);
  });
  const tokens: ts.Node[] = [];
  const pieces = [
    ...(fn.typeParameters ?? []),
    ...fn.parameters,
    fn.type,
    fn.body,
  ];
  pieces.forEach((n) => n && leaves(n, sf, tokens));
  return tokens.map((t) =>
    ts.isIdentifier(t) ? (own.get(t.text) ?? t.text) : t.getText(sf),
  );
}

/** The `// allow-duplicate:` line comment directly above a statement, if any. */
function markerOf(st: ts.Statement, sf: ts.SourceFile): string | null {
  const ranges = ts.getLeadingCommentRanges(sf.text, st.getFullStart()) ?? [];
  for (const r of ranges) {
    if (r.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const text = sf.text.slice(r.pos, r.end).replace(/^\/\/\s*/, "");
    if (text.startsWith(MARKER)) return text;
  }
  return null;
}

function functionsOf(path: string, text: string): Fn[] {
  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: Fn[] = [];
  const add = (
    st: ts.Statement,
    name: string,
    fn: ts.FunctionLikeDeclaration,
  ) => {
    const tokens = tokensOf(fn, sf);
    if (tokens.length < MIN_TOKENS) return;
    const shape = tokens.join(" ");
    found.push({
      path,
      name,
      shape,
      marker: markerOf(st, sf),
      line: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1,
    });
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      add(st, st.name.text, st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (
          ts.isIdentifier(d.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          add(st, d.name.text, init);
        }
      }
    }
  }
  return found;
}

const markerReason = (marker: string) => marker.slice(MARKER.length).trim();

interface Analysis {
  groups: Fn[][]; // two or more unmarked functions sharing a shape
  badMarkers: string[]; // marker without a reason
  staleMarkers: string[]; // marker on a function with no twin
}

function analyse(fns: Fn[]): Analysis {
  const byShape = new Map<string, Fn[]>();
  for (const f of fns) {
    const key = `${layerOf(f.path)}\0${f.shape}`;
    byShape.set(key, [...(byShape.get(key) ?? []), f]);
  }
  const groups: Fn[][] = [];
  const badMarkers: string[] = [];
  const staleMarkers: string[] = [];
  for (const members of byShape.values()) {
    const open = members.filter((f) => !f.marker);
    if (open.length >= 2) groups.push(open);
    for (const f of members) {
      if (!f.marker) continue;
      const where = `${f.path}:${f.line} ${f.name}`;
      if (markerReason(f.marker).length < MIN_REASON) badMarkers.push(where);
      if (members.length < 2) staleMarkers.push(where);
    }
  }
  return { groups, badMarkers, staleMarkers };
}

const entryOf = (f: Fn) => `${f.path}#${f.name}`;
const describeMember = (f: Fn) => `${f.path}:${f.line} ${f.name}`;

describe("duplicate-function shape and marker helpers", () => {
  const shapes = (src: string) =>
    functionsOf("backend/src/x.ts", src).map((f) => f.shape);
  const one = (src: string) => shapes(src)[0];
  const BODY = `{ const t = a.trim(); if (t.length === 0) { return null; } return t.toLowerCase().replace(/ /g, "-") + "-" + b; }`;
  const base = `export function f(a: string, b: string) ${BODY}`;

  it("ignores formatting and comments", () => {
    const spaced = `export function f(a: string, b: string) {\n  // note\n  const t = a.trim(); /* x */\n  if (t.length === 0) { return null; }\n  return t.toLowerCase().replace(/ /g, "-") + "-" + b;\n}`;
    expect(one(spaced)).toBe(one(base));
  });

  it("ignores renamed parameters and a different function name", () => {
    const renamed = base
      .replace(/\ba\b/g, "x")
      .replace(/\bb\b/g, "y")
      .replace("function f", "function g");
    expect(one(renamed)).toBe(one(base));
  });

  it("sees one changed token", () => {
    expect(one(base.replace("toLowerCase", "toUpperCase"))).not.toBe(one(base));
  });

  it("ignores a JSDoc above the function", () => {
    expect(one(`/** Docs with @param a x */\n${base}`)).toBe(one(base));
  });

  it("keeps one-liners out", () => {
    expect(shapes("export const t = (s: string) => s.trim();")).toEqual([]);
  });

  it("detects a marker with a reason and exempts the function", () => {
    const marked = `// allow-duplicate: mirrored on purpose\n${base}`;
    const fns = [
      ...functionsOf("backend/src/a.ts", marked),
      ...functionsOf("backend/src/b.ts", base),
    ];
    expect(fns[0].marker).toBe("allow-duplicate: mirrored on purpose");
    const r = analyse(fns);
    expect(r.groups).toEqual([]);
    expect(r.badMarkers).toEqual([]);
    expect(r.staleMarkers).toEqual([]);
  });

  it("reports a marker without a reason, and a stale marker", () => {
    const bare = functionsOf(
      "backend/src/a.ts",
      `// allow-duplicate:\n${base}`,
    );
    const r = analyse(bare);
    expect(r.badMarkers).toEqual(["backend/src/a.ts:2 f"]);
    expect(r.staleMarkers).toEqual(["backend/src/a.ts:2 f"]);
  });

  it("does not take an ordinary comment for a marker", () => {
    const fns = functionsOf(
      "backend/src/a.ts",
      `// duplicate of the other one\n${base}`,
    );
    expect(fns[0].marker).toBeNull();
  });

  it("compares inside one layer only", () => {
    const fns = [
      ...functionsOf("backend/src/a.ts", base),
      ...functionsOf("frontend/src/a.ts", base),
    ];
    expect(analyse(fns).groups).toEqual([]);
  });

  it("keeps a group of two when one of three is marked", () => {
    const fns = [
      ...functionsOf("backend/src/a.ts", base),
      ...functionsOf("backend/src/b.ts", base),
      ...functionsOf(
        "backend/src/c.ts",
        `// allow-duplicate: kept for the test\n${base}`,
      ),
    ];
    const r = analyse(fns);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].map((f) => f.path)).toEqual([
      "backend/src/a.ts",
      "backend/src/b.ts",
    ]);
  });
});

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;
const TIMEOUT = 60_000;
const COPY_MESSAGE =
  "import the existing function instead (a generic helper goes in backend/src/common/helpers/ or frontend/src/lib/helpers/), or register a deliberate copy with `// allow-duplicate: <reason>`; see docs/shared-helpers.md";
const STALE_MESSAGE = "stale BASELINE entry, delete the line";

describeTree("no function body is written twice in one layer", () => {
  let analysis: Analysis;

  beforeAll(() => {
    const root = requireRepoRoot(REPO_ROOT);
    const files = gitListFiles(root, "-- backend/src frontend/src").filter(
      (p) => /\.tsx?$/.test(p) && !TEST_SUPPORT.test(p),
    );
    analysis = analyse(
      files.flatMap((p) => functionsOf(p, readFileSync(join(root, p), "utf8"))),
    );
  }, TIMEOUT);

  it(
    "has no copy outside BASELINE or a registered exception",
    () => {
      const baseline = new Set(BASELINE);
      const offenders = analysis.groups
        .filter((g) => g.some((f) => !baseline.has(entryOf(f))))
        .map((g) => g.map(describeMember).join("  <->  "));
      expect({ [COPY_MESSAGE]: offenders }).toEqual({ [COPY_MESSAGE]: [] });
    },
    TIMEOUT,
  );

  it(
    "keeps BASELINE to copies that still exist (delete the line of a fixed one)",
    () => {
      const live = new Set(analysis.groups.flat().map(entryOf));
      expect({ [STALE_MESSAGE]: BASELINE.filter((e) => !live.has(e)) }).toEqual(
        {
          [STALE_MESSAGE]: [],
        },
      );
    },
    TIMEOUT,
  );

  it(
    "gives every allow-duplicate marker a reason and a twin",
    () => {
      expect({
        withoutReason: analysis.badMarkers,
        stale: analysis.staleMarkers,
      }).toEqual({
        withoutReason: [],
        stale: [],
      });
    },
    TIMEOUT,
  );
});
