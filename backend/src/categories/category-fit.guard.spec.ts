import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";

/**
 * INV-CATEGORY-001 (FIT): every write of a category onto a row goes through
 * the fit helper, `src/categories/category-fit.ts`.
 *
 * A Transfer category goes only on a transfer row; an ordinary row and a
 * split's category line take only Income or Expense
 * (`docs/specs/transfer-categories.md` section 3). A path that writes a
 * category without asking `fitCategory`, `fitCategories`, `categoryFits` or
 * `categoryIdForCategoryRow` is a path where the refusal is missing, and a
 * refusal is only worth as much as its least-guarded entry point. The database
 * backstop refuses the write too, but with a generic message and only on a
 * category row; the helper is what names the category and checks ownership.
 *
 * What the scan calls a category write, outside specs:
 *   - an object literal with a `categoryId` property whose value is not a
 *     literal `null`, handed to `create`, `save`, `insert`, `update`,
 *     `upsert`, `set` or `values` of a row entity (`Transaction`,
 *     `TransactionSplit`, `ScheduledTransaction`, `ScheduledTransactionSplit`,
 *     `ScheduledTransactionOverride`): `m.create(Transaction, {...})`,
 *     `m.getRepository(Transaction).save({...})`, a repository variable bound
 *     to `getRepository(Transaction)` in the same function,
 *     `.update(Transaction).set({...})`;
 *   - an assignment `x.categoryId = ...` (not `null`) to a variable the same
 *     function hands to such a call;
 *   - SQL text that inserts into or updates a row table
 *     (`transactions`, `transaction_splits`, `scheduled_transactions`,
 *     `scheduled_transaction_splits`, `scheduled_transaction_overrides`) and
 *     names `category_id`.
 *
 * A write passes when the function it sits in (its outermost enclosing
 * function, so a `withScopedDb` callback counts as its method) calls one of
 * the helpers. A write whose category was fitted elsewhere, or which only
 * copies what a row already held, carries `category-fit-ok: <reason>` in a
 * comment on its line or the line above; there is no file allowlist, so the
 * next write in the same file is still found.
 *
 * The scan reads names, not types: it stops the slips the codebase has made,
 * and the entry-point matrix (`test/integration/category-fit-*.spec.ts`) is
 * what holds the behaviour.
 */

const SRC_ROOT = join(__dirname, "..");
const MARKER = "category-fit-ok:";

const ROW_ENTITIES = new Set([
  "Transaction",
  "TransactionSplit",
  "ScheduledTransaction",
  "ScheduledTransactionSplit",
  "ScheduledTransactionOverride",
]);

/** A repository parameter named for a row table. */
const ROW_REPOSITORY_NAME =
  /^(?:transaction|tx|split|scheduled|override)\w*Repo(?:sitory)?$/i;

const WRITE_METHODS = new Set([
  "create",
  "save",
  "insert",
  "update",
  "upsert",
  "set",
  "values",
]);

const FIT_HELPERS = new Set([
  "fitCategory",
  "fitCategories",
  "categoryFits",
  "categoryIdForCategoryRow",
]);

const ROW_TABLES =
  "(?:transactions|transaction_splits|scheduled_transactions|scheduled_transaction_splits|scheduled_transaction_overrides)";
const SQL_WRITE = new RegExp(
  `\\b(?:INSERT\\s+INTO\\s+${ROW_TABLES}\\b|UPDATE\\s+${ROW_TABLES}\\b[\\s\\S]*\\bSET\\b)[\\s\\S]*\\bcategory_id\\b`,
  "i",
);

/**
 * The writes a later step of PR 3 converts, as `file function`
 * (`docs/future-plans/transfer-categories-tasks.md`). Each step removes its
 * entries; shrink-only, and empty when PR 3 is done.
 */
