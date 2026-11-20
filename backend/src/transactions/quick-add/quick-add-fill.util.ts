/**
 * Filling what the text did not give (`docs/future-plans/quick-add.md`,
 * "Filling what was not typed"), as a pure function of what the reader read
 * and what `QuickAddInterpretService` loaded. A pinned field always wins and
 * is never re-read from the text.
 *
 * - kind: transfer when two accounts were named, or one with `to` or `from`;
 *   otherwise deposit for an income category or a payee whose last 10 rows
 *   are mostly deposits (inferred); otherwise payment (default).
 * - account and toAccount: `quick-add-fill-accounts.util.ts`.
 * - category (not for a transfer): the payee's most frequent category over
 *   its last 10 unsplit rows, the most recent winning a tie; otherwise its
 *   default category (inferred).
 * - date: today (default).
 *
 * Then the blockers, and the balance line under the predicate
 * `TransactionsService.create` decides the balance with.
 */
import { decimalPlacesOf } from "../../common/amount-precision.util";
import { moneyDecimalsForCode } from "../../common/currency-places.util";
import { roundMoney } from "../../common/round.util";
import {
  QUICK_ADD_KINDS,
  QuickAddAccountRef,
  QuickAddBalance,
  QuickAddBlocker,
  QuickAddCandidateAccount,
  QuickAddCandidateCategory,
  QuickAddCategoryRef,
  QuickAddField,
  QuickAddInterpretation,
  QuickAddKind,
  QuickAddSource,
} from "./quick-add.types";
import {
  QuickAddFillInput,
  categoryRef,
  field,
  rankByUsage,
  withoutIds,
} from "./quick-add-fill-shared.util";
import {
  accountsImplyTransfer,
  resolveAccounts,
  toField,
} from "./quick-add-fill-accounts.util";

/** Blockers that make the amount not the one the save would write. */
const AMOUNT_BLOCKERS: ReadonlySet<QuickAddBlocker> = new Set([
  "zeroAmount",
  "amountPrecision",
  "foreignCurrency",
]);

/** The payee's most frequent recent category, the most recent winning a tie. */
function historyCategories(
  input: QuickAddFillInput,
): QuickAddCandidateCategory[] {
  const counts = new Map<string, { count: number; newest: number }>();
  for (const [index, id] of input.history.categoryIds.entries()) {
    if (!id || !input.categories.has(id)) continue;
    const seen = counts.get(id);
    counts.set(id, {
      count: (seen?.count ?? 0) + 1,
      newest: seen?.newest ?? index,
    });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].newest - b[1].newest)
    .map(([id]) => input.categories.get(id)!);
}

function resolveCategory(input: QuickAddFillInput): {
  field: QuickAddField<QuickAddCategoryRef>;
  category: QuickAddCandidateCategory | null;
} {
  const { reading, pins, categoryUsage } = input;
  const collisions = rankByUsage(
    reading.categoryAlternatives.map((c) => ({ ...c, name: c.path })),
    categoryUsage,
  );
  if (pins.category) {
    return {
      field: field(categoryRef(pins.category), "pinned"),
      category: pins.category,
    };
  }
  if (reading.category) {
    const ranked = rankByUsage(
      reading.category.candidates.map((c) => ({ ...c, name: c.path })),
      categoryUsage,
    );
    const top = ranked[0];
    const others = withoutIds([...ranked.slice(1), ...collisions], [top.id]);
    return {
      field: field(
        categoryRef(top),
        "typed",
        others.map(categoryRef),
        ranked.length > 1,
      ),
      category: top,
    };
  }
  const defaultId = input.payee.payee?.defaultCategoryId ?? null;
  const defaultCategory = defaultId
    ? (input.categories.get(defaultId) ?? null)
    : null;
  const inferred = withoutIds(
    [
      ...historyCategories(input),
      ...(defaultCategory ? [defaultCategory] : []),
    ],
    [],
  );
  const chosen = inferred[0] ?? null;
  const alternatives = withoutIds(
    [...inferred.slice(1), ...collisions],
    [chosen?.id],
  );
  return {
    field: field(
      chosen ? categoryRef(chosen) : null,
      "inferred",
      alternatives.map(categoryRef),
    ),
    category: chosen,
  };
}

function kindField(
  value: QuickAddKind,
  source: QuickAddSource,
): QuickAddField<QuickAddKind> {
  return field(
    value,
    source,
    QUICK_ADD_KINDS.filter((kind) => kind !== value),
  );
}

