import { getRequestContext } from "../common/request-context";

/**
 * How a read's transfer legs reach {@link transferRateSql}: the placeholder
 * bound to the reading person's own user id, and the split line's alias when
 * the read's rows are a split's transfer lines rather than whole rows.
 */
export interface TransferLegs {
  readerParam: string;
  splitAlias?: string;
}

/**
 * The person reading: the authenticated identity, a delegate's own id while
 * acting, or `undefined` outside a user context. A transfer's other side is
 * read only on this person's own legs ({@link transferRateSql}).
 */
export function transferRateReader(): string | undefined {
  const ctx = getRequestContext();
  if (!ctx || ctx.system) return undefined;
  return ctx.realUserId ?? ctx.userId;
}

/**
 * {@link TransferLegs} for a raw read whose `readerParam` is bound to
 * `userId`, the ledger it reads: only when that is the reader's own, so a read
 * on somebody else's ledger keeps the market rate.
 */
export function ownTransferLegs(
  userId: string,
  readerParam: string,
  splitAlias?: string,
): TransferLegs | undefined {
  if (transferRateReader() !== userId) return undefined;
  return splitAlias ? { readerParam, splitAlias } : { readerParam };
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
 * The other side is read by id, whether or not the read's own filters keep
 * it. Only a leg of the reader's own (`readerParam`) answers, and only from a
 * counterpart on the same ledger, so neither a cross-owner counterpart nor a
 * delegate's or a joint account's view of somebody else's ledger reads a
 * figure off an account the reader may not see; those legs keep the market
 * rate. Three shapes (`docs/financial-semantics.md` section 2):
 *
 * - a plain leg links to its mirror leg, which links back;
 * - the counterpart row of a split's transfer line links to the split parent,
 *   and its other side is the parent's line linking back to it, never the
 *   parent's whole amount;
 * - a split's transfer line (`splitAlias`) links to its counterpart row, whose
 *   own link points at the split parent.
 *
 * Only a leg outside the reporting currency whose other side posted in it
 * answers, and only for exactly one other side, non-zero and of the opposite
 * sign, so a link that is not a transfer's two sides falls back to the market
 * rate. Unlike a stored rate, a ratio of exactly 1 is a real rate here: the
 * transfer moved at par. The aliases are quoted, so a query builder leaves the
 * columns alone.
 */
export function transferRateSql(
  currencyParam: string,
  transactionAlias: string,
  { readerParam, splitAlias }: TransferLegs,
): string {
  const t = `"${transactionAlias}"`;
  if (splitAlias) {
    const s = `"${splitAlias}"`;
    return `CASE
          WHEN ${s}.transfer_account_id IS NOT NULL
           AND ${s}.amount <> 0
           AND ${t}.user_id = ${readerParam}
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
           AND ${t}.user_id = ${readerParam}
           AND ${t}.currency_code <> ${currencyParam}
          THEN (
            SELECT CASE
                     WHEN COUNT(*) = 1
                     THEN ABS(${t}.amount) / ABS(MIN(fx_cp.amount))
                   END
              FROM (
                SELECT CASE
                         WHEN fx_leg.is_split IS TRUE THEN fx_line.amount
                         ELSE fx_leg.amount
                       END AS amount
                  FROM transactions fx_leg
                  LEFT JOIN transaction_splits fx_line
                    ON fx_leg.is_split IS TRUE
                   AND fx_line.transaction_id = fx_leg.id
                   AND fx_line.linked_transaction_id = ${t}.id
                   AND fx_line.transfer_account_id IS NOT NULL
                 WHERE fx_leg.id = ${t}.linked_transaction_id
                   AND fx_leg.user_id = ${t}.user_id
                   AND fx_leg.currency_code = ${currencyParam}
                   AND (fx_leg.is_split IS TRUE
                        OR fx_leg.linked_transaction_id = ${t}.id)
              ) fx_cp
             WHERE fx_cp.amount <> 0
               AND SIGN(fx_cp.amount) <> SIGN(${t}.amount)
          )
        END`;
}
