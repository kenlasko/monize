import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { Category } from "../../categories/entities/category.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { ScheduledTransaction } from "../../scheduled-transactions/entities/scheduled-transaction.entity";
import { User } from "../../users/entities/user.entity";
import { Institution } from "../../institutions/entities/institution.entity";

export enum AccountType {
  CHEQUING = "CHEQUING",
  SAVINGS = "SAVINGS",
  CREDIT_CARD = "CREDIT_CARD",
  LOAN = "LOAN",
  MORTGAGE = "MORTGAGE",
  INVESTMENT = "INVESTMENT",
  CASH = "CASH",
  LINE_OF_CREDIT = "LINE_OF_CREDIT",
  ASSET = "ASSET",
  OTHER = "OTHER",
}

export enum AccountSubType {
  INVESTMENT_CASH = "INVESTMENT_CASH",
  INVESTMENT_BROKERAGE = "INVESTMENT_BROKERAGE",
}

/** How a loan/mortgage's interest is recorded, for rate detection. */
export const INTEREST_BOOKING_MODES = ["AUTO", "SPLIT", "SEPARATE"] as const;
export type InterestBookingMode = (typeof INTEREST_BOOKING_MODES)[number];

const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity("accounts")
export class Account {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({
    type: "enum",
    enum: AccountType,
    name: "account_type",
  })
  accountType: AccountType;

  @Column()
  name: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({ name: "currency_code", length: 3 })
  currencyCode: string;

  @Column({
    type: "varchar",
    name: "account_number",
    length: 100,
    nullable: true,
  })
  accountNumber: string | null;

  // Legacy free-text institution name. Superseded by the structured
  // institution relation below; retained so historical values are not lost.
  @Column({ type: "varchar", length: 255, nullable: true })
  institution: string | null;

  @Column({ type: "uuid", name: "institution_id", nullable: true })
  institutionId: string | null;

