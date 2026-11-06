import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { repriceSettledLoanTemplates } from "../loan-installments/reprice-template";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SecurityPriceService } from "../securities/security-price.service";
import { SecuritiesService } from "../securities/securities.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { moneyDecimalsFor, roundMoney } from "../common/round.util";
import { LEDGER_MOVEMENT_PREDICATE } from "../common/ledger-balance.sql";

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
                 AND t.transaction_date <= CURRENT_DATE
              WHERE a.id = ANY($1)
              GROUP BY a.id, a.opening_balance, c.decimal_places`,
            [affectedIds],
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

    for (const accountId of affectedAccountIds) {
      this.netWorthService
        .recalculateAccount(userId, accountId)
        .catch((err) =>
          this.logger.warn(
            `Post-import net worth recalc failed for account ${accountId}: ${err.message}`,
          ),
        );
    }

    // A settlement rule claimed a scheduled occurrence during the import: the
    // schedule's next installment is priced on the ledger the import left,
    // in its own transaction after the commit (INV-CACHE-001).
    await repriceSettledLoanTemplates(this.dataSource, settledScheduleIds);
  }
}
