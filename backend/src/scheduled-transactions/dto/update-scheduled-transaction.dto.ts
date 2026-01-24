import { PartialType } from '@nestjs/mapped-types';
import { CreateScheduledTransactionDto } from './create-scheduled-transaction.dto';

export class UpdateScheduledTransactionDto extends PartialType(
  CreateScheduledTransactionDto,
) {}