function blockersFor(facts: {
  amount: number | null;
  exceedsPrecision: boolean;
  account: QuickAddCandidateAccount | null;
  toAccount: QuickAddCandidateAccount | null;
  ambiguousAccount: boolean;
  isTransfer: boolean;
  foreignCurrency: boolean;
}): QuickAddBlocker[] {
  const { amount, account, toAccount, isTransfer } = facts;
  const blockers: QuickAddBlocker[] = [];
  if (amount === null) blockers.push("missingAmount");
  else if (amount === 0) blockers.push("zeroAmount");
  else if (facts.exceedsPrecision) blockers.push("amountPrecision");
  if (!account) blockers.push("missingAccount");
  if (facts.ambiguousAccount) blockers.push("ambiguousAccount");
  if (isTransfer && !toAccount) blockers.push("missingToAccount");
  if (isTransfer && account && toAccount && account.id === toAccount.id) {
    blockers.push("sameAccount");
  }
  if (facts.foreignCurrency) blockers.push("foreignCurrency");
  if (
    isTransfer &&
    account &&
    toAccount &&
    account.currencyCode.toUpperCase() !== toAccount.currencyCode.toUpperCase()
  ) {
    blockers.push("crossCurrencyTransfer");
  }
  return blockers;
}

/**
 * The account's balance before and after the save. A future-dated row moves
 * no current balance until its day (`isTransactionInFuture`, the predicate
 * `create()` uses), so `after` is null and `movesOn` says when it moves.
 */
function balanceLine(
  account: QuickAddCandidateAccount,
  signedAmount: number,
  at: { date: string; places: number; isFuture: (date: string) => boolean },
): QuickAddBalance {
  const future = at.isFuture(at.date);
  return {
    accountId: account.id,
    currencyCode: account.currencyCode,
    current: account.currentBalance,
    after: future
      ? null
      : roundMoney(account.currentBalance + signedAmount, at.places),
    movesOn: future ? at.date : null,
  };
}

export function fillQuickAdd(input: QuickAddFillInput): QuickAddInterpretation {
  const { reading, pins } = input;
  const stated: { value: QuickAddKind; source: QuickAddSource } | null =
    pins.kind
      ? { value: pins.kind, source: "pinned" }
      : reading.kind
        ? { value: reading.kind, source: "typed" }
        : null;
  const isTransfer = stated
    ? stated.value === "transfer"
    : accountsImplyTransfer(reading.accounts);

  const accounts = resolveAccounts(input, isTransfer);
  const account = accounts.account.account;
  const toAccount = isTransfer ? accounts.toAccount.account : null;
  const category = isTransfer
    ? { field: field<QuickAddCategoryRef>(null, "none"), category: null }
    : resolveCategory(input);

  const recent = input.history.recent;
  const mostlyDeposits =
    recent.length > 0 &&
    recent.filter((row) => row.amount > 0).length > recent.length / 2;
  const kind = stated
    ? kindField(stated.value, stated.source)
    : isTransfer
      ? kindField("transfer", "inferred")
      : category.category?.isIncome || mostlyDeposits
        ? kindField("deposit", "inferred")
        : kindField("payment", "default");

  const places = moneyDecimalsForCode(
    input.currencyPlaces,
    account?.currencyCode,
  );
  const rawAmount = pins.amount ?? reading.amount?.value ?? null;
  const exceedsPrecision =
    rawAmount !== null && !!account && decimalPlacesOf(rawAmount) > places;
  const amount =
    rawAmount === null || !account || exceedsPrecision
      ? rawAmount
      : roundMoney(rawAmount, places);
  // A pinned amount was set in the account's currency on the chip.
  const typedCurrency =
    pins.amount === undefined ? (reading.amount?.currency ?? null) : null;
  const foreignCurrency =
    !!typedCurrency &&
    !!account &&
    !typedCurrency.codes.includes(account.currencyCode.toUpperCase());

  const date = pins.date ?? reading.date ?? input.today;
  const dateSource: QuickAddSource = pins.date
    ? "pinned"
    : reading.date
      ? "typed"
      : "default";

  const blockers = blockersFor({
    amount,
    exceedsPrecision,
    account,
    toAccount,
    ambiguousAccount:
      accounts.account.ambiguous ||
      (isTransfer && accounts.toAccount.ambiguous),
    isTransfer: kind.value === "transfer",
    foreignCurrency,
  });

  const balance =
    account && amount !== null && !blockers.some((b) => AMOUNT_BLOCKERS.has(b))
      ? balanceLine(account, kind.value === "deposit" ? amount : -amount, {
          date,
          places,
          isFuture: input.isFuture,
        })
      : null;

  return {
    kind,
    amount: field(amount, pins.amount !== undefined ? "pinned" : "typed"),
    date: field(date, dateSource),
    account: toField(accounts.account),
    toAccount: isTransfer
      ? toField(accounts.toAccount)
      : field<QuickAddAccountRef>(null, "none"),
    payee: input.payee.field,
    category: category.field,
    memo: input.payee.memo,
    blockers,
    balance,
  };
}
