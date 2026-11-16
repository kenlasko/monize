import { IsString, IsOptional, IsBoolean, MaxLength } from "class-validator";

export class DeleteDataDto {
  @IsString()
  @MaxLength(128)
  @IsOptional()
  password?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  oidcIdToken?: string;

  // Always deleted: transactions, splits, tags, scheduled transactions,
  // investment transactions, holdings, security prices, securities,
  // monthly account balances, budgets, transaction rules, financial
  // institutions

  @IsBoolean()
  @IsOptional()
  deleteAccounts?: boolean;

  @IsBoolean()
  @IsOptional()
  deleteCategories?: boolean;

  @IsBoolean()
  @IsOptional()
  deletePayees?: boolean;

  @IsBoolean()
  @IsOptional()
  deleteExchangeRates?: boolean;
}
