import { Account } from '@/types/account';
import { isInvestmentCashHalf } from '@/lib/account-utils';

/**
 * One account as the user thinks of it.
 *
 * An investment account is stored as two rows -- an `INVESTMENT_BROKERAGE`
 * account holding the securities and a linked `INVESTMENT_CASH` account holding
 * the money -- and every surface that shows the pair as two peer entries is
 * showing plumbing. `buildLogicalAccounts` folds the pair into one entry so a
 * surface asks for "the account" and gets one thing, then reaches for the id it
 * actually needs (`cashRegisterId` to post money, `holdingsAccountId` for
 * portfolio data) instead of hopping `linkedAccountId` itself.
 *
 * Standalone investment accounts (no sub-type -- one row carrying both
 * holdings and cash) and orphans (one half of a deleted pair) are entries in
 * their own right, as is every non-investment account.
 */
export interface LogicalAccount {
  /** Canonical id: the brokerage half of a pair, otherwise the account itself. */
  id: string;
  /** The row that represents the entity. */
  primary: Account;
  /** The linked cash half. Non-null only for a folded pair. */
  cash: Account | null;
  /** Every real account id belonging to this entity (one, or two for a pair). */
  memberIds: string[];
  /** The entity's name with any " - Brokerage"/" - Cash" suffix stripped. */
  displayName: string;
  isInvestment: boolean;
  /**
   * The ledger this entity's ordinary money transactions live in: the cash half
   * of a pair, or the account itself when it keeps its own cash.
   *
   * Null for a brokerage with no linked cash account. Its ledger carries only
   * the cash rows its own trades generated, so it is not an account the user
   * posts to, reconciles, or transfers into -- which is how the app already
   * treats a brokerage in every money picker.
   */
  cashRegisterId: string | null;
  /**
   * The ledger carrying securities: the brokerage half of a pair, a standalone
   * investment account, or an orphan brokerage. Null when the entity holds no
   * securities (every non-investment account, and an orphan cash half).
   */
  holdingsAccountId: string | null;
  /**
   * What the entity is worth: market value plus cash balance for an investment
   * account, the account's own balance for everything else.
   *
   * **Null means unknown, and a caller must render it as unknown rather than
   * falling back to the part it does know** (`docs/financial-calculation-contract.md`
   * section 1). It is null when any holding has no price, and when portfolio
   * data was not supplied at all -- a failed portfolio lookup is not a
   * portfolio worth nothing.
   */
  combinedValue: number | null;
}

/**
 * Per-account portfolio figures, as the accounts page already derives them from
 * `investmentsApi.getPortfolioSummary()`. Omit the whole object when the
 * portfolio has not loaded (or failed): every investment entity's
 * `combinedValue` is then unknown rather than cash-only.
 */
export interface LogicalAccountPortfolio {
  /** Holdings account id -> market value of its priced holdings. */
  marketValues: Map<string, number>;
  /** Holdings account id -> how many of its holdings have no price. */
  unpricedCounts: Map<string, number>;
  /**
   * Holdings account ids whose valuation is incomplete for ANY cause: a missing
   * price (`unpricedHoldingsCount`) or a missing exchange rate with every price
   * present (`valuationComplete === false`). The count above cannot see the
   * second. Optional: omitted, only the count decides.
   */
  incompleteAccountIds?: ReadonlySet<string>;
}

/**
 * True when this holdings account's market value is a subtotal, by price or by
 * rate. The one predicate every surface gates a brokerage's contribution on, so
 * the row, the group total and the summary cards cannot disagree.
 */
export function holdingsValuationIncomplete(
  holdingsAccountId: string,
  unpricedCounts: ReadonlyMap<string, number> | undefined,
  incompleteAccountIds: ReadonlySet<string> | undefined,
): boolean {
  return (
    (unpricedCounts?.get(holdingsAccountId) ?? 0) > 0 ||
    incompleteAccountIds?.has(holdingsAccountId) === true
  );
}

/**
 * An account's own ledger balance.
 *
 * `ledgerBalances` is the point-in-time answer when the caller has one: the
 * Account Balances report measures every account at a date the user chose, and
 * the stored `currentBalance` is a different figure (today's) that no amount of
 * arithmetic here could turn into it. Without the map the entity falls back to
 * today's balance plus everything dated ahead of it, which is what every other
 * surface shows.
 */
export function ownBalance(
  account: Account,
  ledgerBalances?: ReadonlyMap<string, number>,
): number {
  const measured = ledgerBalances?.get(account.id);
  if (measured !== undefined) return measured;
  return (
    (Number(account.currentBalance) || 0) +
    (Number(account.futureTransactionsSum) || 0)
  );
}

/**
 * What this entity is worth, or null when some component of it is unknown.
 *
 * Cash is always known; the market value is not, so the rules below are all
 * about the securities half. An account holding nothing is worth its cash --
 * "nothing to price" is a settled answer, unlike "could not price".
 */
