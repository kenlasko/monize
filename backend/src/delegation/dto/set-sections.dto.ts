import { IsBoolean, IsOptional } from "class-validator";

/**
 * 3A: owner toggles a delegate's READ access to whole app sections
 * (Bills & Deposits, Investments, Budgets, Reports, AI). Omitted fields are
 * left unchanged.
 */
export class SetSectionsDto {
  @IsOptional() @IsBoolean() billsCanRead?: boolean;
  @IsOptional() @IsBoolean() investmentsCanRead?: boolean;
  @IsOptional() @IsBoolean() budgetsCanRead?: boolean;
  @IsOptional() @IsBoolean() reportsCanRead?: boolean;
  @IsOptional() @IsBoolean() aiCanRead?: boolean;
}