const NOT_YET_CONVERTED = new Set<string>([
  "action-history/action-history.service.ts undoBulkDelete",
  "action-history/action-history.service.ts undoBulkUpdate",
  "action-history/action-history.service.ts undoTransactionDelete",
  "action-history/action-history.service.ts undoTransactionUpdate",
  "action-history/action-history.service.ts undoTransferDelete",
  "action-history/rule-run-undo.ts undoRuleRun",
  "bank-sync/bank-sync-writer.service.ts applyRulePayeeCategories",
  "bank-sync/bank-sync-writer.service.ts write",
  "categories/categories.service.ts reassignTransactions",
  "database/demo-reset.service.ts generateIntradayTransactionsWithinContext",
  "database/demo-seed.service.ts seedScheduledTransactions",
  "database/demo-seed.service.ts seedTransactions",
  "import/import-investment-processor.service.ts processCashTransfer",
  "import/import-regular-processor.service.ts processSplits",
  "import/mny/writers/write-bills.ts writeBills",
  "import/mny/writers/write-investments.ts writeInvestments",
  "import/mny/writers/write-transactions.ts writeTransactions",
  "loan-fees/loan-fees.service.ts syncTemplate",
  "payees/payee-backfill.util.ts applyPayeeCategoryToAll",
  "payees/payee-backfill.util.ts backfillPayeeCategory",
  "scheduled-transactions/scheduled-transaction-override.service.ts createOverride",
  "scheduled-transactions/scheduled-transaction-override.service.ts updateOverride",
  "scheduled-transactions/scheduled-transactions.service.ts createSplits",
  "scheduled-transactions/scheduled-transactions.service.ts createWithoutHistory",
  "scheduled-transactions/scheduled-transactions.service.ts update",
  "shared-expenses/shared-bank-splits.ts restoreBankSplits",
  "shared-expenses/shared-finance-write.ts insertRow",
  "shared-expenses/shared-finance-write.ts undoSharedPosting",
  "shared-expenses/shared-finance-write.ts writeSharedFinance",
  "transaction-rules/transaction-rules-applier.service.ts writeEffects",
  "transactions/transaction-bulk-update.service.ts extractUpdateFields",
  "transactions/transaction-split.service.ts addSplit",
  "transactions/transaction-split.service.ts bulkRecategorizeCategorySplits",
  "transactions/transaction-split.service.ts createSplitsInternal",
  "transactions/transaction-split.service.ts removeSplit",
  "transactions/transaction-transfer.service.ts buildFromUpdateData",
  "transactions/transaction-transfer.service.ts buildToUpdateData",
  "transactions/transaction-transfer.service.ts updateFrozenTransferLeg",
  "transactions/transaction-transfer.service.ts updateSplitTransferLeg",
  "transactions/transactions.service.ts createNew",
  "transactions/transactions.service.ts update",
  "transactions/transfer-leg-columns.ts transferLegColumns",
]);

export interface CategoryWrite {
  readonly file: string;
  readonly line: number;
  readonly shape: "object" | "assignment" | "sql";
  readonly fn: string;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node)
  );
}

/** The outermost function a node sits in, or the source file. */
function outermostFunction(node: ts.Node): ts.Node {
  let found: ts.Node = node.getSourceFile();
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (isFunctionLike(n)) found = n;
  }
  return found;
}

