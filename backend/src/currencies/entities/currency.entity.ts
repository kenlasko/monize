import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

@Entity('currencies')
export class Currency {
  @ApiProperty({ example: 'CAD' })
  @PrimaryColumn({ type: 'varchar', length: 3 })
  code: string;

  @ApiProperty({ example: 'Canadian Dollar' })
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @ApiProperty({ example: '$' })
  @Column({ type: 'varchar', length: 10 })
  symbol: string;

  @ApiProperty({ example: 2 })
  @Column({ type: 'smallint', name: 'decimal_places', default: 2 })
  decimalPlaces: number;

  @ApiProperty({ example: true })
  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive: boolean;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
