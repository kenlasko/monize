import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import { BondAdapter } from "./bond-adapter";
import { INSTALLED_BOND_ADAPTERS } from "./bond-adapters";
import { loadBondLedger, loadLinkedSecurity } from "./bond-ledger";
import {
  BondLot,
  BondLotTransaction,
  bondLotsAsOf,
  bondLotsFromTransactions,
} from "./bond-lots";
import { BondValuationService } from "./bond-valuation.service";
import { ExactDecimal } from "./domain/exact-decimal";
import { RedemptionSplitRefusal } from "./engine/redemption-split";
import { inferSeriesForDate, seriesCodeOf } from "./bond-series-resolver";
import { lotsRefusalException } from "./bond-write-guard";

/** The series the server would infer for an acquisition on a date. */
export interface SeriesOnSale {
  readonly instrumentId: string;
  readonly seriesCode: string;
}

/**
 * The series code the adapter of a security's country would give a purchase on a
 * date, for the form's "Fetch <code>" action. Computed from the adapter's own
 * grammar, never stored or fetched.
 */
export interface ExpectedSeries {
  /** Null when the adapter cannot name one (no `seriesCodeFor`, or not its program). */
  readonly seriesCode: string | null;
  /** The country of the security's program (an issuer country, upper case). */
  readonly countryCode: string;
  /** True when the adapter can fetch a series from the official source. */
  readonly fetchable: boolean;
}

/** A series an account holds on a date. */
export interface SeriesHolding {
  readonly instrumentId: string;
  readonly seriesCode: string;
  /** A whole number of bonds, greater than zero. */
  readonly quantity: number;
}

/**
 * What a redemption of `quantity` bonds of one series pays on a date, as
 * returned principal and interest (`docs/specs/bond-redemption-interest.md`
 * 2.2): the engine's split of each lot portion the removal takes, summed
 * exactly. A figure is null when any portion's is unknown; `refusal` is the
 * first portion's refusal.
 */
export interface BondRedemptionSplit {
  readonly date: string;
  readonly quantity: number;
  readonly principal: string | null;
  readonly grossInterest: string | null;
  readonly deduction: string | null;
  readonly interest: string | null;
  readonly principalReturned: string | null;
  readonly payout: string | null;
  readonly refusal: RedemptionSplitRefusal | null;
}

const FIGURES = [
  "principal",
  "grossInterest",
  "deduction",
  "interest",
  "principalReturned",
  "payout",
] as const;

/**
 * What the transaction form asks the server before it writes
 * (`docs/specs/bond-program-securities.md` section 3.3): the series a BUY on a
 * date would be given, and the series an account holds, so a removal can name
 * one. Both are read through the code the write itself uses -- `seriesOnSaleSql`
 * and the lot derivation -- so the form never offers what the write would refuse.
 * Owner-scoped: `userId` comes from the JWT, and another user's security answers
 * 404 exactly as an unlinked one does.
 */
