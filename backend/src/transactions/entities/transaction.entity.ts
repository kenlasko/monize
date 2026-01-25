import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { Payee } from '../../payees/entities/payee.entity';
import { Category } from '../../categories/entities/category.entity';
import { TransactionSplit } from './transaction-split.entity';

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ type: 'uuid', name: 'account_id' })
  accountId: string;

  @ManyToOne(() => Account, (account) => account.transactions)
  @JoinColumn({ name: 'account_id' })
  account: Account;

  @Column({ type: 'date', name: 'transaction_date' })
  transactionDate: Date;

  @Column({ type: 'uuid', name: 'payee_id', nullable: true })
  payeeId: string | null;

  @ManyToOne(() => Payee, { nullable: true })
  @JoinColumn({ name: 'payee_id' })
  payee: Payee | null;

  @Column({ type: 'varchar', name: 'payee_name', length: 255, nullable: true })
  payeeName: string | null;

  @Column({ type: 'uuid', name: 'category_id', nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: 'category_id' })
  category: Category | null;

  @Column({ type: 'decimal', precision: 20, scale: 4 })
  amount: number;

  @Column({ type: 'varchar', name: 'currency_code', length: 3 })
  currencyCode: string;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 10,
    name: 'exchange_rate',
    default: 1,
  })
  exchangeRate: number;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', name: 'reference_number', length: 100, nullable: true })
  referenceNumber: string | null;

  @Column({ name: 'is_cleared', default: false })
  isCleared: boolean;

  @Column({ name: 'is_reconciled', default: false })
  isReconciled: boolean;

  @Column({ type: 'date', name: 'reconciled_date', nullable: true })
  reconciledDate: Date | null;

  @Column({ name: 'is_split', default: false })
  isSplit: boolean;

  @Column({ type: 'uuid', name: 'parent_transaction_id', nullable: true })
  parentTransactionId: string | null;

  @Column({ name: 'is_transfer', default: false })
  isTransfer: boolean;

  @Column({ type: 'uuid', name: 'linked_transaction_id', nullable: true })
  linkedTransactionId: string | null;

  @OneToMany(() => TransactionSplit, (split) => split.transaction)
  splits: TransactionSplit[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
