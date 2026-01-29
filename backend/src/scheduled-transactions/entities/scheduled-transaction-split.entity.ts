import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ScheduledTransaction } from './scheduled-transaction.entity';
import { Category } from '../../categories/entities/category.entity';
import { Account } from '../../accounts/entities/account.entity';

@Entity('scheduled_transaction_splits')
export class ScheduledTransactionSplit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'scheduled_transaction_id' })
  scheduledTransactionId: string;

  @ManyToOne(() => ScheduledTransaction, (st) => st.splits, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scheduled_transaction_id' })
  scheduledTransaction: ScheduledTransaction;

  @Column({ type: 'uuid', name: 'category_id', nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: 'category_id' })
  category: Category | null;

  @Column({ type: 'uuid', name: 'transfer_account_id', nullable: true })
  transferAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: 'transfer_account_id' })
  transferAccount: Account | null;

  @Column({ type: 'decimal', precision: 20, scale: 4 })
  amount: number;

  @Column({ type: 'text', nullable: true })
  memo: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
