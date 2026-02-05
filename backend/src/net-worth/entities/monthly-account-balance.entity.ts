import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';

@Entity('monthly_account_balances')
@Unique(['accountId', 'month'])
export class MonthlyAccountBalance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ type: 'uuid', name: 'account_id' })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account: Account;

  @Column({ type: 'date' })
  month: Date;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    default: 0,
  })
  balance: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    name: 'market_value',
    nullable: true,
  })
  marketValue: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
