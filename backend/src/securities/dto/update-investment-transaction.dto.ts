import { PartialType } from "@nestjs/swagger";
import { CreateInvestmentTransactionDto } from "./create-investment-transaction.dto";

export class UpdateInvestmentTransactionDto extends PartialType(
  CreateInvestmentTransactionDto,
) {}
