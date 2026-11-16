import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
  Check,
} from "typeorm";

/**
 * What a rate provider is known to hold for one currency pair, and where the
 * next history fill should resume.
 *
 * `ExchangeRateHistoryService` derived both facts from scratch on every press
 * and could keep neither. A pair whose provider history begins long after the
 * reader's own data does -- Yahoo carries nothing for `USDCAD=X` before
 * December 2003, against a ledger opening in 1996 -- paid one provider call per
 * dead year to learn that again after every restart, and a stretch the provider
 * had already answered as well as it can was re-asked for on the press after
 * next.
 *
 * **One row per pair, never per direction.** A rate window answers a pair, so
 * two rows would be the same divergence `exchange_rates` was collapsed to avoid
 * (INV-FX-003). The canonical orientation is `from < to`, the same rule
 * `canonicalRateRow` applies, and the CHECK constraint is what holds it rather
 * than a convention in the writer.
 *
 * **Scoped to a provider set.** What one chain of providers carries is not
 * what another does, so the row names the chain that wrote it (`providers`)
 * and is ignored, then replaced, under any other chain (a row written before
 * the switch to Frankfurter's v2 API names `frankfurter`, and is retired so).
 *
 * Global reference data with no owner column, like `exchange_rates` itself:
 * what a provider carries is the same fact for every account on the deployment.
 * RLS-exempt for that reason (`docs/row-level-security-contract.md`).
 */
@Entity("exchange_rate_coverage")
@Unique("uq_exchange_rate_coverage_pair", ["fromCurrency", "toCurrency"])
@Check("ck_exchange_rate_coverage_canonical", `"from_currency" < "to_currency"`)
export class ExchangeRateCoverage {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id: string;

  /** The canonically-first side of the pair; always less than `toCurrency`. */
  @Column({ type: "varchar", length: 3, name: "from_currency" })
  fromCurrency: string;

  @Column({ type: "varchar", length: 3, name: "to_currency" })
  toCurrency: string;

  /**
   * The earliest date the provider is known to carry a rate for this pair, or
   * `null` while nothing has established one. Nothing before it is ever asked
   * for again: a provider's history starts where it starts and no retry moves
   * it. `YYYY-MM-DD` through the raw reads that use it, never the DATE parser.
   */
  @Column({ type: "date", name: "earliest_available_date", nullable: true })
  earliestAvailableDate: string | null;

  /**
   * The date the next fill resumes from: the earliest date whose gap has not
   * yet been put to the provider, or `null` while the pair has never been
   * probed.
   *
   * It only ever moves forward. A stretch already fetched is behind it whether
   * the provider filled it densely or gave all it had, so a press spends its
   * budget on ground not yet covered instead of re-asking for the same years.
   * Gaps *after* it are still planned normally, because the span always runs to
   * today.
   */
  @Column({ type: "date", name: "first_gap_date", nullable: true })
  firstGapDate: string | null;

  /**
   * The earliest date any fill has planned over for this pair, or `null` while
   * none has.
   *
   * This is what makes `firstGapDate` safe rather than merely fast. A reader
   * who imports older transactions moves their own first use of the currency
   * behind everything probed so far; the pointer would then sit in front of
   * years nothing has ever looked at and hide them for good. When `firstUse`
   * reaches back further than this, the pointer is stood down for one press and
   * the newly reachable years are planned. It moves backwards only, which is
   * the direction the reader's data can grow.
   */
  @Column({ type: "date", name: "probed_from", nullable: true })
  probedFrom: string | null;

  /**
   * The provider chain the three dates above describe: the ordered source
   * slugs of `FxProviderChain.describe()`, joined with commas, or `null` on a
   * row written before the column existed.
   *
   * The row is scoped to a provider set, not to the pair alone. A floor Yahoo
   * established says nothing about what Frankfurter carries, so a row whose
   * value differs from the running chain's reads as never probed, and the next
   * write replaces its dates instead of merging them -- otherwise the stale
   * `GREATEST` ratchet would survive the first write after the chain changes
   * (as it did when the ECB-only v1 Frankfurter adapter, history from 1999,
   * was replaced by the v2 one).
   */
  @Column({ type: "varchar", length: 200, name: "providers", nullable: true })
  providers: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