@Injectable()
export class BondHoldingsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly valuation: BondValuationService,
  ) {}

  /**
   * The series `resolveTransactionSeries` would store for a BUY or REINVEST on
   * `date` (the one series of the program whose newest terms' sale window
   * contains it), or null when none, or more than one, is on sale.
   */
  async seriesOnSale(
    userId: string,
    securityId: string,
    date: string,
  ): Promise<SeriesOnSale | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const security = await loadLinkedSecurity(m, userId, securityId);
      const instrumentId = await inferSeriesForDate(
        m,
        security.bondProgramId,
        date,
      );
      if (instrumentId === null) return null;
      const seriesCode = await seriesCodeOf(m, instrumentId);
      return seriesCode === null ? null : { instrumentId, seriesCode };
    });
  }

  /**
   * The series code a purchase of this security on `date` would carry, by the
   * grammar of the adapter of the program's country (`BondAdapter.seriesCodeFor`),
   * and whether that country can fetch a series. Nothing is read from the
   * catalog's series or from the network. A country with no adapter answers a
   * null code and `fetchable` false. 404 for a security that is not the
   * caller's or not linked.
   */
  async expectedSeries(
    userId: string,
    securityId: string,
    date: string,
    adapters: readonly BondAdapter[] = INSTALLED_BOND_ADAPTERS,
  ): Promise<ExpectedSeries> {
    return withScopedDb(this.dataSource, async (m) => {
      const security = await loadLinkedSecurity(m, userId, securityId);
      const rows: Array<{ issuer_country_code: string; program_code: string }> =
        await m.query(
          `SELECT issuer_country_code, program_code
             FROM bond_programs WHERE id = $1::uuid`,
          [security.bondProgramId],
        );
      const program = rows[0];
      if (!program) {
        throw new NotFoundException(
          tr(
            "errors.bonds.securityNotLinked",
            `Security ${securityId} not found or not linked to a bond program`,
            { securityId },
          ),
        );
      }
      const adapter = adapters.find(
        (a) => a.countryCode === program.issuer_country_code,
      );
      return {
        seriesCode:
          adapter?.seriesCodeFor?.(program.program_code, date) ?? null,
        countryCode: program.issuer_country_code,
        fetchable:
          adapter?.fetchSeries !== undefined &&
          adapter.seriesProviderId !== undefined,
      };
    });
  }

  /**
   * The series `accountId` holds on `date`: the lot derivation over the rows up
   * to and including that day, in replay order, excluding
   * `excludeTransactionId` (the row being edited), oldest lot first, quantity
   * above zero only. A ledger whose lots cannot be derived answers 422 with the
   * refusal code as `errorCode`.
   */
  async seriesHoldings(
    userId: string,
    securityId: string,
    accountId: string,
    date: string,
    excludeTransactionId?: string,
  ): Promise<{ holdings: SeriesHolding[] }> {
    return withScopedDb(this.dataSource, async (m) => {
      const ledger = await loadBondLedger(m, userId, securityId);
      const rows = ledger.transactions.filter(
        (row) => row.id === undefined || row.id !== excludeTransactionId,
      );
      const { lots, refusal } = bondLotsAsOf(rows, date);
      if (refusal !== null) throw lotsRefusalException(refusal, "read");

      const quantities = new Map<string, number>();
      for (const lot of lots) {
        if (lot.accountId !== accountId || lot.instrumentId === null) continue;
        quantities.set(
          lot.instrumentId,
          (quantities.get(lot.instrumentId) ?? 0) + lot.quantity,
        );
      }

      const holdings: SeriesHolding[] = [];
      for (const [instrumentId, quantity] of quantities) {
        if (quantity <= 0) continue;
        const seriesCode = await seriesCodeOf(m, instrumentId);
        if (seriesCode !== null) {
          holdings.push({ instrumentId, seriesCode, quantity });
        }
      }
      return { holdings };
    });
  }

  /**
   * The split of redeeming `quantity` bonds of series `instrumentId` out of
   * `accountId` on `date`. The lots taken are the ones the write's own lot
   * derivation takes: a REDEEM of that series, appended to the account's rows up
   * to the day (without `excludeTransactionId`, the row being edited), is folded
   * by `bondLotsFromTransactions`, whose `takenByLastRow` are the portions it
   * removes with the exact cost each carried.
   * A quantity above the series held in the account is refused with the removal
   * refusal (400, `errorCode`), a ledger already underivable with 422. Reads
   * stored terms and observations only (INV-BOND-008); nothing is written.
   */
  async redemptionSplit(
    userId: string,
    securityId: string,
    accountId: string,
    instrumentId: string,
    date: string,
    quantity: number,
    excludeTransactionId?: string,
  ): Promise<BondRedemptionSplit> {
    return withScopedDb(this.dataSource, async (m) => {
      const ledger = await loadBondLedger(m, userId, securityId);
      const rows = ledger.transactions.filter(
        (row) =>
          (row.id === undefined || row.id !== excludeTransactionId) &&
          row.transactionDate <= date,
      );
      const before = bondLotsFromTransactions(rows);
      if (before.refusal !== null) {
        throw lotsRefusalException(before.refusal, "read");
      }
      const redeem: BondLotTransaction = {
        action: "REDEEM",
        status: "ACTIVE",
        transactionDate: date,
        quantity: String(quantity),
        pairedTransfer: false,
        accountId,
        instrumentId,
      };
      const after = bondLotsFromTransactions([...rows, redeem]);
      if (after.refusal !== null) {
        throw lotsRefusalException(after.refusal, "write");
      }

      const reference = await this.valuation.loadReference(m, instrumentId);
      const places = reference.terms.rounding.moneyDecimals;
      const splits = after.takenByLastRow.map((lot) =>
        this.valuation.redemptionSplitFrom(reference, lot, date),
      );

      const totals = {} as Record<(typeof FIGURES)[number], string | null>;
      for (const figure of FIGURES) {
        let total: ExactDecimal | null = ExactDecimal.ZERO;
        for (const split of splits) {
          const value = split[figure];
          total =
            total === null || value === null
              ? null
              : total.add(ExactDecimal.parse(value));
        }
        totals[figure] = total === null ? null : total.toFixed(places);
      }
      const refusal = splits.find((s) => s.refusal !== null)?.refusal ?? null;
      return { date, quantity, ...totals, refusal };
    });
  }
}
