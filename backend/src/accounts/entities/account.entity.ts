import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Transaction } from '../../transactions/entities/transaction.entity';
import { Category } from '../../categories/entities/category.entity';
import { ScheduledTransaction } from '../../scheduled-transactions/entities/scheduled-transaction.entity';

export enum AccountType {
  CHEQUING = 'CHEQUING',
  SAVINGS = 'SAVINGS',
  CREDIT_CARD = 'CREDIT_CARD',
  LOAN = 'LOAN',
  MORTGAGE = 'MORTGAGE',
  RRSP = 'RRSP',
  TFSA = 'TFSA',
  RESP = 'RESP',
  INVESTMENT = 'INVESTMENT',
  CASH = 'CASH',
  LINE_OF_CREDIT = 'LINE_OF_CREDIT',
  ASSET = 'ASSET',
  OTHER = 'OTHER',
}

export enum AccountSubType {
  INVESTMENT_CASH = 'INVESTMENT_CASH',
  INVESTMENT_BROKERAGE = 'INVESTMENT_BROKERAGE',
}

@Entity('accounts')
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: AccountType,
    name: 'account_type',
  })
  accountType: AccountType;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'currency_code', length: 3 })
  currencyCode: string;

  @Column({ type: 'varchar', name: 'account_number', length: 100, nullable: true })
  accountNumber: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  institution: string | null;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    name: 'opening_balance',
    default: 0,
  })
  openingBalance: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    name: 'current_balance',
    default: 0,
  })
  currentBalance: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    name: 'credit_limit',
    nullable: true,
  })
  creditLimit: number | null;

  @Column({
    type: 'decimal',
    precision: 8,
    scale: 4,
    name: 'interest_rate',
    nullable: true,
  })
  interestRate: number | null;

  @Column({ name: 'is_closed', default: false })
  isClosed: boolean;

  @Column({ type: 'date', name: 'closed_date', nullable: true })
  closedDate: Date | null;

  @Column({ name: 'is_favourite', default: false })
  isFavourite: boolean;

  @Column({
    type: 'varchar',
    length: 50,
    name: 'account_sub_type',
    nullable: true,
  })
  accountSubType: AccountSubType | null;

  @Column({ type: 'uuid', name: 'linked_account_id', nullable: true })
  linkedAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: 'linked_account_id' })
  linkedAccount: Account | null;

  // Loan-specific fields
  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    name: 'payment_amount',
    nullable: true,
  })
  paymentAmount: number | null;

  @Column({
    type: 'varchar',
    length: 20,
    name: 'payment_frequency',
    nullable: true,
  })
  paymentFrequency: string | null;

  @Column({ type: 'date', name: 'payment_start_date', nullable: true })
  paymentStartDate: Date | null;

  @Column({ type: 'uuid', name: 'source_account_id', nullable: true })
  sourceAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: 'source_account_id' })
  sourceAccount: Account | null;

  @Column({ type: 'uuid', name: 'principal_category_id', nullable: true })
  principalCategoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: 'principal_category_id' })
  principalCategory: Category | null;

  @Column({ type: 'uuid', name: 'interest_category_id', nullable: true })
  interestCategoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: 'interest_category_id' })
  interestCategory: Category | null;

  // Asset-specific fields
  @Column({ type: 'uuid', name: 'asset_category_id', nullable: true })
  assetCategoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: 'asset_category_id' })
  assetCategory: Category | null;

  // Mortgage-specific fields
  @Column({ name: 'is_canadian_mortgage', default: false })
  isCanadianMortgage: boolean;

  @Column({ name: 'is_variable_rate', default: false })
  isVariableRate: boolean;

  @Column({ type: 'integer', name: 'term_months', nullable: true })
  termMonths: number | null;

  @Column({ type: 'date', name: 'term_end_date', nullable: true })
  termEndDate: Date | null;

  @Column({ type: 'integer', name: 'amortization_months', nullable: true })
  amortizationMonths: number | null;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    name: 'original_principal',
    nullable: true,
  })
  originalPrincipal: number | null;

  @Column({ type: 'uuid', name: 'scheduled_transaction_id', nullable: true })
  scheduledTransactionId: string | null;

  @ManyToOne(() => ScheduledTransaction, { nullable: true })
  @JoinColumn({ name: 'scheduled_transaction_id' })
  scheduledTransaction: ScheduledTransaction | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @OneToMany(() => Transaction, (transaction) => transaction.account)
  transactions: Transaction[];
}
