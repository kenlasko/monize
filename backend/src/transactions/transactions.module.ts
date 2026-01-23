import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transaction } from './entities/transaction.entity';

// Stub TransactionsModule - full implementation will be added later
@Module({
  imports: [TypeOrmModule.forFeature([Transaction])],
  providers: [],
  controllers: [],
  exports: [],
})
export class TransactionsModule {}
