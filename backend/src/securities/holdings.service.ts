import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { Cron } from "@nestjs/schedule";
import { todayInTimezone, formatDateYMDLocal } from "../common/date-utils";
import { sumMoney } from "../common/round.util";
import { getUsersByEffectiveTimezone } from "../common/users-by-timezone.util";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { EntityManager, In, LessThanOrEqual, DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { lockHoldingScope } from "../common/db/locks";
import {
  applyActionToQuantity,
  baseInvestmentAction,
  SHARE_MOVING_ACTIONS,
  acquisitionCost,
  isQuantityOnlyAction,
  INVESTMENT_REPLAY_ORDER,
  HOLDING_QUANTITY_EPSILON,
  orderTransferOutBeforeIn,
  projectedHoldingRow,
  basisAfterReturnOfCapital,
} from "./investment-replay.util";
import { Holding } from "./entities/holding.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { NON_VOID_INVESTMENT_STATUS } from "./investment-row-effects.util";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { AccountsService } from "../accounts/accounts.service";
import { SecuritiesService } from "./securities.service";

/**
 * One (account, security) position: the unit a holdings rebuild operates on,
 * and the unit a ledger write declares it touched.
 */
export interface HoldingScope {
  accountId: string;
  securityId: string;
}

/**
 * One position where the stored row and a replay of the ledger disagree.
 *
 * Read-only evidence: `replayedQuantity` / `replayedAverageCost` are `null`
 * when a rebuild would store no row for this position at all -- the ledger
 * accounts for no shares -- which is a different finding from "it accounts for
 * a different number". They are the row a rebuild *would* write otherwise, so a
 * short position's `replayedAverageCost` is the `0` the writers store, not an
 * average nothing computes.
 */
export interface HoldingDiscrepancy {
  accountId: string;
  securityId: string;
  storedQuantity: number;
  storedAverageCost: number | null;
  replayedQuantity: number | null;
  replayedAverageCost: number | null;
}

/**
 * What an acquiring row adds to a position's basis in the fold: the basis its
 * paired TRANSFER_OUT released when `carried` has one (A26-M22), otherwise
 * the row's own `acquisitionCost` -- `null` when the row cannot say. Prices
 * here are in the security's currency, as is `averageCost`, so the row's rate
 * is not applied.
 */
function acquiredBasis(
  tx: InvestmentTransaction,
  carried: number | undefined,
): number | null {
  return (
    carried ??
    acquisitionCost({
      quantity: tx.quantity,
      price: tx.price,
      commission: tx.commission,
      totalAmount: tx.totalAmount,
    })
  );
}

@Injectable()
export class HoldingsService {
  private readonly logger = new Logger(HoldingsService.name);

  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    private securitiesService: SecuritiesService,
    private dataSource: DataSource,
  ) {}

  /**
   * Run `fn` on the caller's transaction when one was handed in, otherwise in a
   * scoped transaction of our own. The optional-manager parameters exist
   * because the investment-transaction flows call in from inside their own
   * write block; a nested `withScopedDb` would join that transaction anyway,
   * but threading the manager keeps the repository instances identical to what
   * the caller is already using.
   */
  private inScope<T>(
    manager: EntityManager | undefined,
    fn: (m: EntityManager) => Promise<T>,
  ): Promise<T> {
    return manager ? fn(manager) : withScopedDb(this.dataSource, fn);
  }

  async findAll(userId: string, accountId?: string): Promise<Holding[]> {
    return withScopedDb(this.dataSource, (m) => {
      const query = m
        .getRepository(Holding)
        .createQueryBuilder("holding")
        .leftJoinAndSelect("holding.account", "account")
        .leftJoinAndSelect("holding.security", "security")
        .where("account.userId = :userId", { userId });

      if (accountId) {
        query.andWhere("holding.accountId = :accountId", { accountId });
      }

      return query.getMany();
    });
  }

  async findOne(userId: string, id: string): Promise<Holding> {
    const holding = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Holding)
        .createQueryBuilder("holding")
        .leftJoinAndSelect("holding.account", "account")
        .leftJoinAndSelect("holding.security", "security")
        .where("holding.id = :id", { id })
        .andWhere("account.userId = :userId", { userId })
        .getOne(),
    );

    if (!holding) {
      throw new NotFoundException(
        tr(
          "errors.securities.holdingNotFound",
          `Holding with ID ${id} not found`,
          { id },
        ),
      );
    }

    return holding;
  }

  async findByAccountAndSecurity(
    accountId: string,
    securityId: string,
    manager?: EntityManager,
  ): Promise<Holding | null> {
    const find = (m: EntityManager) =>
      m.getRepository(Holding).findOne({
        where: { accountId, securityId },
        relations: ["account", "security"],
      });
    return manager ? find(manager) : withScopedDb(this.dataSource, find);
  }

  /**
   * Compute the holding state for (account, security) as of the start of
   * `asOfDate` -- i.e. after replaying every investment transaction strictly
   * earlier than that date, optionally skipping a single transaction by id
   * (used by the SPLIT form so editing a past split shows holdings as they
   * were just before that split was applied, not the current live state).
   *
   * Returns { quantity, averageCost } even when no holding row exists yet.
   * Mirrors the action handling used by `rebuildFromTransactions` so the two
   * paths stay in sync.
   */
  async getHoldingAt(
    userId: string,
    accountId: string,
    securityId: string,
    asOfDate: string,
    excludeTransactionId?: string,
  ): Promise<{ quantity: number; averageCost: number }> {
    // Verify the user owns the account before exposing transaction history.
    await this.accountsService.findOne(userId, accountId);

    // Rows as effects: a VOID transaction moved no shares, so the replay
    // skips it (docs/specs/investment-transaction-status.md).
    const where = {
      userId,
      accountId,
      securityId,
      status: NON_VOID_INVESTMENT_STATUS,
    };

    const transactions = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        where,
        order: INVESTMENT_REPLAY_ORDER,
      }),
    );

    let qty = 0;
    let totalCost = 0;
    for (const tx of transactions) {
      if (tx.transactionDate >= asOfDate) break;
      if (excludeTransactionId && tx.id === excludeTransactionId) continue;
      const txQty = Number(tx.quantity) || 0;
      switch (baseInvestmentAction(tx.action)) {
        case InvestmentAction.BUY:
        case InvestmentAction.REINVEST: {
          // Same basis rule as the full rebuild: commission included, and an
          // unpriced acquisition adds no cost rather than being treated as free.
          // This replay feeds the SPLIT form's "holdings as they were" preview,
          // so a different average cost here than computeHoldingsMap produces
          // shows the user one number and stores another.
          const cost = acquisitionCost({
            quantity: tx.quantity,
            price: tx.price,
            commission: tx.commission,
            totalAmount: tx.totalAmount,
          });
          if (cost !== null) totalCost += cost;
          qty += txQty;
          break;
        }
        case InvestmentAction.TRANSFER_IN: {
          // A transfer is not a purchase (A26-M22). This replay reads one
          // scope, so the paired OUT leg is not in its rows; the leg's own
          // price is the carried per-share basis `transferSecurity` and the
          // transfer edit write from the source's ledger, which is what the
          // full rebuild falls back to when it cannot see the OUT leg either.
          const cost = acquisitionCost({
            quantity: tx.quantity,
            price: tx.price,
            commission: tx.commission,
            totalAmount: tx.totalAmount,
          });
          if (cost !== null) totalCost += cost;
          qty += txQty;
          break;
        }
        case InvestmentAction.SELL:
        case InvestmentAction.TRANSFER_OUT: {
          const sellQty = Math.min(txQty, qty);
          if (qty > 0) {
            const avg = totalCost / qty;
            totalCost -= sellQty * avg;
          }
          qty -= txQty;
          break;
        }
        case InvestmentAction.RETURN_OF_CAPITAL:
          // Same basis rule as the full rebuild; no shares move.
          totalCost = basisAfterReturnOfCapital(totalCost, tx);
          break;
        default:
          // ADD_SHARES / REMOVE_SHARES move shares without a cost; SPLIT scales
          // the position by its ratio; cash actions leave it alone. All three
          // go through the shared reducer so this replay cannot drift from the
          // net-worth and cost-basis ones.
          qty = applyActionToQuantity(qty, tx.action, txQty);
          break;
      }
    }

    if (Math.abs(qty) < 1e-8) {
      qty = 0;
      totalCost = 0;
    }
    const averageCost = qty > 0 ? totalCost / qty : 0;
    return { quantity: qty, averageCost };
  }

  async getHoldingsSummary(userId: string, accountId: string) {
    const holdings = await this.findAll(userId, accountId);

    // A held position with no stored average cost has an unknown basis, not a
    // free one; an empty position holds zero cost.
    const rows = holdings.map((h) => {
      const quantity = Number(h.quantity);
      const averageCost =
        h.averageCost === null || h.averageCost === undefined
          ? null
          : Number(h.averageCost);
      const costBasis =
        averageCost !== null
          ? quantity * averageCost
          : quantity === 0
            ? 0
            : null;
      return { h, quantity, averageCost, costBasis };
    });
    const costBasisComplete = rows.every((r) => r.costBasis !== null);
    const knownCostBasis = sumMoney(rows.map((r) => r.costBasis ?? 0));

    const summary = {
      totalHoldings: holdings.length,
      totalQuantity: holdings.reduce((sum, h) => sum + Number(h.quantity), 0),
      // Null while any holding's basis is unknown; the priced part is in
      // `knownCostBasis`.
      totalCostBasis: costBasisComplete ? knownCostBasis : null,
      knownCostBasis,
      costBasisComplete,
      holdings: rows.map(({ h, quantity, averageCost, costBasis }) => ({
        id: h.id,
        symbol: h.security.symbol,
        name: h.security.name,
        quantity,
        averageCost,
        costBasis,
      })),
    };

    return summary;
  }

  async remove(userId: string, id: string): Promise<void> {
    const outer = await this.findOne(userId, id);

    await withScopedDb(this.dataSource, async (m) => {
      // "Quantity is zero" is a refusal, so it is checked against the row this
      // statement is about to delete, under the lock every holdings writer
      // takes. Checked outside, a buy committing in between would have its
      // shares deleted by a request that had seen zero.
      await lockHoldingScope(m, [outer.accountId]);

      // Scoped to the owner-verified account, not a bare `id`. Holdings carry no
      // user_id column (ownership is the account's), so the outer
      // findOne(userId, id) established the owner and this re-read stays inside
      // that scope -- the unscoped `where: { id }` was an owner-scope drop even
      // though the lock is on the same account.
      const holding = await m.getRepository(Holding).findOne({
        where: { id, accountId: outer.accountId },
      });
      if (!holding) {
        throw new NotFoundException(
          tr(
            "errors.securities.holdingNotFound",
            `Holding with ID ${id} not found`,
            { id },
          ),
        );
      }

      if (Math.abs(Number(holding.quantity)) >= 0.0001) {
        throw new ForbiddenException(
          tr(
            "errors.securities.cannotDeleteNonZeroHolding",
            "Cannot delete holding with non-zero quantity",
          ),
        );
      }

      await m.getRepository(Holding).remove(holding);
    });
  }

  /**
   * Replay the user's investment transactions in chronological order and
   * throw BadRequestException if any (account, security) pair would have a
   * negative running quantity at any date. Used after editing or deleting a
   * past investment transaction to ensure the change does not retroactively
   * cause an oversell on any historical date.
   */
  /**
   * Replay a user's investment transactions in chronological order and
   * throw BadRequestException if any (account, security) pair would have a
   * negative running quantity at any date. Used after editing or deleting a
   * past investment transaction to ensure the change does not retroactively
   * cause an oversell on any historical date.
   *
   * When `accountIds` is provided, only those accounts are validated. The
   * caller should pass the accounts touched by the edit so pre-existing
   * inconsistencies in unrelated accounts (for example, from historical
   * imports) don't get blamed on this change.
   *
   * When `securityIds` is provided, only those securities are validated
   * within the in-scope accounts. Same rationale: editing a 2026 trade in
   * security A should never surface a 2009 oversell of security B that
   * existed before this edit.
   */
  async validateNoNegativeHoldingsHistory(
    userId: string,
    manager?: EntityManager,
    accountIds?: string[],
    securityIds?: string[],
  ): Promise<void> {
    const transactions = await this.inScope(manager, async (m) => {
      let eligibleAccountIds: string[];
      if (accountIds && accountIds.length > 0) {
        eligibleAccountIds = accountIds;
      } else {
        const investmentAccounts = await m.getRepository(Account).find({
          where: {
            userId,
            accountType: AccountType.INVESTMENT,
          },
        });

        eligibleAccountIds = investmentAccounts
          .filter(
            (a) =>
              a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
              !a.accountSubType,
          )
          .map((a) => a.id);
      }

      if (eligibleAccountIds.length === 0) {
        return [];
      }

      const where: Record<string, unknown> = {
        userId,
        accountId: In(eligibleAccountIds),
        // Rows as effects: a VOID transaction moved no shares, so it cannot
        // be what oversells a position.
        status: NON_VOID_INVESTMENT_STATUS,
      };
      if (securityIds && securityIds.length > 0) {
        where.securityId = In(securityIds);
      }
      return m.getRepository(InvestmentTransaction).find({
        where,
        relations: ["security"],
        order: INVESTMENT_REPLAY_ORDER,
      });
    });

    const balances = new Map<string, number>();
    const securityFilter =
      securityIds && securityIds.length > 0 ? new Set(securityIds) : null;

    for (const tx of transactions) {
      if (!tx.securityId) continue;
      if (securityFilter && !securityFilter.has(tx.securityId)) continue;

      const key = `${tx.accountId}:${tx.securityId}`;
      const current = balances.get(key) || 0;
      const quantity = Number(tx.quantity) || 0;

      if (!SHARE_MOVING_ACTIONS.includes(tx.action)) continue;
      const next = applyActionToQuantity(current, tx.action, quantity);

      if (next < -0.00000001) {
        const symbol = tx.security?.symbol || "this security";
        throw new BadRequestException(
          tr(
            "errors.securities.holdingsWouldGoNegative",
            `This change would cause holdings of ${symbol} to go negative on ${tx.transactionDate}. A ${tx.action} transaction on that date would reduce the balance below zero.`,
            { symbol, transactionDate: tx.transactionDate, action: tx.action },
          ),
        );
      }

      balances.set(key, next);
    }
  }

  /**
   * Server-local "today" as YYYY-MM-DD. Used as the default holdings cutoff;
   * callers that need a timezone-correct cutoff pass it explicitly.
   */
  private serverToday(): string {
    return formatDateYMDLocal(new Date());
  }

  /**
   * Compare one user's stored holdings against a replay of their ledger, and
   * return only the positions that disagree.
   *
   * **Reads only.** Nothing here writes, deletes or locks: the answer is
   * evidence for a human, and the repair is `POST /holdings/rebuild`, which the
   * owner runs when they have looked at what is reported. A rebuild is the
   * right repair for drift that predates the ledger-projection rule and the
   * wrong response to a replay that disagrees for some other reason, which is
   * why this refuses to make the choice.
   *
   * The replay is `computeHoldingsMap` over `INVESTMENT_REPLAY_ORDER` -- the
   * same fold `rebuildScopesFromTransactions` writes from -- and the comparison
   * is against `projectedHoldingRow`, the same projection of that fold the
   * rebuild writers store, so a position this reports is exactly one a rebuild
   * would change.
   */
  async findLedgerDiscrepancies(
    userId: string,
    manager: EntityManager,
    asOfDate?: string,
  ): Promise<HoldingDiscrepancy[]> {
    const accounts = await manager.find(Account, {
      where: { userId, accountType: AccountType.INVESTMENT },
    });
    const eligibleIds = accounts
      .filter(
        (a) =>
          a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
          !a.accountSubType,
      )
      .map((a) => a.id);
    if (eligibleIds.length === 0) return [];

    const stored = await manager.find(Holding, {
      where: { accountId: In(eligibleIds) },
    });
    if (stored.length === 0) return [];

    const transactions = await manager.find(InvestmentTransaction, {
      where: {
        userId,
        accountId: In(eligibleIds),
        transactionDate: LessThanOrEqual(asOfDate ?? this.serverToday()),
        // Rows as effects: a VOID transaction moved no shares.
        status: NON_VOID_INVESTMENT_STATUS,
      },
      order: INVESTMENT_REPLAY_ORDER,
    });
    const replayed = this.computeHoldingsMap(transactions);

    const discrepancies: HoldingDiscrepancy[] = [];
    for (const row of stored) {
      const data = replayed.get(row.accountId)?.get(row.securityId);
      const storedQuantity = Number(row.quantity);
      const storedAverageCost =
        row.averageCost === null ? null : Number(row.averageCost);
      // What a rebuild would store for this position, through the same helper
      // the rebuild writers use. Deriving the expected average here instead
      // reported every short position as disagreeing -- the writers store
      // `averageCost = 0` for a negative quantity, so `POST /holdings/rebuild`
      // wrote back exactly what was already there and the finding came back at
      // the next boot. `null` is a rebuild that would store no row at all.
      const projected = projectedHoldingRow(data);
      const replayedQuantity = projected ? projected.quantity : null;
      const replayedAverageCost = projected ? projected.averageCost : null;

      // Both figures are stored to a fixed scale (quantity 8, average cost 10),
      // so the comparison is against the smallest difference the column can
      // hold rather than an exact equality no float round-trip survives.
      const quantityDiffers =
        replayedQuantity === null ||
        Math.abs(replayedQuantity - storedQuantity) > 0.00000001;
      const costDiffers =
        (storedAverageCost === null) !== (replayedAverageCost === null) ||
        (storedAverageCost !== null &&
          replayedAverageCost !== null &&
          Math.abs(replayedAverageCost - storedAverageCost) > 0.0000000001);

      if (quantityDiffers || costDiffers) {
        discrepancies.push({
          accountId: row.accountId,
          securityId: row.securityId,
          storedQuantity,
          storedAverageCost,
          replayedQuantity,
          replayedAverageCost,
        });
      }
    }
    return discrepancies;
  }

  /**
   * The per-share basis the TRANSFER_OUT leg `outLegId` relieves from its
   * source position, read from the ledger as the caller's transaction sees it
   * (A26-M22). `transferSecurity` and the transfer edit call this under
   * `lockHoldingScope`, after the OUT leg is written, and store the answer as
   * the price of both legs: the carried basis is the source's at the transfer's
   * own position in the replay, not today's stored average and not a figure
   * the client sent.
   *
   * It is `computeHoldingsMap` over every row of the security -- the fold that
   * writes `holdings`, not a second one -- so a source that itself received
   * the shares by an earlier transfer is replayed with that transfer's carry.
   * `null` when the basis is not knowable: the leg is not in the ledger (VOID
   * or absent), or the source held fewer units than it moved, in which case
   * `validateNoNegativeHoldingsHistory` is the refusal and the caller keeps its
   * fallback until then.
   */
  async releasedBasisPerShare(
    userId: string,
    securityId: string,
    outLegId: string,
    manager: EntityManager,
  ): Promise<number | null> {
    const ledger = await manager.find(InvestmentTransaction, {
      where: {
        userId,
        securityId,
        // Rows as effects: a VOID transaction moved no shares.
        status: NON_VOID_INVESTMENT_STATUS,
      },
      order: INVESTMENT_REPLAY_ORDER,
    });
    const releasedByTransferOut = new Map<string, number>();
    this.computeHoldingsMap(ledger, releasedByTransferOut);

    const released = releasedByTransferOut.get(outLegId);
    const quantity = Number(ledger.find((tx) => tx.id === outLegId)?.quantity);
    if (released === undefined || !(quantity > 0)) return null;
    return released / quantity;
  }

  /**
   * Fold a chronologically-ordered list of investment transactions into a
   * holdings map (accountId -> securityId -> { quantity, totalCost }). Shared by
   * every rebuild path so the share-count and cost-basis math stays identical.
   */
  private computeHoldingsMap(
    transactions: InvestmentTransaction[],
    releasedByTransferOut: Map<string, number> = new Map(),
  ): Map<string, Map<string, { quantity: number; totalCost: number }>> {
    const holdingsMap = new Map<
      string,
      Map<string, { quantity: number; totalCost: number }>
    >();

    // A transferred-in lot takes the basis its paired TRANSFER_OUT relieved
    // (A26-M22), so the OUT leg has to be folded before its IN leg when the two
    // share an instant. `releasedByTransferOut` is keyed by the OUT leg's id,
    // which the IN leg names in `linkedTransactionId`; it holds only OUT legs
    // that relieved ALL their units, and a caller may pass its own map to read
    // what each leg released.
    for (const tx of orderTransferOutBeforeIn(transactions)) {
      // A return of capital moves no shares but does move the basis, so it is
      // the one cash action this fold must read.
      const returnsCapital = tx.action === InvestmentAction.RETURN_OF_CAPITAL;
      if (
        (!SHARE_MOVING_ACTIONS.includes(tx.action) && !returnsCapital) ||
        !tx.securityId
      ) {
        continue;
      }

      const quantity = Number(tx.quantity) || 0;

      // Whether this action moved shares in or out, used only to pick the basis
      // treatment below -- the quantity itself folds through the shared reducer.
      const quantityChange =
        applyActionToQuantity(0, tx.action, quantity) < 0
          ? -quantity
          : quantity;

      // Get or create account map
      if (!holdingsMap.has(tx.accountId)) {
        holdingsMap.set(tx.accountId, new Map());
      }
      const accountHoldings = holdingsMap.get(tx.accountId)!;

      // Get or create security holding
      if (!accountHoldings.has(tx.securityId)) {
        accountHoldings.set(tx.securityId, { quantity: 0, totalCost: 0 });
      }
      const holding = accountHoldings.get(tx.securityId)!;

      // The position before this row, for the basis a TRANSFER_OUT relieves.
      const quantityBefore = holding.quantity;
      const costBefore = holding.totalCost;
      // A TRANSFER_IN is not a purchase: it takes what its paired OUT leg
      // relieved, when that leg is in this fold and relieved every unit.
      // Otherwise (the OUT leg is outside the rows or VOID, or the source held
      // fewer units than it moved) it falls back to its own row's price.
      const carried =
        baseInvestmentAction(tx.action) === InvestmentAction.TRANSFER_IN &&
        tx.linkedTransactionId
          ? releasedByTransferOut.get(tx.linkedTransactionId)
          : undefined;

      // Quantity always moves through the shared reducer; only the basis
      // treatment varies by action. Note that a disposal subtracts in full
      // rather than drawing down to zero: an over-sell is history the import
      // cross-check (`check-holdings.ts`, which mirrors this fold and always
      // subtracted) and `recomputeAsOf` both already carry as negative, and
      // clamping it here made the same position reconcile in one replay and
      // not another.
      if (returnsCapital) {
        // Pays back cost, never below zero, in the security's currency.
        holding.totalCost = basisAfterReturnOfCapital(holding.totalCost, tx);
      } else if (tx.action === InvestmentAction.SPLIT) {
        // Total cost basis is preserved across a split; the per-share cost
        // falls out of totalCost / quantity once the ratio is applied.
      } else if (isQuantityOnlyAction(tx.action)) {
        // ADD_SHARES / REMOVE_SHARES: quantity only, no cost basis change.
      } else if (quantityChange > 0) {
        // Includes the acquisition commission, so average cost is what a share
        // actually cost to acquire: 10 shares at 100 with 10 commission is
        // 101.00 per share, not 100.00: leaving it out reported the commission
        // as gain on the disposal (P5-006). Prices here are in the security's
        // currency, as is `averageCost`, so the row's rate is not applied.
        const cost = acquiredBasis(tx, carried);
        if (cost !== null) holding.totalCost += cost;
      } else if (holding.quantity > 0) {
        // Relieve basis proportionally, for at most the shares actually held.
        const avgCost = holding.totalCost / holding.quantity;
        const relieved = Math.min(Math.abs(quantityChange), holding.quantity);
        holding.totalCost -= relieved * avgCost;
      }

      holding.quantity = applyActionToQuantity(
        holding.quantity,
        tx.action,
        quantity,
      );

      // What a TRANSFER_OUT relieved, kept for its paired IN leg -- only when
      // the source held every unit the leg moved (A26-M22).
      if (
        baseInvestmentAction(tx.action) === InvestmentAction.TRANSFER_OUT &&
        quantityBefore > 0 &&
        quantityBefore >= quantity - HOLDING_QUANTITY_EPSILON
      ) {
        releasedByTransferOut.set(tx.id, costBefore - holding.totalCost);
      }

      // Snap a rounding residue to exactly zero, at the stored scale (8 dp).
      // It used to be 0.0001 at every step, so purchases under 0.0001 shares
      // (a daily 0.00009 BTC) each started from a snapped zero and never
      // formed a holding while their cash left the account (A26-M23). A real
      // fractional position is not a ghost; `projectedHoldingRow` decides at
      // the end with the same epsilon.
      if (Math.abs(holding.quantity) <= HOLDING_QUANTITY_EPSILON) {
        holding.quantity = 0;
        holding.totalCost = 0;
      }
    }

    return holdingsMap;
  }

  /**
   * Re-derive the stored holding of each (account, security) scope from the
   * ledger, inside the caller's open transaction and under the same advisory
   * lock every other holdings writer takes.
   *
   * This is the door every investment-transaction write path goes through
   * after it has finished writing the ledger. A holding is a projection of
   * `investment_transactions`, not an accumulator: an incremental
   * `new = old + delta` blends a purchase into the average cost in INSERTION
   * order, so a back-dated SELL entered after a later BUY relieved basis that
   * the replay says it never held. The lock gives economic order no protection
   * at all -- it serializes writers, and the defect is a single writer's
   * arithmetic (issue #1388).
   *
   * A scope the ledger has no rows for projects to "no holding": the row is
   * deleted, exactly as `POST /holdings/rebuild` has always done. The ledger is
   * the record; a holding with no rows behind it is a residue, not an opening
   * position, and an opening position is imported as an ADD_SHARES row.
   *
   * Only the named scopes are touched, so a write in one security cannot
   * rewrite an unrelated position in the same account.
   */
  async rebuildScopesFromTransactions(
    userId: string,
    scopes: readonly HoldingScope[],
    manager: EntityManager,
    asOfDate?: string,
  ): Promise<void> {
    const requested = new Map<string, HoldingScope>();
    for (const scope of scopes) {
      if (!scope.accountId || !scope.securityId) continue;
      requested.set(`${scope.accountId}:${scope.securityId}`, scope);
    }
    if (requested.size === 0) return;

    const accountIds = Array.from(
      new Set(Array.from(requested.values()).map((s) => s.accountId)),
    );

    // Taken before the ledger is read, same namespace as every other holdings
    // writer: the thing a rebuild must not lose is a concurrent *trade*, which
    // no holdings row locks (audit P4-006).
    await lockHoldingScope(manager, accountIds);

    // Only brokerage / standalone investment accounts track holdings; the cash
    // sleeve is excluded from every other rebuild, so its rows must not be
    // deleted here either.
    const accounts = await manager.find(Account, {
      where: {
        id: In(accountIds),
        userId,
        accountType: AccountType.INVESTMENT,
      },
    });
    const eligibleIds = new Set(
      accounts
        .filter(
          (a) =>
            a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
            !a.accountSubType,
        )
        .map((a) => a.id),
    );
    const inScope = Array.from(requested.values()).filter((s) =>
      eligibleIds.has(s.accountId),
    );
    if (inScope.length === 0) return;

    const securityIds = Array.from(new Set(inScope.map((s) => s.securityId)));
    const cutoff = asOfDate ?? this.serverToday();

    // `In() x In()` is a cross product, so the exact pairs are filtered back
    // out below -- a row from a scope nobody asked about must not fold into
    // the map and get written.
    const wanted = new Set(
      inScope.map((s) => `${s.accountId}:${s.securityId}`),
    );
    const ledger = (
      await manager.find(InvestmentTransaction, {
        where: {
          userId,
          accountId: In(Array.from(eligibleIds)),
          securityId: In(securityIds),
          transactionDate: LessThanOrEqual(cutoff),
          // Rows as effects: a VOID transaction moved no shares.
          status: NON_VOID_INVESTMENT_STATUS,
        },
        order: INVESTMENT_REPLAY_ORDER,
      })
    ).filter((tx) => wanted.has(`${tx.accountId}:${tx.securityId}`));

    const holdingsMap = this.computeHoldingsMap(ledger);

    const repo = manager.getRepository(Holding);
    const existing = await repo.find({
      where: {
        accountId: In(Array.from(eligibleIds)),
        securityId: In(securityIds),
      },
    });
    const existingByScope = new Map<string, Holding>(
      existing
        .filter((h) => wanted.has(`${h.accountId}:${h.securityId}`))
        .map((h) => [`${h.accountId}:${h.securityId}`, h]),
    );

    for (const scope of inScope) {
      const key = `${scope.accountId}:${scope.securityId}`;
      const data = holdingsMap.get(scope.accountId)?.get(scope.securityId);
      const row = existingByScope.get(key);
      const projected = projectedHoldingRow(data);

      if (!projected) {
        // No shares the ledger can account for: the projection is "no holding".
        if (row) await repo.remove(row);
        continue;
      }

      if (row) {
        row.quantity = projected.quantity;
        row.averageCost = projected.averageCost;
        await repo.save(row);
      } else {
        await repo.save(
          repo.create({
            accountId: scope.accountId,
            securityId: scope.securityId,
            quantity: projected.quantity,
            averageCost: projected.averageCost,
          }),
        );
      }
    }
  }

  /**
   * Rebuild holdings for a specific set of accounts from their transaction
   * history, operating within the caller's open transaction.
   *
   * Unlike `rebuildFromTransactions` (which opens its own transaction and
   * rebuilds every eligible account), this participates in the caller's
   * transaction so the rebuild commits or rolls back atomically with the
   * operation that triggered it. Callers that must not silently leave stale or
   * misattributed holdings (e.g. a security-transfer edit, where the
   * incremental reverse/re-apply can misattribute average cost across a zero
   * crossing) use this instead of a best-effort post-commit rebuild.
   */
  async rebuildAccountsFromTransactions(
    userId: string,
    accountIds: string[],
    manager: EntityManager,
    asOfDate?: string,
  ): Promise<void> {
    if (accountIds.length === 0) return;

    // Same lock namespace as the incremental mutators, taken before the ledger
    // is read. A rebuild replays investment_transactions and replaces the
    // holdings derived from them, so the thing it must not lose is a *trade* --
    // an insert into investment_transactions, which no holdings row locks. Only
    // an account-level lock shared with the trade path serializes the two
    // (audit P4-006).
    await lockHoldingScope(manager, accountIds);

    // Only brokerage / standalone investment accounts track holdings; the cash
    // sleeve of an investment account is excluded everywhere else, so it must be
    // excluded here too or its rows would be deleted but never rebuilt.
    const accounts = await manager.find(Account, {
      where: {
        id: In(accountIds),
        userId,
        accountType: AccountType.INVESTMENT,
      },
    });
    const eligibleIds = accounts
      .filter(
        (a) =>
          a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
          !a.accountSubType,
      )
      .map((a) => a.id);
    if (eligibleIds.length === 0) return;

    const cutoff = asOfDate ?? this.serverToday();
    const transactions = await manager.find(InvestmentTransaction, {
      where: {
        userId,
        accountId: In(eligibleIds),
        transactionDate: LessThanOrEqual(cutoff),
        // Rows as effects: a VOID transaction moved no shares.
        status: NON_VOID_INVESTMENT_STATUS,
      },
      order: INVESTMENT_REPLAY_ORDER,
    });

    const holdingsMap = this.computeHoldingsMap(transactions);

    // Delete + recreate holdings for these accounts only.
    const existing = await manager.find(Holding, {
      where: { accountId: In(eligibleIds) },
    });
    if (existing.length > 0) {
      await manager.remove(existing);
    }

    const holdingsRepo = manager.getRepository(Holding);
    const holdingsToCreate: Holding[] = [];
    for (const [accountId, securities] of holdingsMap) {
      for (const [securityId, data] of securities) {
        const projected = projectedHoldingRow(data);
        if (projected) {
          holdingsToCreate.push(
            holdingsRepo.create({
              accountId,
              securityId,
              quantity: projected.quantity,
              averageCost: projected.averageCost,
            }),
          );
        }
      }
    }
    if (holdingsToCreate.length > 0) {
      await holdingsRepo.save(holdingsToCreate);
    }
  }

  /**
   * Rebuild all holdings from existing investment transactions.
   * This recalculates all holdings based on transaction history,
   * useful for fixing data after imports that didn't create holdings.
   * Wrapped in a single scoped transaction for atomicity.
   */
  async rebuildFromTransactions(
    userId: string,
    asOfDate?: string,
  ): Promise<{
    holdingsCreated: number;
    holdingsUpdated: number;
    holdingsDeleted: number;
  }> {
    const cutoff = asOfDate ?? this.serverToday();

    // Account discovery, the ledger read, the delete and the recreate all in ONE
    // transaction, with the account lock taken first.
    //
    // Reading the accounts and the ledger in separate transactions and writing
    // in a third made this idempotent only against an unchanged ledger: a trade
    // committing after the ledger read was replaced by a snapshot that never saw
    // it, so the rebuild *deleted* a holding the trade had just updated (audit
    // P4-006). The lock is the same one createOrUpdate takes, which is what
    // makes the two protocols exclusive rather than merely both careful.
    let holdingsDeleted = 0;
    let holdingsCreated = 0;

    await withScopedDb(this.dataSource, async (m) => {
      // M14: Get all investment accounts (brokerage + standalone) for the user
      const investmentAccounts = await m.getRepository(Account).find({
        where: {
          userId,
          accountType: AccountType.INVESTMENT,
        },
      });

      // Include brokerage accounts and standalone investment accounts (null subType)
      const eligibleAccounts = investmentAccounts.filter(
        (a) =>
          a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
          !a.accountSubType,
      );

      if (eligibleAccounts.length === 0) return;

      const brokerageAccountIds = eligibleAccounts.map((a) => a.id);
      await lockHoldingScope(m, brokerageAccountIds);

      // Get all investment transactions for these accounts up to the cutoff
      // date, ordered by date. Future-dated transactions are excluded so they
      // don't affect current holdings. Callers materializing matured
      // transactions (the hourly cron) pass the user's timezone-correct "today"
      // so a transfer dated today in a timezone ahead of the server isn't
      // wrongly treated as future.
      const transactions = await m.getRepository(InvestmentTransaction).find({
        where: {
          userId,
          accountId: In(brokerageAccountIds),
          transactionDate: LessThanOrEqual(cutoff),
          // Rows as effects: a VOID transaction moved no shares.
          status: NON_VOID_INVESTMENT_STATUS,
        },
        order: INVESTMENT_REPLAY_ORDER,
      });

      // Map: accountId -> securityId -> { quantity, totalCost }
      const holdingsMap = this.computeHoldingsMap(transactions);

      // Delete all existing holdings for these accounts
      const existingHoldings = await m.find(Holding, {
        where: { accountId: In(brokerageAccountIds) },
      });
      holdingsDeleted = existingHoldings.length;
      if (existingHoldings.length > 0) {
        await m.remove(existingHoldings);
      }

      // Create new holdings from the calculated values (batched)
      const holdingsRepo = m.getRepository(Holding);
      const holdingsToCreate: Holding[] = [];
      for (const [accountId, securities] of holdingsMap) {
        for (const [securityId, data] of securities) {
          // Only create a holding the ledger accounts for shares in.
          const projected = projectedHoldingRow(data);
          if (projected) {
            holdingsToCreate.push(
              holdingsRepo.create({
                accountId,
                securityId,
                quantity: projected.quantity,
                averageCost: projected.averageCost,
              }),
            );
          }
        }
      }
      if (holdingsToCreate.length > 0) {
        await holdingsRepo.save(holdingsToCreate);
      }
      holdingsCreated = holdingsToCreate.length;
    });

    return {
      holdingsCreated,
      holdingsUpdated: 0, // We deleted and recreated, so no updates
      holdingsDeleted,
    };
  }

  /**
   * Apply matured future-dated investment transactions to holdings.
   *
   * Future-dated investment transactions skip the holdings update at creation
   * time. The hourly cash-balance cron rolls cash forward when their date
   * arrives, but it never touches holdings -- and a security transfer has no
   * cash side at all, so without this nothing would ever move the shares.
   * Once per hour we rebuild holdings for any user with an investment
   * transaction dated "today" (per their timezone). The rebuild is idempotent,
   * so re-running it for users who also traded normally today is harmless.
   */
  @Cron("30 * * * *")
  async applyMaturedInvestmentHoldings(): Promise<void> {
    // RLS (task C2): the timezone/matured-user fan-out queries span users, so
    // the body runs under a system context; each per-user rebuild re-enters a
    // user context below.
    return withSystemContext(() =>
      this.applyMaturedInvestmentHoldingsWithinContext(),
    );
  }

  private async applyMaturedInvestmentHoldingsWithinContext(): Promise<void> {
    try {
      const userIdsByTz = await getUsersByEffectiveTimezone(this.dataSource);
      if (userIdsByTz.size === 0) return;

      let rebuilt = 0;
      for (const [tz, userIds] of userIdsByTz) {
        const today = todayInTimezone(tz);
        if (!today) continue;

        const maturedRows: { user_id: string }[] = await withScopedDb(
          this.dataSource,
          (m) =>
            m.query(
              `SELECT DISTINCT user_id
             FROM investment_transactions
             WHERE user_id = ANY($1)
               AND transaction_date = $2
               AND status != 'VOID'`,
              [userIds, today],
            ),
        );

        for (const { user_id } of maturedRows) {
          // Pass the user's timezone-correct today as the cutoff so the rebuild
          // includes the transaction that just matured -- without it the rebuild
          // would re-filter against the server's local date and could exclude a
          // transfer dated today in a timezone ahead of the server.
          await withUserContext(user_id, () =>
            this.rebuildFromTransactions(user_id, today),
          );
          rebuilt += 1;
        }
      }

      if (rebuilt > 0) {
        this.logger.log(
          `Rebuilt holdings for ${rebuilt} user(s) with matured investment transactions`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to apply matured investment holdings: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete all holdings for a user's brokerage accounts.
   */
  async removeAllForUser(userId: string): Promise<number> {
    // Get all brokerage accounts for the user
    return withScopedDb(this.dataSource, async (m) => {
      const brokerageAccounts = await m.getRepository(Account).find({
        where: {
          userId,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        },
      });

      if (brokerageAccounts.length === 0) {
        return 0;
      }

      const brokerageAccountIds = brokerageAccounts.map((a) => a.id);
      // Same lock namespace: a wipe racing a trade would otherwise delete a
      // holding the trade just wrote, leaving the ledger and the holdings
      // disagreeing with no rebuild scheduled.
      await lockHoldingScope(m, brokerageAccountIds);

      // Delete all holdings for these accounts
      const holdingsRepo = m.getRepository(Holding);
      const holdings = await holdingsRepo.find({
        where: { accountId: In(brokerageAccountIds) },
      });

      const count = holdings.length;
      if (holdings.length > 0) {
        await holdingsRepo.remove(holdings);
      }

      return count;
    });
  }
}
