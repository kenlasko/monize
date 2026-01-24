import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Unique,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { Category } from '../../categories/entities/category.entity';

@Entity('payees')
@Unique(['userId', 'name'])
export class Payee {
  @ApiProperty({ example: 'c5f5d5f0-1234-4567-890a-123456789abc' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ example: 'user-uuid' })
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ApiProperty({ example: 'Starbucks', description: 'Name of the payee' })
  @Column({ type: 'varchar', length: 255 })
  name: string;

  @ApiProperty({ example: 'category-uuid', required: false, description: 'Default category for transactions with this payee' })
  @Column({ type: 'uuid', name: 'default_category_id', nullable: true })
  defaultCategoryId: string;

  @ApiProperty({ example: 'Local coffee shop on Main Street', required: false })
  @Column({ type: 'text', nullable: true })
  notes: string;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: 'default_category_id' })
  defaultCategory: Category;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
