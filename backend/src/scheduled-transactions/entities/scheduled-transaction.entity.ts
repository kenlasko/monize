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
import { Security } from "../../securities/entities/security.entity";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";

/**
 * Re-exported rather than restated. This union used to be a second copy of the
 * one in `common/recurrence.ts`, which is where the stepping maths lives -- so
 * a frequency added to one and not the other compiled fine and stepped nowhere.
 */
import type { FrequencyType } from "../../common/recurrence";
export type { FrequencyType };

const dateStringTransformer = {
  from: (value: string | Date | null): string | null => {
    if (value === null || value === undefined) return value as null;
    if (typeof value === "string") return value;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  },
  to: (value: string | Date | null): string | Date | null => value,
};

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

  @ManyToOne(() => Category, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "category_id" })
  category: Category | null;

  @Column({ type: "decimal", precision: 24, scale: 8 })
  amount: number;

  @Column({ type: "varchar", name: "currency_code", length: 3 })
  currencyCode: string;

  // Foreign-currency entry, mirroring the same trio on Transaction. NULL for an
  // ordinary schedule (amount/currencyCode are the account currency). When set,
  // originalAmount is the fixed amount the biller charges in
  // originalCurrencyCode, exchangeRate is account-currency units per 1 unit of
  // it, and `amount` is the converted estimate -- refreshed daily from the
  // latest stored rate, and re-derived for the posting date when posted.
  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "original_amount",
    nullable: true,
    transformer: {
      to: (value: number | null): number | null => value,
      from: (value: string | null): number | null =>
        value === null ? null : Number(value),
    },
  })
  originalAmount: number | null;

  @Column({
    type: "varchar",
    name: "original_currency_code",
    length: 3,
    nullable: true,
  })
  originalCurrencyCode: string | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 10,
    name: "exchange_rate",
    default: 1,
    transformer: {
      to: (value: number | null): number | null => value,
      from: (value: string | null): number =>
        value === null ? 1 : Number(value),
    },
  })
  exchangeRate: number;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({
    type: "varchar",
    name: "reference_number",
    length: 100,
    nullable: true,
  })
  referenceNumber: string | null;

  @Column({
    type: "varchar",
    length: 20,
    default: "MONTHLY",
  })
  frequency: FrequencyType;

  @Column({
    type: "date",
    name: "next_due_date",
    transformer: dateStringTransformer,
  })
  nextDueDate: string;

  @Column({
    type: "date",
    name: "start_date",
    transformer: dateStringTransformer,
  })
  startDate: string;

  @Column({
    type: "date",
    name: "end_date",
    nullable: true,
    transformer: dateStringTransformer,
  })
  endDate: string | null;

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

  @Column({
    type: "date",
    name: "last_posted_date",
    nullable: true,
    transformer: dateStringTransformer,
  })
  lastPostedDate: string | null;

  @Column({ name: "is_split", default: false })
  isSplit: boolean;

  @Column({ name: "is_transfer", default: false })
  isTransfer: boolean;

  @Column({ type: "uuid", name: "transfer_account_id", nullable: true })
  transferAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: "transfer_account_id" })
  transferAccount: Account | null;

  @Column({ name: "is_investment", default: false })
  isInvestment: boolean;

  @Column({
    type: "varchar",
    length: 50,
    name: "investment_action",
    nullable: true,
  })
  investmentAction: InvestmentAction | null;

  @Column({ type: "uuid", name: "investment_security_id", nullable: true })
  investmentSecurityId: string | null;

  @ManyToOne(() => Security, { nullable: true })
  @JoinColumn({ name: "investment_security_id" })
  investmentSecurity: Security | null;

  @Column({
    type: "uuid",
    name: "investment_funding_account_id",
    nullable: true,
  })
  investmentFundingAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: "investment_funding_account_id" })
  investmentFundingAccount: Account | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 8,
    name: "investment_quantity",
    nullable: true,
  })
  investmentQuantity: number | null;

  @Column({
    type: "decimal",
    precision: 24,
    scale: 10,
    name: "investment_price",
    nullable: true,
  })
  investmentPrice: number | null;

  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "investment_commission",
    nullable: true,
  })
  investmentCommission: number | null;

  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "investment_total_amount",
    nullable: true,
  })
  investmentTotalAmount: number | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 10,
    name: "investment_exchange_rate",
    nullable: true,
  })
  investmentExchangeRate: number | null;

  // Currency pair the stored `investmentExchangeRate` was resolved for (issue
  // #1167). Written whenever a rate is freshly resolved, cleared with the rate;
  // posting reuses the rate only when this pair still matches the current
  // settlement pair. NULL means the pair is unknown (a pre-#1167 row, or a rate
  // round-tripped through an edit), and an unknown pair is re-resolved, not
  // trusted.
  @Column({
    type: "varchar",
    length: 3,
    name: "investment_exchange_rate_from_currency",
    nullable: true,
  })
  investmentExchangeRateFromCurrency: string | null;

  @Column({
    type: "varchar",
    length: 3,
    name: "investment_exchange_rate_to_currency",
    nullable: true,
  })
  investmentExchangeRateToCurrency: string | null;

  @Column({ type: "jsonb", name: "tag_ids", default: [] })
  tagIds: string[];

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