  @ManyToOne(() => Institution, { nullable: true })
  @JoinColumn({ name: "institution_id" })
  institutionRef: Institution | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "opening_balance",
    default: 0,
    transformer: numericTransformer,
  })
  openingBalance: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "current_balance",
    default: 0,
    transformer: numericTransformer,
  })
  currentBalance: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "credit_limit",
    nullable: true,
    transformer: numericTransformer,
  })
  creditLimit: number | null;

  @Column({
    type: "decimal",
    precision: 8,
    scale: 4,
    name: "interest_rate",
    nullable: true,
    transformer: numericTransformer,
  })
  interestRate: number | null;

  // Credit card statement fields
  @Column({ type: "integer", name: "statement_due_day", nullable: true })
  statementDueDay: number | null;

  @Column({ type: "integer", name: "statement_settlement_day", nullable: true })
  statementSettlementDay: number | null;

  @Column({ name: "is_closed", default: false })
  isClosed: boolean;

  @Column({ type: "date", name: "closed_date", nullable: true })
  closedDate: Date | null;

  @Column({ name: "is_favourite", default: false })
  isFavourite: boolean;

  @Column({ type: "integer", name: "favourite_sort_order", default: 0 })
  favouriteSortOrder: number;

  @Column({ name: "exclude_from_net_worth", default: false })
  excludeFromNetWorth: boolean;

  @Column({
    type: "varchar",
    length: 50,
    name: "account_sub_type",
    nullable: true,
  })
  accountSubType: AccountSubType | null;

  @Column({ type: "uuid", name: "linked_account_id", nullable: true })
  linkedAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: "linked_account_id" })
  linkedAccount: Account | null;

  // Loan-specific fields
  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "payment_amount",
    nullable: true,
    transformer: numericTransformer,
  })
  paymentAmount: number | null;

  @Column({
    type: "varchar",
    length: 20,
    name: "payment_frequency",
    nullable: true,
  })
  paymentFrequency: string | null;

  @Column({ type: "date", name: "payment_start_date", nullable: true })
  paymentStartDate: Date | null;

  @Column({ type: "uuid", name: "source_account_id", nullable: true })
  sourceAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: "source_account_id" })
  sourceAccount: Account | null;

  @Column({ type: "uuid", name: "principal_category_id", nullable: true })
  principalCategoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "principal_category_id" })
  principalCategory: Category | null;

  @Column({ type: "uuid", name: "interest_category_id", nullable: true })
  interestCategoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "interest_category_id" })
  interestCategory: Category | null;

  // How the loan's interest is recorded, so rate detection reads it correctly:
  //   'AUTO'     -- a categorized split leg of the payment when present, else a
  //                 separate expense in the interest category (principal
  //                 transfers are never counted as interest);
  //   'SPLIT'    -- interest is only ever a categorized split leg of the payment;
  //   'SEPARATE' -- interest is a standalone expense in the interest category,
  //                 with principal booked as a transfer to the loan.
  // Optional, per-loan; defaults to AUTO (universal).
  @Column({
    type: "varchar",
    length: 16,
    name: "interest_booking_mode",
    default: "AUTO",
  })
  interestBookingMode: InterestBookingMode;

  // Category the user tags standalone overpayments (extra principal) with, so
  // the loan schedule can tell an overpayment apart from a regular installment
  // (overpayments are 100% principal). Optional, per-loan setting.
  @Column({ type: "uuid", name: "overpayment_category_id", nullable: true })
  overpaymentCategoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "overpayment_category_id" })
  overpaymentCategory: Category | null;

  // Free-text the user tags standalone overpayments with in a transaction memo
  // (its description, the linked source transaction's memo, or a split memo).
  // A case-insensitive substring match flags the payment as 100% principal,
  // usable on its own or alongside the overpayment category. Optional, per-loan.
  @Column({
    type: "varchar",
    length: 255,
    name: "overpayment_memo",
    nullable: true,
  })
  overpaymentMemo: string | null;

  // Payee whose payments count as standalone overpayments (extra principal),
  // usable on its own or alongside the overpayment category / memo. Optional,
  // per-loan setting.
  @Column({ type: "uuid", name: "overpayment_payee_id", nullable: true })
  overpaymentPayeeId: string | null;

  @ManyToOne(() => Payee, { nullable: true })
  @JoinColumn({ name: "overpayment_payee_id" })
  overpaymentPayee: Payee | null;

  // Foreign-transaction fee: the bank's foreign-currency conversion fee, applied
  // as a percentage of a foreign-entered transaction's converted amount and
  // booked as an expense split under fxFeeCategory. Only meaningful when a
  // category is also set (enforced in the service layer). Optional, per-account.
  @Column({
    type: "decimal",
    precision: 8,
    scale: 4,
    name: "fx_fee_percent",
    nullable: true,
    transformer: numericTransformer,
  })
  fxFeePercent: number | null;

  @Column({ type: "uuid", name: "fx_fee_category_id", nullable: true })
  fxFeeCategoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "fx_fee_category_id" })
  fxFeeCategory: Category | null;

  // Asset-specific fields
  @Column({ type: "uuid", name: "asset_category_id", nullable: true })
  assetCategoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "asset_category_id" })
  assetCategory: Category | null;

  @Column({ type: "date", name: "date_acquired", nullable: true })
  dateAcquired: Date | null;

  // Links an asset/other account to its financing loan or mortgage so the
  // detail page can show equity (asset value minus the loan balance).
  @Column({ type: "uuid", name: "linked_loan_account_id", nullable: true })
  linkedLoanAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: "linked_loan_account_id" })
  linkedLoanAccount: Account | null;

  // Mortgage-specific fields
  @Column({ name: "is_canadian_mortgage", default: false })
  isCanadianMortgage: boolean;

  @Column({ name: "is_variable_rate", default: false })
  isVariableRate: boolean;

  @Column({ type: "integer", name: "term_months", nullable: true })
  termMonths: number | null;

  @Column({ type: "date", name: "term_end_date", nullable: true })
  termEndDate: Date | null;

  @Column({ type: "integer", name: "amortization_months", nullable: true })
  amortizationMonths: number | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "original_principal",
    nullable: true,
    transformer: numericTransformer,
  })
  originalPrincipal: number | null;

  @Column({ type: "uuid", name: "scheduled_transaction_id", nullable: true })
  scheduledTransactionId: string | null;

  @ManyToOne(() => ScheduledTransaction, { nullable: true })
  @JoinColumn({ name: "scheduled_transaction_id" })
  scheduledTransaction: ScheduledTransaction | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @OneToMany(() => Transaction, (transaction) => transaction.account)
  transactions: Transaction[];
}