function functionLabel(fn: ts.Node): string {
  if (ts.isSourceFile(fn)) return "<module>";
  const named = fn as ts.FunctionLikeDeclaration;
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  const parent = fn.parent;
  if (
    parent &&
    (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return "<anonymous>";
}

/** Does `scope` call or name one of the fit helpers? */
function callsFitHelper(scope: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && FIT_HELPERS.has(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** `getRepository(Entity)` or `X.getRepository(Entity)` naming a row entity. */
function isRowRepository(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    node.expression.getText().endsWith("getRepository") &&
    node.arguments.length > 0 &&
    ROW_ENTITIES.has(node.arguments[0].getText())
  );
}

/** Variables bound to a row repository anywhere in `scope`. */
function rowRepositoryNames(scope: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      isRowRepository(n.initializer)
    ) {
      names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return names;
}

/**
 * The arguments of `call` that are row values, when `call` writes a row
 * entity; otherwise none.
 */
function rowWriteArguments(
  call: ts.CallExpression,
  repositories: ReadonlySet<string>,
): readonly ts.Expression[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  const method = call.expression.name.text;
  if (!WRITE_METHODS.has(method)) return [];
  const receiver = call.expression.expression;
  const args = [...call.arguments];
  // m.create(Transaction, {...}), m.update(Transaction, criteria, {...})
  if (args.length > 1 && ROW_ENTITIES.has(args[0].getText())) {
    return args.slice(1);
  }
  // m.getRepository(Transaction).save({...}), repo.update(id, {...}), and a
  // repository handed in by a caller under a row's name (`splitRepo`).
  if (
    isRowRepository(receiver) ||
    (ts.isIdentifier(receiver) &&
      (repositories.has(receiver.text) ||
        ROW_REPOSITORY_NAME.test(receiver.text)))
  ) {
    return args;
  }
  // qb.update(Transaction).set({...}), qb.insert().into(Transaction).values()
  if (method === "set" || method === "values") {
    const chain = receiver.getText();
    for (const entity of ROW_ENTITIES) {
      if (
        new RegExp(`\\.(?:update|into)\\(\\s*${entity}\\s*[,)]`).test(chain)
      ) {
        return args;
      }
    }
  }
  return [];
}

/** Object literals an argument holds: itself, an array's, a ternary's. */
function objectLiterals(node: ts.Node): ts.ObjectLiteralExpression[] {
  if (ts.isObjectLiteralExpression(node)) return [node];
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap(objectLiterals);
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...objectLiterals(node.whenTrue),
      ...objectLiterals(node.whenFalse),
    ];
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return objectLiterals(node.expression);
  }
  return [];
}

/** An object literal and the objects its spreads hold (`...(c ? {...} : {})`). */
function withSpreads(
  object: ts.ObjectLiteralExpression,
): ts.ObjectLiteralExpression[] {
  return [
    object,
    ...object.properties.flatMap((property) =>
      ts.isSpreadAssignment(property)
        ? objectLiterals(property.expression).flatMap(withSpreads)
        : [],
    ),
  ];
}

/** Every object literal anywhere inside `node`, a `.map` callback's included. */
function nestedObjectLiterals(node: ts.Node): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * A row's column bag spelled as a type: `Partial<Transaction>` and its kin, or
 * an interface of this file whose members are.
 */
const ROW_TYPE = new RegExp(
  `\\b(?:Partial|DeepPartial|QueryDeepPartialEntity)<\\s*(?:${[...ROW_ENTITIES].join("|")})\\s*>`,
);

function rowTypeNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) &&
      ROW_TYPE.test(n.getText())
    ) {
      names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return names;
}

function isRowTyped(
  type: ts.TypeNode | undefined,
  rowTypes: ReadonlySet<string>,
): boolean {
  if (!type) return false;
  const text = type.getText();
  return (
    ROW_TYPE.test(text) ||
    [...rowTypes].some((name) => new RegExp(`\\b${name}\\b`).test(text))
  );
}

function isNullish(node: ts.Expression): boolean {
  const text = node.getText();
  return text === "null" || text === "undefined";
}

function categoryProperty(
  object: ts.ObjectLiteralExpression,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => {
    if (ts.isShorthandPropertyAssignment(property)) {
      return property.name.text === "categoryId";
    }
    return (
      ts.isPropertyAssignment(property) &&
      property.name.getText() === "categoryId" &&
      !isNullish(property.initializer)
    );
  });
}

