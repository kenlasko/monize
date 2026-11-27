/**
 * Filling what the text did not give (`docs/future-plans/quick-add.md`,
 * "Filling what was not typed"), as a pure function of what the reader read
 * and what `QuickAddInterpretService` loaded. A pinned field always wins and
 * is never re-read from the text.
 *
 * - kind: pinned; else a typed transfer; else transfer when two accounts
 *   were named, or one with a direction the typed payment or deposit (if
 *   any) does not own (`accountsImplyTransfer`); else the typed payment or
 *   deposit; else deposit for an income category or a payee whose last 10
 *   rows are mostly deposits (inferred); otherwise payment (default).
 * - account and toAccount: `quick-add-fill-accounts.util.ts` (the payee's
 *   most frequent recent account, the most recent winning a tie).
 * - category (not for a transfer): pinned; else, cleared by the reader, the
 *   payee's default category when it has one (default: the save adopts it),
 *   otherwise none; else the payee's most frequent category over its last 10
 *   unsplit rows, the most recent winning a tie; otherwise its default
 *   category (inferred).
 * - date: today (default).
 *
 * Then the blockers, and the balance line under the predicate
 * `TransactionsService.create` decides the balance with.
 */
import { isIncomeCategory } from "../../categories/category-type.util";
import { decimalPlacesOf } from "../../common/amount-precision.util";
import { moneyDecimalsForCode } from "../../common/currency-places.util";
import { MONEY_SCALE, roundMoney } from "../../common/round.util";
import { TRANSACTION_AMOUNT_MAX_MAGNITUDE } from "../dto/create-transaction.dto";
import type { TypedCurrency } from "./quick-add-amount.util";
import {
  QUICK_ADD_KINDS,
  QuickAddAccountRef,
  QuickAddBalance,
  QuickAddBlocker,
  QuickAddCandidateAccount,
  QuickAddCandidateCategory,
  QuickAddCategoryRef,
  QuickAddField,
  QuickAddForeignAmount,
  QuickAddInterpretation,
  QuickAddKind,
  QuickAddSource,
} from "./quick-add.types";
import {
  QuickAddFillInput,
  categoryRef,
  clearedField,
  field,
  rankByRecentFrequency,
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
  "amountTooLarge",
  "foreignCurrency",
]);

/**
 * The places an amount in `code` is entered at: its `currencies.decimal_places`
 * (the column default, 2, for a code the map does not hold), the places the
 * full form's `CurrencyInput` rounds to, never more than the column scale. A
 * typed value with more would carry units no form can show.
 */
function entryDecimalsFor(
  places: ReadonlyMap<string, number>,
  code: string,
): number {
  return Math.min(MONEY_SCALE, places.get(code.toUpperCase()) ?? 2);
}

/** The payee's most frequent recent category, the most recent winning a tie. */
function historyCategories(
  input: QuickAddFillInput,
): QuickAddCandidateCategory[] {
  return rankByRecentFrequency(input.history.categoryIds, (id) =>
    input.categories.has(id),
  ).map((id) => input.categories.get(id)!);
}

/** The linked payee's default category, when the reader owns it. */
function payeeDefaultCategory(
  input: QuickAddFillInput,
): QuickAddCandidateCategory | null {
  const defaultId = input.payee.payee?.defaultCategoryId ?? null;
  return defaultId ? (input.categories.get(defaultId) ?? null) : null;
}

interface CategoryResolution {
  field: QuickAddField<QuickAddCategoryRef>;
  category: QuickAddCandidateCategory | null;
}

/**
 * A category the reader cleared. The save sends none, and `create()` then
 * adopts the linked payee's default category, so that default is the answer
 * (`default`): the chip shows what the save will write. Without a linked
 * payee or a default it is none, as a pin. Never read again from the text or
 * the payee's history.
 */
function clearedCategory(input: QuickAddFillInput): CategoryResolution {
  const adopted = payeeDefaultCategory(input);
  return adopted
    ? { field: field(categoryRef(adopted), "default"), category: adopted }
    : { field: clearedField<QuickAddCategoryRef>(), category: null };
}

