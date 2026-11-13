/**
 * Where a read's transfer legs sit, for {@link transferRateSql}: the
 * transaction row's alias, and the split line's when the read's rows are a
 * split's transfer lines rather than whole rows.
 */
export interface TransferLegAliases {
  transactionAlias: string;
  splitAlias?: string;
}

/**
 * What a read's rows are, when they can be transfer legs: whole rows, or the
 * transfer lines of the split aliased `splitAlias`.
 */
export type TransferLegs = "rows" | { splitAlias: string };

/** {@link TransferLegAliases} of a read on `transactionAlias`. */
export function transferLegAliases(
  transactionAlias: string,
  legs: TransferLegs,
): TransferLegAliases {
  return legs === "rows"
    ? { transactionAlias }
    : { transactionAlias, splitAlias: legs.splitAlias };
}

/**
 * The rate a transfer leg's own two posted amounts imply into the reporting
 * currency, in leg-currency units per reporting unit (the `own_rate` shape),
 * or NULL when they do not establish one. The SQL form of
 * `reports/transfer-counterpart.ts`, which the custom report engine applies to
 * the entities it loads (discussion #2139, issue #2153).
 *
 * A transfer of 100 USD that arrived as 90 EUR converts at 90 EUR per 100 USD
 * whichever leg a report reads: the outgoing leg's stored rate is 1 and the
 * incoming leg's rate only reaches the source currency, so neither carries an
 * own rate, and the market rate on the day answered a different figure than
 * the one that moved (INV-FX-002). The posted amounts are the fact, so they win
 * over a stored rate.
 *
 * The other side is read by id, whether or not the read's own filters keep it,
 * and only on the reader's ledger (`user_id` of the leg's own row), so a
 * cross-owner counterpart answers nothing and its leg keeps the market rate.
 * Three shapes (`docs/financial-semantics.md` section 2):
 *
 * - a plain leg links to its mirror leg, which links back;
 * - the counterpart row of a split's transfer line links to the split parent,
 *   and its other side is the parent's line linking back to it, never the
 *   parent's whole amount;
 * - a split's transfer line (`splitAlias`) links to its counterpart row, whose
 *   own link points at the split parent.
 *
 * Only a leg outside the reporting currency whose other side posted in it
 * answers, and only for two non-zero amounts of opposite signs, so a link that
 * is not a transfer's two sides falls back to the market rate. Unlike a stored
 * rate, a ratio of exactly 1 is a real rate here: the transfer moved at par.
 * The aliases are quoted, so a query builder leaves the columns alone.
 */
export function transferRateSql(
  currencyParam: string,
  { transactionAlias, splitAlias }: TransferLegAliases,
): string {
  const t = `"${transactionAlias}"`;
  if (splitAlias) {
    const s = `"${splitAlias}"`;
    return `CASE
          WHEN ${s}.transfer_account_id IS NOT NULL
           AND ${s}.amount <> 0
           AND ${t}.currency_code <> ${currencyParam}
          THEN (
            SELECT ABS(${s}.amount) / ABS(fx_cp.amount)
              FROM transactions fx_cp
             WHERE fx_cp.id = ${s}.linked_transaction_id
               AND fx_cp.user_id = ${t}.user_id
               AND fx_cp.linked_transaction_id = ${t}.id
               AND fx_cp.currency_code = ${currencyParam}
               AND fx_cp.amount <> 0
               AND SIGN(fx_cp.amount) <> SIGN(${s}.amount)
          )
        END`;
  }
  return `CASE
          WHEN ${t}.is_transfer
           AND ${t}.is_split IS NOT TRUE
           AND ${t}.amount <> 0
           AND ${t}.currency_code <> ${currencyParam}
          THEN (
            SELECT ABS(${t}.amount) / ABS(fx_cp.amount)
              FROM (
                SELECT fx_leg.amount, fx_leg.currency_code
                  FROM transactions fx_leg
                 WHERE fx_leg.id = ${t}.linked_transaction_id
                   AND fx_leg.user_id = ${t}.user_id
                   AND fx_leg.is_split IS NOT TRUE
                   AND fx_leg.linked_transaction_id = ${t}.id
                UNION ALL
                SELECT fx_line.amount, fx_leg.currency_code
                  FROM transactions fx_leg
                  JOIN transaction_splits fx_line
                    ON fx_line.transaction_id = fx_leg.id
                 WHERE fx_leg.id = ${t}.linked_transaction_id
                   AND fx_leg.user_id = ${t}.user_id
                   AND fx_leg.is_split IS TRUE
                   AND fx_line.linked_transaction_id = ${t}.id
                   AND fx_line.transfer_account_id IS NOT NULL
              ) fx_cp
             WHERE fx_cp.currency_code = ${currencyParam}
               AND fx_cp.amount <> 0
               AND SIGN(fx_cp.amount) <> SIGN(${t}.amount)
             LIMIT 1
          )
        END`;
}
