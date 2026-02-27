import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from "typeorm";
import { Account } from "../../accounts/entities/account.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { Category } from "../../categories/entities/category.entity";
import { ScheduledTransactionSplit } from "./scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "./scheduled-transaction-override.entity";
import { User } from "../../users/entities/user.entity";

export type FrequencyType =
  | "ONCE"
  | "DAILY"
  | "WEEKLY"
  | "BIWEEKLY"
  | "SEMIMONTHLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "YEARLY";

@Entity("scheduled_transactions")
export class ScheduledTransaction {
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
  account: Account;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "uuid", name: "payee_id", nullable: true })
  payeeId: string | null;

  @ManyToOne(() => Payee, { nullable: true })
  @JoinColumn({ name: "payee_id" })
  payee: Payee | null;

  @Column({ type: "varchar", name: "payee_name", length: 255, nullable: true })
  payeeName: string | null;

  @Column({ type: "uuid", name: "category_id", nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "category_id" })
  category: Category | null;

  @Column({ type: "decimal", precision: 20, scale: 4 })
  amount: number;

  @Column({ type: "varchar", name: "currency_code", length: 3 })
  currencyCode: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({
    type: "varchar",
    length: 20,
    default: "MONTHLY",
  })
  frequency: FrequencyType;

  @Column({ type: "date", name: "next_due_date" })
  nextDueDate: Date;

  @Column({ type: "date", name: "start_date" })
  startDate: Date;

  @Column({ type: "date", name: "end_date", nullable: true })
  endDate: Date | null;

  @Column({ type: "int", name: "occurrences_remaining", nullable: true })
  occurrencesRemaining: number | null;

  @Column({ type: "int", name: "total_occurrences", nullable: true })
  totalOccurrences: number | null;

  @Column({ name: "is_active", default: true })
  isActive: boolean;

  @Column({ name: "auto_post", default: false })
  autoPost: boolean;

  @Column({ type: "int", name: "reminder_days_before", default: 3 })
  reminderDaysBefore: number;

  @Column({ type: "date", name: "last_posted_date", nullable: true })
  lastPostedDate: Date | null;

  @Column({ name: "is_split", default: false })
  isSplit: boolean;

  @Column({ name: "is_transfer", default: false })
  isTransfer: boolean;

  @Column({ type: "uuid", name: "transfer_account_id", nullable: true })
  transferAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: "transfer_account_id" })
  transferAccount: Account | null;

  @OneToMany(
    () => ScheduledTransactionSplit,
    (split) => split.scheduledTransaction,
  )
  splits: ScheduledTransactionSplit[];

  @OneToMany(
    () => ScheduledTransactionOverride,
    (override) => override.scheduledTransaction,
  )
  overrides: ScheduledTransactionOverride[];

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