function resolveCategory(input: QuickAddFillInput): CategoryResolution {
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
  if (pins.clearCategory) return clearedCategory(input);
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
  const defaultCategory = payeeDefaultCategory(input);
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

/**
 * The kind the text and the pins decide before any history is read: pinned;
 * else a typed transfer; else a transfer the named accounts' directions make
 * (a typed payment or deposit never outranks them); else the typed kind. Null
 * leaves it to the category and the payee's history.
 */
function statedKind(
  input: QuickAddFillInput,
): { value: QuickAddKind; source: QuickAddSource } | null {
  const { reading, pins } = input;
  if (pins.kind) return { value: pins.kind, source: "pinned" };
  if (reading.kind === "transfer")
    return { value: "transfer", source: "typed" };
  if (accountsImplyTransfer(reading.accounts, reading.kind)) {
    return { value: "transfer", source: "inferred" };
  }
  return reading.kind ? { value: reading.kind, source: "typed" } : null;
}

/**
 * The figure as typed in a currency: one that is not the account's (where
 * `foreignCurrency` blocks), or any currency while no account is known to
 * compare it with, so the reader's currency is not lost before one is chosen.
 * Null when the typed currency is the account's, or none was typed.
 */
function foreignAmountOf(
  typed: TypedCurrency | null,
  amount: number | null,
  account: QuickAddCandidateAccount | null,
): QuickAddForeignAmount | null {
  if (!typed || amount === null) return null;
  if (account && typed.codes.includes(account.currencyCode.toUpperCase())) {
    return null;
  }
  return {
    currencyCode: typed.codes.length === 1 ? typed.codes[0] : null,
    amount,
  };
}

function blockersFor(facts: {
  amount: number | null;
  exceedsPrecision: boolean;
  tooLarge: boolean;
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
  else if (facts.tooLarge) blockers.push("amountTooLarge");
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
  const stated = statedKind(input);
  const isTransfer = stated?.value === "transfer";
  const category = isTransfer
    ? { field: field<QuickAddCategoryRef>(null, "none"), category: null }
    : resolveCategory(input);

  const recent = input.history.recent;
  const mostlyDeposits =
    recent.length > 0 &&
    recent.filter((row) => row.amount > 0).length > recent.length / 2;
  const kind = stated
    ? kindField(stated.value, stated.source)
    : (category.category && isIncomeCategory(category.category)) ||
        mostlyDeposits
      ? kindField("deposit", "inferred")
      : kindField("payment", "default");
  const kindValue = kind.value ?? "payment";

  const accounts = resolveAccounts(input, kindValue);
  const account = accounts.account.account;
  const toAccount = isTransfer ? accounts.toAccount.account : null;

  const rawAmount = pins.amount ?? reading.amount?.value ?? null;
  // A pinned amount was set in the account's currency on the chip.
  const typedCurrency =
    pins.amount === undefined ? (reading.amount?.currency ?? null) : null;
  const foreignAmount = foreignAmountOf(typedCurrency, rawAmount, account);
  const tooLarge =
    rawAmount !== null &&
    (!Number.isFinite(rawAmount) ||
      rawAmount > TRANSACTION_AMOUNT_MAX_MAGNITUDE);
  // A foreign figure is not in the account's currency: its places are the
  // full form's to check, once it is converted there.
  const entryPlaces =
    account && !foreignAmount
      ? entryDecimalsFor(input.currencyPlaces, account.currencyCode)
      : null;
  const placesTyped =
    pins.amount === undefined && reading.amount
      ? Math.max(reading.amount.places, decimalPlacesOf(reading.amount.value))
      : rawAmount === null
        ? 0
        : decimalPlacesOf(rawAmount);
  const exceedsPrecision =
    rawAmount !== null &&
    entryPlaces !== null &&
    !tooLarge &&
    placesTyped > entryPlaces;
  const amount =
    rawAmount === null || entryPlaces === null || exceedsPrecision || tooLarge
      ? rawAmount
      : roundMoney(rawAmount, entryPlaces);

  const date = pins.date ?? reading.date ?? input.today;
  const dateSource: QuickAddSource = pins.date
    ? "pinned"
    : reading.date
      ? "typed"
      : "default";

  const blockers = blockersFor({
    amount,
    exceedsPrecision,
    tooLarge,
    account,
    toAccount,
    ambiguousAccount:
      accounts.account.ambiguous ||
      (isTransfer && accounts.toAccount.ambiguous),
    isTransfer,
    // Without an account there is nothing to call the figure foreign to:
    // `missingAccount` blocks, and the figure is kept in `foreignAmount`.
    foreignCurrency: account !== null && foreignAmount !== null,
  });

  const balance =
    account && amount !== null && !blockers.some((b) => AMOUNT_BLOCKERS.has(b))
      ? balanceLine(account, kindValue === "deposit" ? amount : -amount, {
          date,
          places: moneyDecimalsForCode(
            input.currencyPlaces,
            account.currencyCode,
          ),
          isFuture: input.isFuture,
        })
      : null;

  return {
    kind,
    // A figure JSON cannot carry (1e309 is Infinity) is no amount to show;
    // `amountTooLarge` still says why Save is refused.
    amount: field(
      amount !== null && Number.isFinite(amount) ? amount : null,
      pins.amount !== undefined ? "pinned" : "typed",
    ),
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
    foreignAmount,
  };
}
