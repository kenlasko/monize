import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Index,
  Check,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { TransactionSplit } from "../../transactions/entities/transaction-split.entity";
import { AccrualSystemAccount } from "./accrual-system-account.entity";
import type { AccrualFamily } from "../accrual-balance";
import type { AccrualDateRule } from "../accrual-allocation";

@Entity("accrual_schedules")
@Unique("uq_accrual_schedule_owner", ["id", "userId"])
@Index("uq_accrual_schedule_transaction", ["sourceTransactionId"], {
  unique: true,
  where: "source_split_id IS NULL",
})
@Index("uq_accrual_schedule_split", ["sourceSplitId"], {
  unique: true,
  where: "source_split_id IS NOT NULL",
})
@Index("idx_accrual_schedule_user", ["userId"])
@Check("ck_accrual_schedule_count", "month_count BETWEEN 1 AND 600")
@Check(
  "ck_accrual_schedule_start",
  "EXTRACT(DAY FROM start_month) = 1 AND start_month >= DATE '0001-01-01' AND start_month <= DATE '9999-12-01'",
)
@Check(
  "ck_accrual_schedule_end",
  "start_month + (month_count - 1) * INTERVAL '1 month' <= DATE '9999-12-01'",
)
@Check("ck_accrual_schedule_preset", "preset IN ('LTM', 'NTM', 'CUSTOM')")
@Check(
  "ck_accrual_schedule_date_rule",
  "recognition_date_rule IN ('MONTH_END', 'FIRST_BUSINESS_DAY')",
)
@Check("ck_accrual_schedule_revision", "revision > 0")
@Check(
  "ck_accrual_schedule_fingerprint",
  "source_fingerprint ~ '^[a-f0-9]{64}$'",
)
export class AccrualSchedule {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ name: "user_id", type: "uuid" }) userId: string;
  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;
  @Column({ name: "source_transaction_id", type: "uuid" })
  sourceTransactionId: string;
  @ManyToOne(() => Transaction, { onDelete: "CASCADE" })
  @JoinColumn([
    { name: "source_transaction_id", referencedColumnName: "id" },
    { name: "user_id", referencedColumnName: "userId" },
  ])
  source?: Transaction;
  @Column({ name: "source_split_id", type: "uuid", nullable: true })
  sourceSplitId: string | null;
  @ManyToOne(() => TransactionSplit, { nullable: true, onDelete: "CASCADE" })
  @JoinColumn([
    { name: "source_split_id", referencedColumnName: "id" },
    { name: "source_transaction_id", referencedColumnName: "transactionId" },
  ])
  sourceSplit?: TransactionSplit | null;
  @Column({ type: "varchar", length: 10 }) family: AccrualFamily;
  @Column({ name: "currency_code", type: "varchar", length: 3 })
  currencyCode: string;
  @ManyToOne(() => AccrualSystemAccount)
  @JoinColumn([
    { name: "user_id", referencedColumnName: "userId" },
    { name: "family", referencedColumnName: "family" },
    { name: "currency_code", referencedColumnName: "currencyCode" },
  ])
  systemAccount?: AccrualSystemAccount;
  @Column({ type: "varchar", length: 10 }) preset: "LTM" | "NTM" | "CUSTOM";
  @Column({
    name: "recognition_date_rule",
    type: "varchar",
    length: 20,
    default: "MONTH_END",
  })
  recognitionDateRule: AccrualDateRule;
  @Column({ name: "start_month", type: "date" }) startMonth: string;
  @Column({ name: "month_count", type: "integer" }) monthCount: number;
  @Column({ type: "integer", default: 1 }) revision: number;
  @Column({ name: "source_fingerprint", type: "char", length: 64 })
  sourceFingerprint: string;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