export function findCategoryWrites(
  file: string,
  source: string,
): CategoryWrite[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const raw = source.split("\n");
  const lineOf = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
  const marked = (line: number) =>
    raw[line]?.includes(MARKER) || (line > 0 && raw[line - 1].includes(MARKER));
  const out: CategoryWrite[] = [];
  const rowTypes = rowTypeNames(sourceFile);
  const repositoriesByScope = new Map<ts.Node, Set<string>>();
  const fittedByScope = new Map<ts.Node, boolean>();
  const report = (node: ts.Node, shape: CategoryWrite["shape"]) => {
    const scope = outermostFunction(node);
    let fitted = fittedByScope.get(scope);
    if (fitted === undefined) {
      fitted = callsFitHelper(scope);
      fittedByScope.set(scope, fitted);
    }
    const line = lineOf(node);
    if (fitted || marked(line)) return;
    out.push({ file, line: line + 1, shape, fn: functionLabel(scope) });
  };
  const reportObject = (object: ts.ObjectLiteralExpression) => {
    for (const part of withSpreads(object)) {
      const property = categoryProperty(part);
      if (property) report(property, "object");
    }
  };
  const reportAssignments = (scope: ts.Node, name: string | null) => {
    const assign = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === "categoryId" &&
        (name === null || n.left.expression.getText() === name) &&
        !isNullish(n.right)
      ) {
        report(n, "assignment");
      }
      ts.forEachChild(n, assign);
    };
    assign(scope);
  };
  const visit = (node: ts.Node): void => {
    // A function that builds a row's column bag and returns it
    // (`transferLegColumns`, a bulk update's field set).
    if (isFunctionLike(node) && isRowTyped(node.type, rowTypes) && node.body) {
      for (const object of nestedObjectLiterals(node.body)) {
        reportObject(object);
      }
      reportAssignments(node.body, null);
    }
    // A variable typed as one, filled field by field.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isRowTyped(node.type, rowTypes)
    ) {
      if (node.initializer) {
        for (const object of objectLiterals(node.initializer)) {
          reportObject(object);
        }
      }
      reportAssignments(outermostFunction(node), node.name.text);
    }
    if (ts.isCallExpression(node)) {
      const scope = outermostFunction(node);
      let repositories = repositoriesByScope.get(scope);
      if (!repositories) {
        repositories = rowRepositoryNames(scope);
        repositoriesByScope.set(scope, repositories);
      }
      for (const argument of rowWriteArguments(node, repositories)) {
        for (const object of objectLiterals(argument)) reportObject(object);
        // An object built elsewhere in the function and handed over whole:
        // field by field, or by a `.map` over the source rows.
        if (ts.isIdentifier(argument)) {
          const name = argument.text;
          reportAssignments(scope, name);
          const declare = (n: ts.Node): void => {
            if (
              ts.isVariableDeclaration(n) &&
              ts.isIdentifier(n.name) &&
              n.name.text === name &&
              n.initializer
            ) {
              for (const object of nestedObjectLiterals(n.initializer)) {
                reportObject(object);
              }
            }
            // rows.push({...}) before insert(rows)
            if (
              ts.isCallExpression(n) &&
              ts.isPropertyAccessExpression(n.expression) &&
              n.expression.name.text === "push" &&
              n.expression.expression.getText() === name
            ) {
              for (const pushed of n.arguments) {
                for (const object of objectLiterals(pushed)) {
                  reportObject(object);
                }
              }
            }
            ts.forEachChild(n, declare);
          };
          declare(scope);
        }
      }
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      SQL_WRITE.test(node.getText())
    ) {
      report(node, "sql");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  // An assignment reached from two calls is one write.
  const seen = new Set<string>();
  return out.filter((w) => {
    const key = `${w.file}:${w.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (
        [
          "node_modules",
          "dist",
          "__fixtures__",
          "i18n",
          "test-helpers",
        ].includes(entry)
      ) {
        continue;
      }
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
    if (entry.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

describe("a category write goes through the fit helper (INV-CATEGORY-001)", () => {
  const writes = sourceFiles(SRC_ROOT).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    if (!/categoryId|category_id/.test(source)) return [];
    return findCategoryWrites(relative(SRC_ROOT, file), source);
  });
  const key = (w: CategoryWrite) => `${w.file} ${w.fn}`;

  it("finds no category write that skips the fit helper", () => {
    const offenders = writes
      .filter((w) => !NOT_YET_CONVERTED.has(key(w)))
      .map((w) => `${w.file}:${w.line} [${w.shape}] in ${w.fn}`);
    // A failure names the write; ask `fitCategory` / `fitCategories`
    // (src/categories/category-fit.ts) in the function that writes, or mark a
    // write that only copies an already-fitted value with the marker above.
    expect(offenders).toEqual([]);
  });

  it("keeps the not-yet-converted list to writes that still exist", () => {
    const found = new Set(writes.map(key));
    expect([...NOT_YET_CONVERTED].filter((k) => !found.has(k))).toEqual([]);
  });

  describe("the scan", () => {
    const scan = (code: string) =>
      findCategoryWrites("x.ts", code).map((w) => w.shape);

    it.each([
      ["a create", "function f(m) { m.create(Transaction, { categoryId }); }"],
      [
        "an update with a value",
        "function f(m, dto) { m.update(TransactionSplit, id, { categoryId: dto.categoryId }); }",
      ],
      [
        "a repository save",
        "function f(m, id) { m.getRepository(ScheduledTransaction).save({ id, categoryId: id }); }",
      ],
      [
        "a repository variable",
        "function f(m, c) { const repo = m.getRepository(Transaction); repo.update(id, { categoryId: c }); }",
      ],
      [
        "a query builder set",
        "function f(m, c) { m.createQueryBuilder().update(Transaction).set({ categoryId: c }).execute(); }",
      ],
      [
        "an object built field by field",
        "function f(m, c) { const data = {}; data.categoryId = c; m.update(Transaction, id, data); }",
      ],
      [
        "rows mapped and inserted",
        "function f(repo, rows) { const out = rows.map((r) => ({ id: r.id, categoryId: r.c })); m.getRepository(Transaction).insert(out); }",
      ],
      [
        "rows pushed and inserted",
        "function f(m, c) { const rows = []; rows.push({ categoryId: c }); m.getRepository(Transaction).insert(rows); }",
      ],
      [
        "a repository handed in under a row's name",
        "function f(splitRepo, c) { splitRepo.insert([{ categoryId: c }]); }",
      ],
      [
        "a conditional spread",
        "function f(m, c) { m.update(Transaction, id, { ...(c ? { categoryId: c } : {}) }); }",
      ],
      [
        "a column bag a helper returns",
        "function bag(dto): Partial<Transaction> { const d: Record<string, unknown> = {}; d.categoryId = dto.c; return d; }",
      ],
      [
        "an interface of row column bags",
        "interface Legs { from: Partial<Transaction> }\nfunction legs(c): Legs { return { from: { categoryId: c } }; }",
      ],
      [
        "a variable typed as a row",
        "function f(c) { const data: Partial<TransactionSplit> = {}; data.categoryId = c; return data; }",
      ],
      [
        "SQL that sets the column",
        "function f(m) { m.query(`UPDATE transaction_splits SET category_id = $1 WHERE id = $2`); }",
      ],
      [
        "SQL that inserts it",
        'function f(m) { m.query("INSERT INTO transactions (id, category_id) VALUES ($1, $2)"); }',
      ],
    ])("fails %s", (_name, code) => {
      expect(scan(code)).not.toEqual([]);
    });

    it.each([
      [
        "a write beside the helper",
        "async function f(m, c) { await fitCategory(m, u, c, 'category'); m.create(Transaction, { categoryId: c }); }",
      ],
      [
        "a write in a callback of a method that asks the helper",
        "class S { async f(c) { await withScopedDb(ds, async (m) => { await fitCategories(m, u, []); m.save(TransactionSplit, { categoryId: c }); }); } }",
      ],
      [
        "a cleared category",
        "function f(m) { m.update(Transaction, id, { categoryId: null }); }",
      ],
      [
        "another entity",
        "function f(m, c) { m.create(Payee, { defaultCategoryId: c, categoryId: c }); }",
      ],
      [
        "a read",
        "function f(m) { m.query(`SELECT category_id FROM transactions WHERE id = $1`); }",
      ],
      [
        "a marked write",
        "function f(m, c) {\n  // category-fit-ok: copies the row's own value\n  m.create(Transaction, { categoryId: c });\n}",
      ],
    ])("passes %s", (_name, code) => {
      expect(scan(code)).toEqual([]);
    });
  });
});
