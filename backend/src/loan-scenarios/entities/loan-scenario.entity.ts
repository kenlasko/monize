import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { Account } from "../../accounts/entities/account.entity";

const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

/** Whether an overpayment shortens the term or lowers the installment. */
export type OverpaymentMode = "SHORTEN_TERM" | "LOWER_INSTALLMENT";
export const OVERPAYMENT_MODES: OverpaymentMode[] = [
  "SHORTEN_TERM",
  "LOWER_INSTALLMENT",
];

/** Cadence of a recurring overpayment (ONE_OFF is stored as a lump sum). */
export type OverpaymentFrequency =
  | "WEEKLY"
  | "BIWEEKLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "ANNUALLY";
export const OVERPAYMENT_FREQUENCIES: OverpaymentFrequency[] = [
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "ANNUALLY",
];

export interface LoanScenarioLumpSum {
  /** ISO date (yyyy-MM-dd) */
  date: string;
  amount: number;
  /** Effect of this overpayment; defaults to SHORTEN_TERM when absent. */
  mode?: OverpaymentMode;
}

/**
 * A saved overpayment simulation for a loan/mortgage account. Only the
 * inputs are persisted; schedules are recomputed client-side from the
 * account's current balance and rate so results never go stale.
 */
@Entity("loan_scenarios")
export class LoanScenario {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "account_id" })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: "account_id" })
  account?: Account;

  @Column({ type: "varchar", length: 100 })
  name: string;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "recurring_extra_amount",
    nullable: true,
    transformer: numericTransformer,
  })
  recurringExtraAmount: number | null;

  @Column({
    type: "varchar",
    length: 16,
    name: "recurring_extra_mode",
    nullable: true,
  })
  recurringExtraMode: OverpaymentMode | null;

  /** Cadence of the recurring overpayment; null means every loan payment. */
  @Column({
    type: "varchar",
    length: 16,
    name: "recurring_extra_frequency",
    nullable: true,
  })
  recurringExtraFrequency: OverpaymentFrequency | null;

  @Column({ type: "date", name: "recurring_extra_start_date", nullable: true })
  recurringExtraStartDate: string | null;

  @Column({ type: "date", name: "recurring_extra_end_date", nullable: true })
  recurringExtraEndDate: string | null;

  @Column({ type: "jsonb", name: "lump_sums", default: () => "'[]'" })
  lumpSums: LoanScenarioLumpSum[];

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
