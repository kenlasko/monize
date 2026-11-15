import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { repriceSettledLoanTemplates } from "../loan-installments/reprice-template";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SecurityPriceService } from "../securities/security-price.service";
import { SecuritiesService } from "../securities/securities.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { ExchangeRateHistoryService } from "../currencies/exchange-rate-history.service";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { moneyDecimalsFor, roundMoney } from "../common/round.util";
import { LEDGER_MOVEMENT_PREDICATE } from "../common/ledger-balance.sql";
import { todayYMD } from "../common/date-utils";
import { investmentEffectStatusSql } from "../securities/investment-row-effects.util";

/**
 * How many bounded gap fills one import spends on each currency. A fill asks
 * for at most `MAX_GAP_WINDOWS` windows of up to a year, so this reaches back
 * about half a century; whatever is left is the Currencies page's button.
 */
export const IMPORT_RATE_FILL_MAX_ROUNDS = 6;

/**
 * The work every import pipeline does once its rows are written: recompute
 * balances, backfill prices and FX rates, and kick a net-worth recalculation.
 *
 * Extracted verbatim from `ImportService.postImportProcessing` so the QIF/OFX/CSV
 * path and the `.mny` path share one implementation. Two copies of this would
 * drift, and the balance query in particular is load-bearing: the `.mny`
 * verification report compares the file's own computed balances against what this
 * query produces, so a second, subtly different definition of "balance" would
 * make every import look like it had discrepancies.
 *
 * Every step is individually guarded. Backfills reach external price and FX
 * providers, and an import that wrote its rows correctly must not be reported as
 * failed because a quote provider was down.
 */
