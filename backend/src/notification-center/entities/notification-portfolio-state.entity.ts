import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

/** decimal(24,8)/(9,4) come back from pg as strings; keep them numbers. */
const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

/** A DATE column, kept as a `YYYY-MM-DD` string (no timezone shifting). */
const dateTransformer = {
  from: (value: string | Date | null): string | null => {
    if (!value) return value as null;
    if (typeof value === "string") return value;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },
  to: (value: string | Date | null): string | Date | null => value,
};

/**
 * Per-user state for the daily portfolio-movement notification
 * (`docs/specs/portfolio-movement-notifications.md`): the opt-in threshold and
 * the producer's own baseline -- the last COMPLETE portfolio value it saw and
 * the currency it was measured in. One row per user.
 */
@Entity("notification_portfolio_state")
export class NotificationPortfolioState {
  @PrimaryColumn({ type: "uuid", name: "user_id" })
  userId: string;

  /** Opt-in threshold in percent; NULL (or <= 0) means the alert is off. */
  @Column({
    type: "numeric",
    name: "move_alert_percent",
    precision: 9,
    scale: 4,
    nullable: true,
    transformer: numericTransformer,
  })
  moveAlertPercent: number | null;

  /** Last complete portfolio value seen (INV-PORTMOVE-001), in baselineCurrency. */
  @Column({
    type: "numeric",
    name: "baseline_value",
    precision: 24,
    scale: 8,
    nullable: true,
    transformer: numericTransformer,
  })
  baselineValue: number | null;

  /** The reporting currency baselineValue is in (a resolved snapshot). */
  @Column({
    type: "varchar",
    name: "baseline_currency",
    length: 3,
    nullable: true,
  })
  baselineCurrency: string | null;

  /** The day the baseline value was measured. */
  @Column({
    type: "date",
    name: "baseline_captured_on",
    nullable: true,
    transformer: dateTransformer,
  })
  baselineCapturedOn: string | null;

  /**
   * The per-security closes the baseline was valued at (INV-PORTMOVE-008),
   * written and read by `PortfolioMovementAlertService` as
   * `BaselinePosition[]`. NULL means none were recorded, and the next run
   * replaces the baseline rather than comparing against it.
   */
  @Column({ type: "jsonb", name: "baseline_positions", nullable: true })
  baselinePositions: unknown;

  @Column({
    type: "timestamp",
    name: "created_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamp", name: "updated_at" })
  updatedAt: Date;
}
