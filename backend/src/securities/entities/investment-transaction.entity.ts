import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { Account } from '../../accounts/entities/account.entity';
import { Transaction } from '../../transactions/entities/transaction.entity';
import { Security } from './security.entity';

export enum InvestmentAction {
  BUY = 'BUY',
  SELL = 'SELL',
  DIVIDEND = 'DIVIDEND',
  INTEREST = 'INTEREST',
  CAPITAL_GAIN = 'CAPITAL_GAIN',
  SPLIT = 'SPLIT',
  TRANSFER_IN = 'TRANSFER_IN',
  TRANSFER_OUT = 'TRANSFER_OUT',
  REINVEST = 'REINVEST',
}

@Entity('investment_transactions')
export class InvestmentTransaction {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ApiProperty()
  @Column({ type: 'uuid', name: 'account_id' })
  accountId: string;

  @ApiProperty({ required: false })
  @Column({ type: 'uuid', name: 'transaction_id', nullable: true })
  transactionId: string;

  @ApiProperty({ required: false })
  @Column({ type: 'uuid', name: 'security_id', nullable: true })
  securityId: string;

  @ApiProperty({ enum: InvestmentAction })
  @Column({ type: 'varchar', length: 50 })
  action: InvestmentAction;

  @ApiProperty()
  @Column({
    type: 'date',
    name: 'transaction_date',
    transformer: {
      from: (value: string | Date): string => {
        if (!value) return value as string;
        if (typeof value === 'string') return value;
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, '0');
        const day = String(value.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      },
      to: (value: string | Date): string | Date => value,
    },
  })
  transactionDate: string;

  @ApiProperty({ example: 100, description: 'Number of shares' })
  @Column({ type: 'decimal', precision: 20, scale: 8, nullable: true })
  quantity: number;

  @ApiProperty({ example: 150.25, description: 'Price per share' })
  @Column({ type: 'decimal', precision: 20, scale: 4, nullable: true })
  price: number;

  @ApiProperty({ example: 9.99, description: 'Commission or fee' })
  @Column({ type: 'decimal', precision: 20, scale: 4, default: 0 })
  commission: number;

  @ApiProperty({ example: 15035.99, description: 'Total amount of transaction' })
  @Column({ type: 'decimal', precision: 20, scale: 4, name: 'total_amount' })
  totalAmount: number;

  @ApiProperty({ required: false })
  @Column({ type: 'text', nullable: true })
  description: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account: Account;

  @ManyToOne(() => Transaction, { nullable: true })
  @JoinColumn({ name: 'transaction_id' })
  transaction: Transaction;

  @ManyToOne(() => Security, { nullable: true })
  @JoinColumn({ name: 'security_id' })
  security: Security;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
