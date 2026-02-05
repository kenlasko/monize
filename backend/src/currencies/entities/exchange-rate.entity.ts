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
import { Currency } from './currency.entity';

@Entity('exchange_rates')
@Unique(['fromCurrency', 'toCurrency', 'rateDate'])
export class ExchangeRate {
  @ApiProperty()
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @ApiProperty({ example: 'USD' })
  @Column({ type: 'varchar', length: 3, name: 'from_currency' })
  fromCurrency: string;

  @ApiProperty({ example: 'CAD' })
  @Column({ type: 'varchar', length: 3, name: 'to_currency' })
  toCurrency: string;

  @ApiProperty({ example: 1.365 })
  @Column({ type: 'decimal', precision: 20, scale: 10 })
  rate: number;

  @ApiProperty()
  @Column({ type: 'date', name: 'rate_date' })
  rateDate: Date;

  @ApiProperty({ required: false })
  @Column({ type: 'varchar', length: 50, nullable: true })
  source: string;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'from_currency', referencedColumnName: 'code' })
  fromCurrencyRef: Currency;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'to_currency', referencedColumnName: 'code' })
  toCurrencyRef: Currency;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
