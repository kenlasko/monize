import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

@Entity('securities')
export class Security {
  @ApiProperty({ example: 'c5f5d5f0-1234-4567-890a-123456789abc' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ example: 'AAPL', description: 'Stock symbol or ticker' })
  @Column({ type: 'varchar', length: 20, unique: true })
  symbol: string;

  @ApiProperty({ example: 'Apple Inc.', description: 'Full name of the security' })
  @Column({ type: 'varchar', length: 255 })
  name: string;

  @ApiProperty({ example: 'STOCK', description: 'Type of security' })
  @Column({ type: 'varchar', length: 50, name: 'security_type', nullable: true })
  securityType: string;

  @ApiProperty({ example: 'NASDAQ', description: 'Stock exchange' })
  @Column({ type: 'varchar', length: 50, nullable: true })
  exchange: string;

  @ApiProperty({ example: 'USD' })
  @Column({ type: 'varchar', length: 3, name: 'currency_code' })
  currencyCode: string;

  @ApiProperty({ example: true })
  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
