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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @OneToMany(() => Transaction, (transaction) => transaction.account)
  transactions: Transaction[];
}
