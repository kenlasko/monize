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

const dateTransformer = {
  from: (value: string | Date): string => {
    if (!value) return value as string;
    if (typeof value === "string") return value;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  },
  to: (value: string | Date): string | Date => value,
};

export type LoanRateChangeSource = "manual" | "inferred" | "initial";

/**
 * A point on a loan/mortgage account's interest-rate timeline. These rows are
 * the record of what the loan's terms ARE: the rate in effect on any date is the
 * latest row effective on or before it (`effectiveAnnualRateOn`), and the
 * annuity payment likewise (`datedAnnuityPayment`, INV-LOAN-009).
 *
 * The account's scalar `interestRate` / `paymentAmount` are **not** denormalized
 * from them and never written by this module -- they stay user-owned, settable
 * only from the account edit form, so that recording a rate change or running
 * detection cannot clobber a manually set value. The two therefore diverge
 * routinely: after any change entered through the rate-history UI the scalars
 * hold the OLD terms. Anything projecting a loan forward reads the timeline, not
 * the scalars (frontend `buildLoanProjectionInput`); the scalars are the
 * fallback for a loan with no recorded history.
 *
 * 'initial' rows snapshot the origination rate the first time a change is
 * recorded; 'inferred' rows are produced by detection from payment history.
 * A null newPaymentAmount means the payment did not change with the rate.
 *
 * One asymmetry matters to consumers: an 'initial' row's `newPaymentAmount` is a
 * verbatim copy of `account.paymentAmount` at the time it was written
 * (`insertInitialRowIfFirst`), so it is a snapshot of that field rather than an
 * independent statement about what is being paid. 'manual' and 'inferred'
 * payments do state it -- detection writes null outright when interest is booked
 * separately, precisely so a principal-only observation never becomes one.
 */
@Entity("loan_rate_changes")
export class LoanRateChange {
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

  @Column({
    type: "date",
    name: "effective_date",
    transformer: dateTransformer,
  })
  effectiveDate: string;

  @Column({
    type: "decimal",
    precision: 8,
    scale: 4,
    name: "annual_rate",
    transformer: numericTransformer,
  })
  annualRate: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "new_payment_amount",
    nullable: true,
    transformer: numericTransformer,
  })
  newPaymentAmount: number | null;

  @Column({ type: "varchar", length: 10, default: "manual" })
  source: LoanRateChangeSource;

  @Column({ type: "varchar", length: 500, nullable: true })
  note: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