function combinedValueFor(
  primary: Account,
  cash: Account | null,
  holdingsAccountId: string | null,
  portfolio?: LogicalAccountPortfolio,
  ledgerBalances?: ReadonlyMap<string, number>,
): number | null {
  const cashComponent = cash
    ? ownBalance(cash, ledgerBalances)
    : ownBalance(primary, ledgerBalances);

  if (holdingsAccountId === null) return cashComponent;

  const marketValue = portfolio?.marketValues.get(holdingsAccountId);
  if (marketValue !== undefined) {
    // A priced subtotal standing in for a total is the mistake this guards.
    if (
      holdingsValuationIncomplete(
        holdingsAccountId,
        portfolio!.unpricedCounts,
        portfolio!.incompleteAccountIds,
      )
    ) {
      return null;
    }

    // A brokerage's own `currentBalance` is deliberately kept at 0, so the cash
    // component of a pair comes from the cash half and of a standalone account
    // from itself -- `cashComponent` already resolved which.
    return marketValue + cashComponent;
  }

  // Nothing reported a value for these holdings. A closed account is one the
  // app required to be emptied first, and the live portfolio deliberately does
  // not report it: that is "no holdings to value", a settled answer -- not
  // "could not value them" -- so it must not render as unknown. (Until task B1
  // lands, closing is only gated on the cash balance, so a brokerage closed
  // with positions still reads as its cash alone.)
  //
  // A source that *does* report closed accounts -- the point-in-time report,
  // which can be asked about a date before the account was emptied -- lands in
  // the branch above instead, so this fallback never overrides a real figure.
  if (primary.isClosed) return cashComponent;

  return null;
}

/**
 * Fold an account list into the accounts a user would say they have.
 *
 * A cash half is absorbed into its brokerage partner **only when that partner
 * is in the same input list**, so a filtered or partial list never silently
 * drops an account: whatever is passed in is represented.
 *
 * Entries keep the input order, taking the position of whichever member
 * appears first, so a caller's own sort survives the fold.
 *
 * @param stripName strips the localized pair-name suffix; pass
 *   `useMainAccountName()`'s function (or `getMainAccountName` directly).
 * @param ledgerBalances measured balance per account id, when the caller has
 *   asked the server for a specific date. Omit for the live view.
 */
export function buildLogicalAccounts(
  accounts: Account[],
  stripName: (name: string) => string,
  portfolio?: LogicalAccountPortfolio,
  ledgerBalances?: ReadonlyMap<string, number>,
): LogicalAccount[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));

  // A cash half is only absorbed when its partner is present; otherwise it
  // stands on its own, exactly as `countLogicalAccounts` has always counted it.
  const absorbed = new Set(
    accounts
      .filter((a) => isInvestmentCashHalf(a) && byId.has(a.linkedAccountId!))
      .map((a) => a.id),
  );

  return accounts
    .filter((a) => !absorbed.has(a.id))
    .map((primary) => {
      const cash =
        primary.linkedAccountId && absorbed.has(primary.linkedAccountId)
          ? (byId.get(primary.linkedAccountId) ?? null)
          : null;

      const isInvestment = primary.accountType === 'INVESTMENT';
      const isBrokerage = primary.accountSubType === 'INVESTMENT_BROKERAGE';
      // Securities hang off a brokerage half, an orphan brokerage, or a
      // standalone investment account -- never off a cash ledger.
      //
      // The sub-type decides on its own where it is set: an account marked
      // INVESTMENT_BROKERAGE holds securities whatever else it claims. Only a
      // standalone account, which has no sub-type to go on, is identified by
      // its type.
      const holdingsAccountId =
        isBrokerage || (isInvestment && primary.accountSubType == null)
          ? primary.id
          : null;
      // A brokerage with no cash half has no ledger the user posts money to.
      const cashRegisterId = cash
        ? cash.id
        : isBrokerage
          ? null
          : primary.id;

      return {
        id: primary.id,
        primary,
        cash,
        memberIds: cash ? [primary.id, cash.id] : [primary.id],
        displayName: stripName(primary.name),
        isInvestment,
        cashRegisterId,
        holdingsAccountId,
        combinedValue: combinedValueFor(
          primary,
          cash,
          holdingsAccountId,
          portfolio,
          ledgerBalances,
        ),
      };
    });
}

/**
 * The holdings accounts whose valuation is a subtotal: an unpriced holding, or
 * `valuationComplete === false` (a price present but no rate to convert it).
 * Read as `=== false`: an absent flag is no information, not incomplete.
 */
export function incompleteHoldingAccountIds(
  holdingsByAccount:
    | readonly {
        accountId: string;
        unpricedHoldingsCount?: number;
        valuationComplete?: boolean;
      }[]
    | null
    | undefined,
): Set<string> {
  return new Set(
    (holdingsByAccount ?? [])
      .filter((a) => a.valuationComplete === false || (a.unpricedHoldingsCount ?? 0) > 0)
      .map((a) => a.accountId),
  );
}

/**
 * Build the portfolio maps `buildLogicalAccounts` takes from a portfolio
 * summary's per-account holdings, or `undefined` when there is no summary --
 * which is the signal that market values are unknown.
 */
export function toLogicalAccountPortfolio(
  holdingsByAccount:
    | {
        accountId: string;
        totalMarketValue: number;
        unpricedHoldingsCount: number;
        valuationComplete?: boolean;
      }[]
    | null
    | undefined,
): LogicalAccountPortfolio | undefined {
  if (!holdingsByAccount) return undefined;
  return {
    marketValues: new Map(
      holdingsByAccount.map((a) => [a.accountId, a.totalMarketValue]),
    ),
    unpricedCounts: new Map(
      holdingsByAccount.map((a) => [a.accountId, a.unpricedHoldingsCount ?? 0]),
    ),
    incompleteAccountIds: incompleteHoldingAccountIds(holdingsByAccount),
  };
}

/**
 * The label every account picker uses: the entity's name, its currency, and a
 * closed marker. Matches the long-standing default in
 * `buildAccountDropdownOptions`, except that a pair reads as one account.
 */
export function formatAccountOptionLabel(
  account: Account,
  stripName: (name: string) => string,
  closedLabel = 'Closed',
  options: { withCurrency?: boolean } = {},
): string {
  const { withCurrency = true } = options;
  const currency = withCurrency ? ` (${account.currencyCode})` : '';
  return `${stripName(account.name)}${currency}${
    account.isClosed ? ` (${closedLabel})` : ''
  }`;
}
