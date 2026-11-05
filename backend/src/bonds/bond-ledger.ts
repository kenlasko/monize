import { NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { tr } from "../i18n/translate";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";
import {
  baseInvestmentAction,
  INVESTMENT_REPLAY_ORDER_SQL,
} from "../securities/investment-replay.util";
import { ExactDecimal } from "./domain/exact-decimal";
import { BondLotTransaction } from "./bond-lots";
import {
  infersSeriesFromDate,
  inferSeriesForDate,
  seriesRoleOf,
} from "./bond-series-resolver";

/** A linked security and its investment transactions, in register order. */
export interface BondLedger {
  readonly security: {
    readonly id: string;
    readonly userId: string;
    readonly symbol: string;
    readonly currencyCode: string;
    /** The bond program the security is linked to. */
    readonly bondProgramId: string;
    /** Fetch every new series of the program automatically (spec 2.5). */
    readonly bondAutoFetch: boolean;
  };
  readonly transactions: readonly BondLotTransaction[];
}

interface LedgerRow {
  id: string;
  action: string;
  status: string;
  tx_date: string;
  quantity: string | null;
  /** The row's total amount as exact text (NUMERIC(20,4)). */
  total_amount: string | null;
  account_id: string;
  /** The account of the other leg when this row is a paired transfer leg. */
  counterpart_account_id: string | null;
  /** The series the row stores; null for a removal that names none and for a legacy row. */
  bond_instrument_id: string | null;
}

/** The security a bond ledger belongs to, as `loadBondLedger` returns it. */
export type BondLedgerSecurity = BondLedger["security"];

/**
 * The user's security and its bond program. Ownership is in the predicate
 * (`user_id` from the JWT, never the request), because `RLS_MODE` defaults to
 * `off`; under enforcement RLS returns the same zero rows. Another user's
 * security, a missing one and an unlinked one are all the same 404: the caller
 * learns nothing about which.
 */
export async function loadLinkedSecurity(
  m: EntityManager,
  userId: string,
  securityId: string,
): Promise<BondLedgerSecurity> {
  const securities: Array<{
    id: string;
    user_id: string;
    symbol: string;
    currency_code: string;
    bond_program_id: string | null;
    bond_auto_fetch: boolean;
  }> = await m.query(
    `SELECT id, user_id, symbol, currency_code, bond_program_id, bond_auto_fetch
       FROM securities
      WHERE id = $1 AND user_id = $2`,
    [securityId, userId],
  );
  const security = securities[0];
  if (!security || security.bond_program_id === null) {
    throw new NotFoundException(
      tr(
        "errors.bonds.securityNotLinked",
        `Security ${securityId} not found or not linked to a bond program`,
        { securityId },
      ),
    );
  }
  return {
    id: security.id,
    userId: security.user_id,
    symbol: security.symbol,
    currencyCode: security.currency_code,
    bondProgramId: security.bond_program_id,
    bondAutoFetch: security.bond_auto_fetch,
  };
}

/**
 * Load the security and its ledger on the caller's transaction.
 *
 * Ownership is in the predicate (`user_id` from the JWT, never the request),
 * because `RLS_MODE` defaults to `off`; under enforcement RLS returns the same
 * zero rows. Another user's security, a missing one and an unlinked one are
 * all the same 404: the caller learns nothing about which.
 *
 * A reader of effects: VOID rows recorded nothing and are not read (the lot
 * derivation excludes them too, for a caller that passes raw rows). The
 * transactions are read across every account, each with its `account_id`, in
 * `INVESTMENT_REPLAY_ORDER_SQL` (the order every ledger replay uses), with
 * `quantity` as text so the lot derivation can read it exactly. A transfer leg
 * is `pairedTransfer` when the other leg of the same security is linked to it
 * and is not VOID (the link is stored on one or both legs); it then names the
 * other leg's account, which is where the lots it moves arrive.
 */
export async function loadBondLedger(
  m: EntityManager,
  userId: string,
  securityId: string,
): Promise<BondLedger> {
  const security = await loadLinkedSecurity(m, userId, securityId);

  const rows: LedgerRow[] = await m.query(
    `SELECT t.id,
            t.action::text AS action,
            t.status,
            TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
            t.quantity::text AS quantity,
            t.total_amount::text AS total_amount,
            t.account_id,
            t.bond_instrument_id,
            (SELECT p.account_id FROM investment_transactions p
              WHERE p.user_id = t.user_id
                AND p.security_id = t.security_id
                AND p.status != 'VOID'
                AND p.action IN ('TRANSFER_IN', 'TRANSFER_OUT')
                AND p.action <> t.action
                AND (p.id = t.linked_transaction_id OR p.linked_transaction_id = t.id)
              ORDER BY p.id
              LIMIT 1) AS counterpart_account_id
       FROM investment_transactions t
      WHERE t.security_id = $1 AND t.user_id = $2
        AND t.status != 'VOID'
      ORDER BY ${INVESTMENT_REPLAY_ORDER_SQL}`,
    [securityId, userId],
  );

  // A BUY or REINVEST that has no stored series (a legacy row, written before
  // the link, or an import) is read as a write would have resolved it: the
  // program's series on sale on its purchase date. One that cannot be
  // determined stays null, which the lot derivation refuses
  // (SERIES_NOT_DETERMINED) rather than guessing. ADD_SHARES and an unpaired
  // TRANSFER_IN have no purchase date of their own, so they are never inferred:
  // a row of those without a series is refused the same way (INV-BOND-007).
  const inferred = new Map<string, string | null>();
  for (const r of rows) {
    const paired = r.counterpart_account_id !== null;
    if (
      r.bond_instrument_id === null &&
      seriesRoleOf(r.action, paired) === "acquisition" &&
      infersSeriesFromDate(r.action) &&
      !inferred.has(r.tx_date)
    ) {
      inferred.set(
        r.tx_date,
        await inferSeriesForDate(m, security.bondProgramId, r.tx_date),
      );
    }
  }

  return {
    security,
    transactions: rows.map((r) => ({
      id: r.id,
      action: r.action,
      status: r.status,
      transactionDate: r.tx_date,
      quantity: r.quantity,
      cost: acquisitionCostText(r),
      pairedTransfer: r.counterpart_account_id !== null,
      accountId: r.account_id,
      counterpartAccountId: r.counterpart_account_id,
      instrumentId:
        r.bond_instrument_id ??
        (seriesRoleOf(r.action, r.counterpart_account_id !== null) ===
          "acquisition" && infersSeriesFromDate(r.action)
          ? (inferred.get(r.tx_date) ?? null)
          : null),
    })),
  };
}

/**
 * What an acquisition cost, as exact text: the row's total amount. Only a
 * purchase has a cost of its own (an ADD_SHARES or a transfer records no
 * price); a total that is missing, not a decimal or not above zero is unknown
 * (`null`), never a guess. No accrued interest is taken out: a BUY or REINVEST
 * cannot carry any (`ACCRUED_INTEREST_ACTIONS` holds only REDEEM), so the cash
 * paid, interest bought included, is the cost until the purchase accrued-interest
 * feature exists (bond primitives spec section 6.2). Exact decimals, not
 * `acquisitionCost` (which is a JavaScript number).
 */
export function acquisitionCostText(
  row: Pick<LedgerRow, "action" | "total_amount">,
): string | null {
  const base = baseInvestmentAction(row.action);
  if (base !== InvestmentAction.BUY && base !== InvestmentAction.REINVEST) {
    return null;
  }
  if (row.total_amount === null) return null;
  try {
    const cost = ExactDecimal.parse(row.total_amount);
    return cost.cmp(ExactDecimal.ZERO) > 0 ? cost.toFixed(4) : null;
  } catch {
    return null;
  }
}