@Injectable()
export class ImportPostProcessingService {
  private readonly logger = new Logger(ImportPostProcessingService.name);

  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    @Inject(forwardRef(() => SecurityPriceService))
    private securityPriceService: SecurityPriceService,
    @Inject(forwardRef(() => ExchangeRateService))
    private exchangeRateService: ExchangeRateService,
    @Inject(forwardRef(() => SecuritiesService))
    private securitiesService: SecuritiesService,
    @Inject(forwardRef(() => ExchangeRateHistoryService))
    private rateHistory: ExchangeRateHistoryService,
  ) {}

  async run(
    userId: string,
    isInvestment: boolean,
    affectedAccountIds: Set<string>,
    settledScheduleIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    // Recalculate current_balance for all affected accounts so that
    // future-dated transactions are excluded. During import,
    // updateAccountBalance() adds every transaction amount regardless
    // of date, which inflates the balance when future transactions exist.
    // "Future-dated" is decided by the user's own day (todayYMD), not the
    // database server's CURRENT_DATE, matching AccountsService.recalculateCurrentBalance
    // and every create/edit/delete (issue #2070).
    // Compute every affected account's balance in one grouped query and write
    // them back in one bulk UPDATE rather than 3 queries per account.
    const affectedIds = [...affectedAccountIds];
    if (affectedIds.length > 0) {
      try {
        // Read the balances and write them back in one transaction, holding the
        // account rows from before the read.
        //
        // One transaction was not enough on its own: under READ COMMITTED the
        // SELECT and the UPDATE take separate statement snapshots, so an
        // interactive transaction that committed in between was overwritten by
        // an absolute total that never saw it (audit P4-005). The lock is what
        // makes "must not be applied on top of rows that changed" true rather
        // than intended -- see the protocol note in common/db/locks.ts.
        await withScopedDb(this.dataSource, async (manager) => {
          // Owner-scoped: every imported account belongs to the importing user,
          // so the balance-write lock carries their id and can never land on an
          // account that is not theirs (maintainer review, PR #1095).
          await lockAccountsForBalanceWrite(manager, affectedIds, userId);

          const balances: {
            account_id: string;
            balance: string;
            decimal_places?: number | string | null;
          }[] = await manager.query(
            `SELECT a.id as account_id,
                    COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) as balance,
                    c.decimal_places
               FROM accounts a
               LEFT JOIN currencies c ON c.code = a.currency_code
               LEFT JOIN transactions t ON t.account_id = a.id
                 AND ${LEDGER_MOVEMENT_PREDICATE}
                 AND t.transaction_date <= $2
              WHERE a.id = ANY($1)
              GROUP BY a.id, a.opening_balance, c.decimal_places`,
            [affectedIds, todayYMD()],
          );

          if (balances.length > 0) {
            const valuesClause = balances
              .map((_, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::numeric)`)
              .join(", ");
            const params = balances.flatMap((row) => [
              row.account_id,
              // Each account's balance is in its own currency, so it rounds at
              // that currency's money precision (a coin keeps its eight places).
              roundMoney(
                Number(row.balance),
                moneyDecimalsFor(
                  row.decimal_places == null
                    ? undefined
                    : Number(row.decimal_places),
                ),
              ),
            ]);
            await manager.query(
              `UPDATE accounts SET current_balance = v.balance
               FROM (VALUES ${valuesClause}) AS v(id, balance)
               WHERE accounts.id = v.id`,
              params,
            );
          }
        });
      } catch (err) {
        // Not a `warn` like the backfills below it. Those reach an external
        // price or FX provider, so a failure is somebody else's outage and the
        // imported rows are still correct. This step is pure database work, and
        // the balances the writers left behind are wrong until it runs: the
        // `.mny` writer sets each account's balance absolutely from the file's
        // own figure (`writeAccountBalances`), which counts future-dated rows
        // this query deliberately excludes. A failure here leaves every affected
        // account showing a balance that disagrees with its own ledger, so it is
        // an error an operator has to see -- with the account ids, because
        // repairing it means recalculating exactly those.
        this.logger.error(
          `Post-import balance recalculation failed for account(s) ${affectedIds.join(", ")}: ${err.message}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    if (isInvestment) {
      try {
        this.logger.log("Post-import: backfilling historical security prices");
        await this.securityPriceService.backfillHistoricalPrices();
        this.logger.log("Post-import: historical price backfill complete");
      } catch (err) {
        this.logger.warn(
          `Post-import historical price backfill failed: ${err.message}`,
        );
      }

      try {
        this.logger.log("Post-import: backfilling transaction-derived prices");
        await this.securityPriceService.backfillTransactionPrices();
        this.logger.log("Post-import: transaction price backfill complete");
      } catch (err) {
        this.logger.warn(
          `Post-import transaction price backfill failed: ${err.message}`,
        );
      }

      // The imported trades changed the lots of any bond-linked security they
      // touch, so its engine prices are recomputed (after the transaction-derived
      // backfill: the engine's row wins its days either way). Logged, not thrown.
      try {
        await this.securitiesService.recomputeBondPricesOfAccounts(
          userId,
          Array.from(affectedAccountIds),
        );
      } catch (err) {
        this.logger.warn(
          `Post-import bond price recompute failed: ${err.message}`,
        );
      }
    }

    try {
      this.logger.log("Post-import: backfilling historical exchange rates");
      await this.exchangeRateService.backfillHistoricalRates(
        userId,
        Array.from(affectedAccountIds),
      );
      this.logger.log("Post-import: historical rate backfill complete");
    } catch (err) {
      this.logger.warn(
        `Post-import historical rate backfill failed: ${err.message}`,
      );
    }

    this.recalculateNetWorth(userId, affectedAccountIds);

    // The backfill above fetches a pair's history only while the pair holds no
    // row at all, so a currency whose today's rate is already stored (it was
    // added, or an account opened in it, before the import) never got the
    // years the imported rows reach back to (issue #2186). The gap fill plans
    // exactly those, against the user's own first use of the currency. In the
    // background: each fill may spend `GAP_FILL_BUDGET_MS` on the provider,
    // and the import has already written its rows.
    this.fillRateHistory(userId, affectedIds)
      .then((stored) => {
        // A brokerage snapshot converts its securities at the stored rates.
        if (stored > 0) this.recalculateNetWorth(userId, affectedAccountIds);
      })
      .catch((err) =>
        this.logger.warn(
          `Post-import rate history fill failed: ${err.message}`,
        ),
      );

    // A settlement rule claimed a scheduled occurrence during the import: the
    // schedule's next installment is priced on the ledger the import left,
    // in its own transaction after the commit (INV-CACHE-001).
    await repriceSettledLoanTemplates(this.dataSource, settledScheduleIds);
  }

  private recalculateNetWorth(
    userId: string,
    accountIds: ReadonlySet<string>,
  ): void {
    for (const accountId of accountIds) {
      this.netWorthService
        .recalculateAccount(userId, accountId)
        .catch((err) =>
          this.logger.warn(
            `Post-import net worth recalc failed for account ${accountId}: ${err.message}`,
          ),
        );
    }
  }

  /**
   * Fill the stored rate history of every foreign currency the imported
   * accounts use -- the accounts' own and their securities' -- against the
   * user's reporting currency, over the span their data uses it. The same fill
   * the Currencies page's button runs, repeated while it reports windows left
   * and the last round got an answer. Returns how many rates were stored.
   *
   * A currency no provider carries (a custom code, a coin without a price
   * symbol) or a provider that did not answer is logged and skipped: the
   * import's rows are correct either way, and the page still offers the fill.
   */
  private async fillRateHistory(
    userId: string,
    accountIds: readonly string[],
  ): Promise<number> {
    if (accountIds.length === 0) return 0;
    const reporting = await resolveUserDefaultCurrency(this.dataSource, userId);
    // Rows as EFFECTS: renders `it.status != 'VOID'`, because a void trade
    // records something that did not happen and puts no currency in use.
    const rows: Array<{ code: string }> = await withScopedDb(
      this.dataSource,
      (manager) =>
        manager.query(
          `SELECT DISTINCT code FROM (
             SELECT a.currency_code AS code
               FROM accounts a
              WHERE a.id = ANY($1::UUID[]) AND a.user_id = $2
             UNION
             SELECT s.currency_code AS code
               FROM investment_transactions it
               JOIN securities s ON s.id = it.security_id
              WHERE it.account_id = ANY($1::UUID[]) AND it.user_id = $2
                AND ${investmentEffectStatusSql("it")}
           ) used
           WHERE code IS NOT NULL AND code <> $3
           ORDER BY code`,
          [accountIds, userId, reporting],
        ),
    );

    let stored = 0;
    for (const { code } of rows) {
      for (let round = 0; round < IMPORT_RATE_FILL_MAX_ROUNDS; round++) {
        try {
          const fill = await this.rateHistory.fillRateGaps(userId, code);
          stored += fill.stored;
          const answered = fill.windowsFetched - fill.windowsUnanswered;
          if (fill.windowsRemaining === 0 || answered === 0) break;
        } catch (err) {
          this.logger.warn(
            `Post-import rate history fill for ${code}->${reporting} stopped: ${err.message}`,
          );
          break;
        }
      }
    }
    return stored;
  }
}
