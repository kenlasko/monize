import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @OneToMany(() => Transaction, (transaction) => transaction.account)
  transactions: Transaction[];
}
