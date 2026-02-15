import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsUUID,
  IsOptional,
  IsArray,
  ValidateNested,
  MaxLength,
  IsNotEmpty,
  IsIn,
} from "class-validator";
import { Type } from "class-transformer";

export class ParseQifDto {
  @ApiProperty({ description: "QIF file content as string" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000) // ~10MB limit, matches Express body parser
  content: string;
}

export class CategoryMappingDto {
  @ApiProperty({ description: "Original category name from QIF" })
  @IsString()
  @MaxLength(100)
  originalName: string;

  @ApiPropertyOptional({ description: "Existing category ID to map to" })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: "Create new category with this name" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  createNew?: string;

  @ApiPropertyOptional({ description: "Parent category ID for new category" })
  @IsOptional()
  @IsUUID()
  parentCategoryId?: string;

  @ApiPropertyOptional({
    description: "Whether this category represents a loan payment",
  })
  @IsOptional()
  isLoanCategory?: boolean;

  @ApiPropertyOptional({
    description: "Existing loan account ID to transfer to",
  })
  @IsOptional()
  @IsUUID()
  loanAccountId?: string;

  @ApiPropertyOptional({ description: "Name for new loan account to create" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  createNewLoan?: string;

  @ApiPropertyOptional({
    description: "Initial loan amount for new loan account",
  })
  @IsOptional()
  newLoanAmount?: number;

  @ApiPropertyOptional({ description: "Institution name for new loan account" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  newLoanInstitution?: string;
}

export class AccountMappingDto {
  @ApiProperty({ description: "Original transfer account name from QIF" })
  @IsString()
  @MaxLength(100)
  originalName: string;

  @ApiPropertyOptional({ description: "Existing account ID to map to" })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({ description: "Create new account with this name" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  createNew?: string;

  @ApiPropertyOptional({ description: "Account type for new account" })
  @IsOptional()
  @IsIn([
    "CHEQUING",
    "SAVINGS",
    "CREDIT_CARD",
    "LOAN",
    "MORTGAGE",
    "INVESTMENT",
    "CASH",
    "LINE_OF_CREDIT",
    "ASSET",
    "OTHER",
  ])
  accountType?: string;

  @ApiPropertyOptional({
    description: "Currency code for new account (e.g., USD, CAD)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currencyCode?: string;
}

export class SecurityMappingDto {
  @ApiProperty({ description: "Original security name/symbol from QIF" })
  @IsString()
  @MaxLength(100)
  originalName: string;

  @ApiPropertyOptional({ description: "Existing security ID to map to" })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiPropertyOptional({ description: "Create new security with this symbol" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  createNew?: string;

  @ApiPropertyOptional({ description: "Full name for new security" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  securityName?: string;

  @ApiPropertyOptional({
    description:
      "Security type for new security (STOCK, ETF, MUTUAL_FUND, BOND, GIC, CASH, OTHER)",
  })
  @IsOptional()
  @IsIn(["STOCK", "ETF", "MUTUAL_FUND", "BOND", "GIC", "CASH", "OTHER"])
  securityType?: string;

  @ApiPropertyOptional({
    description: "Exchange for new security (e.g., TSX, NYSE, NASDAQ)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  exchange?: string;

  @ApiPropertyOptional({
    description: "Currency code for new security (e.g., USD, CAD)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currencyCode?: string;
}

export class ImportQifDto {
  @ApiProperty({ description: "QIF file content as string" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000) // ~10MB limit, matches Express body parser
  content: string;

  @ApiProperty({ description: "Account ID to import transactions into" })
  @IsUUID()
  accountId: string;

  @ApiProperty({ description: "Category mappings", type: [CategoryMappingDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CategoryMappingDto)
  categoryMappings: CategoryMappingDto[];

  @ApiProperty({
    description: "Account mappings for transfers",
    type: [AccountMappingDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AccountMappingDto)
  accountMappings: AccountMappingDto[];

  @ApiPropertyOptional({
    description: "Security mappings for investment transactions",
    type: [SecurityMappingDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SecurityMappingDto)
  securityMappings?: SecurityMappingDto[];

  @ApiPropertyOptional({
    description:
      "Date format to use for parsing (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYY-DD-MM)",
  })
  @IsOptional()
  @IsIn(["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD", "YYYY-DD-MM"])
  dateFormat?: string;
}

export class ParsedQifResponseDto {
  @ApiProperty()
  accountType: string;

  @ApiProperty()
  transactionCount: number;

  @ApiProperty({ type: [String] })
  categories: string[];

  @ApiProperty({ type: [String] })
  transferAccounts: string[];

  @ApiProperty({
    type: [String],
    description: "Unique securities found in investment transactions",
  })
  securities: string[];

  @ApiProperty()
  dateRange: {
    start: string;
    end: string;
  };

  @ApiProperty({ description: "Detected date format" })
  detectedDateFormat: string;

  @ApiProperty({ type: [String], description: "Sample dates from the file" })
  sampleDates: string[];

  @ApiPropertyOptional({
    description: "Opening balance from QIF file, if present",
  })
  openingBalance: number | null;

  @ApiPropertyOptional({ description: "Date of the opening balance record" })
  openingBalanceDate: string | null;
}

export class ImportResultDto {
  @ApiProperty()
  imported: number;

  @ApiProperty()
  skipped: number;

  @ApiProperty()
  errors: number;

  @ApiProperty({ type: [String] })
  errorMessages: string[];

  @ApiProperty()
  categoriesCreated: number;

  @ApiProperty()
  accountsCreated: number;

  @ApiProperty()
  payeesCreated: number;

  @ApiProperty()
  securitiesCreated: number;

  @ApiPropertyOptional({
    description:
      "Maps of created entity original names to their new IDs (for bulk import coordination)",
  })
  createdMappings?: {
    categories: Record<string, string>;
    accounts: Record<string, string>;
    loans: Record<string, string>;
    securities: Record<string, string>;
  };
}
