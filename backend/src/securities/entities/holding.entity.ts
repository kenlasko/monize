import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn, Unique } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { Account } from '../../accounts/entities/account.entity';
import { Security } from './security.entity';

@Entity('holdings')
@Unique(['accountId', 'securityId'])
export class Holding {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column({ type: 'uuid', name: 'account_id' })
  accountId: string;

  @ApiProperty()
  @Column({ type: 'uuid', name: 'security_id' })
  securityId: string;

  @ApiProperty({ example: 100, description: 'Number of shares/units held' })
  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  quantity: number;

  @ApiProperty({ example: 150.25, description: 'Average cost per share' })
  @Column({ type: 'decimal', precision: 20, scale: 4, name: 'average_cost', nullable: true })
  averageCost: number;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account: Account;

  @ManyToOne(() => Security)
  @JoinColumn({ name: 'security_id' })
  security: Security;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
