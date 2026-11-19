import {
  investmentExclusionSql,
  reportableTransactionAmountSql,
} from "../common/investment-filter.util";

/**
 * The ordinary cash the parent row represents. A payee total reads only the
 * parent, so a split's embedded investment or transfer line has to come out of
 * the amount rather than out of the row (branch audit F-RPT-001). Alias `t`.
 */
export const PURCHASE_AMOUNT_SQL = reportableTransactionAmountSql("t");

/**
 * What a purchase is, written once (INV-REPORT-001): a parent row whose
 * reportable amount is an outflow, not a transfer, not VOID, outside the
 * investment machinery and not the booking of an asset account's category.
 * Aliases `t` (transactions) and `a` (accounts, joined on `t.account_id`);
 * no bound parameters. Spending by Payee and the trivia row reads share it.
 */
export const PURCHASE_ROW_CONDITIONS_SQL = `${PURCHASE_AMOUNT_SQL} < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${investmentExclusionSql({
          accountAlias: "a",
          transactionAlias: "t",
        })}
        AND NOT EXISTS (
          SELECT 1 FROM accounts ax
          WHERE ax.user_id = t.user_id
            AND ax.asset_category_id IS NOT NULL
            AND ax.asset_category_id = t.category_id
        )`;
