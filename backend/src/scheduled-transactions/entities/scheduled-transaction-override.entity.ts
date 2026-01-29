import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ScheduledTransaction } from './scheduled-transaction.entity';
import { Category } from '../../categories/entities/category.entity';

/**
 * Represents an override for a specific occurrence of a scheduled transaction.
 * Allows users to modify individual upcoming instances without changing the base template.
 */
@Entity('scheduled_transaction_overrides')
export class ScheduledTransactionOverride {
  @ApiProperty({ example: 'uuid', description: 'Unique identifier' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: 'The scheduled transaction this override applies to' })
  @Column({ type: 'uuid', name: 'scheduled_transaction_id' })
  scheduledTransactionId: string;

  @ManyToOne(() => ScheduledTransaction, (st) => st.overrides, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scheduled_transaction_id' })
  scheduledTransaction: ScheduledTransaction;

  @ApiProperty({ example: '2024-01-15', description: 'The specific date this override applies to' })
  @Column({ type: 'date', name: 'override_date' })
  overrideDate: string;

  @ApiPropertyOptional({ example: -150.00, description: 'Overridden amount (null to use base amount)' })
  @Column({ type: 'decimal', precision: 20, scale: 4, nullable: true })
  amount: number | null;

  @ApiPropertyOptional({ description: 'Overridden category ID (null to use base category)' })
  @Column({ type: 'uuid', name: 'category_id', nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: 'category_id' })
  category: Category | null;

  @ApiPropertyOptional({ description: 'Overridden description' })
  @Column({ type: 'text', nullable: true })
  description: string | null;

  @ApiPropertyOptional({ description: 'Whether this override uses splits (overrides base isSplit)' })
  @Column({ type: 'boolean', name: 'is_split', nullable: true })
  isSplit: boolean | null;

  @ApiPropertyOptional({ description: 'JSON array of split overrides' })
  @Column({ type: 'jsonb', nullable: true })
  splits: OverrideSplit[] | null;

  @ApiProperty({ description: 'When this override was created' })
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ApiProperty({ description: 'When this override was last updated' })
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/**
 * Structure for split overrides stored in the JSON column
 */
export interface OverrideSplit {
  categoryId: string | null;
  amount: number;
  memo?: string | null;
}
