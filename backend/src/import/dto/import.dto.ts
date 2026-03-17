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
  IsBoolean,
  Matches,
  IsNumber,
  IsInt,
  Min,
  Max,
  ArrayMaxSize,
} from "class-validator";
import { Type } from "class-transformer";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

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
  @SanitizeHtml()
  originalName: string;

  @ApiPropertyOptional({ description: "Existing category ID to map to" })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: "Create new category with this name" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  createNew?: string;

  @ApiPropertyOptional({ description: "Parent category ID for new category" })
  @IsOptional()
  @IsUUID()
  parentCategoryId?: string;

  @ApiPropertyOptional({
    description:
      "Name for a new parent category to create (used when parent does not exist yet)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  createNewParentCategoryName?: string;

  @ApiPropertyOptional({
    description: "Whether this category represents a loan payment",
  })
  @IsOptional()
  @IsBoolean()
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
  @SanitizeHtml()
  createNewLoan?: string;

  @ApiPropertyOptional({
    description: "Initial loan amount for new loan account",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000_000)
  newLoanAmount?: number;

  @ApiPropertyOptional({ description: "Institution name for new loan account" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  newLoanInstitution?: string;
}

export class AccountMappingDto {
  @ApiProperty({ description: "Original transfer account name from QIF" })
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  originalName: string;

  @ApiPropertyOptional({ description: "Existing account ID to map to" })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({ description: "Create new account with this name" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
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
  @SanitizeHtml()
  originalName: string;

  @ApiPropertyOptional({ description: "Existing security ID to map to" })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiPropertyOptional({ description: "Create new security with this symbol" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @SanitizeHtml()
  createNew?: string;

  @ApiPropertyOptional({ description: "Full name for new security" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
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
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CategoryMappingDto)
  categoryMappings: CategoryMappingDto[];

  @ApiProperty({
    description: "Account mappings for transfers",
    type: [AccountMappingDto],
  })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AccountMappingDto)
  accountMappings: AccountMappingDto[];

  @ApiPropertyOptional({
    description: "Security mappings for investment transactions",
    type: [SecurityMappingDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SecurityMappingDto)
  securityMappings?: SecurityMappingDto[];

  @ApiPropertyOptional({
    description:
      "Date format to use for parsing (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYY-DD-MM)",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[YDMW/\-.]+$/, {
    message:
      "dateFormat must contain only date pattern characters (Y, M, D) and separators (/, -, .)",
  })
  @MaxLength(20)
  dateFormat?: string;
}

export class ParsedQifResponseDto {
  @ApiProperty()
  accountType: string;

  @ApiPropertyOptional({
    description: "Account name from QIF file, if present",
  })
  accountName: string;

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

// --- Multi-account QIF DTOs ---

export class ImportQifMultiAccountDto {
  @ApiProperty({ description: "QIF file content as string" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000)
  content: string;

  @ApiProperty({
    description: "Currency code for new accounts (e.g., USD, CAD)",
  })
  @IsString()
  @MaxLength(3)
  currencyCode: string;

  @ApiPropertyOptional({
    description:
      "Date format to use for parsing (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYY-DD-MM)",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[YDMW/\-.]+$/, {
    message:
      "dateFormat must contain only date pattern characters (Y, M, D) and separators (/, -, .)",
  })
  @MaxLength(20)
  dateFormat?: string;

  @ApiPropertyOptional({
    description: "Security mappings for investment transactions",
    type: [SecurityMappingDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SecurityMappingDto)
  securityMappings?: SecurityMappingDto[];
}

export class ParsedQifMultiAccountResponseDto {
  @ApiProperty({ description: "Whether this is a multi-account QIF file" })
  isMultiAccount: boolean;

  @ApiProperty({
    description: "Category definitions from !Type:Cat sections",
  })
  categoryDefs: Array<{
    name: string;
    description: string;
    isIncome: boolean;
  }>;

  @ApiProperty({
    description: "Tag definitions from !Type:Tag sections",
  })
  tagDefs: Array<{
    name: string;
    description: string;
  }>;

  @ApiProperty({ description: "Account blocks found in the file" })
  accounts: Array<{
    accountName: string;
    accountType: string;
    transactionCount: number;
    dateRange: { start: string; end: string };
  }>;

  @ApiProperty()
  totalTransactionCount: number;

  @ApiProperty({
    type: [String],
    description: "Unique securities found across investment account blocks",
  })
  securities: string[];

  @ApiProperty({ description: "Detected date format" })
  detectedDateFormat: string;

  @ApiProperty({ type: [String], description: "Sample dates from the file" })
  sampleDates: string[];
}

// --- OFX DTOs ---

export class ParseOfxDto {
  @ApiProperty({ description: "OFX file content as string" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000)
  content: string;
}

export class ImportOfxDto {
  @ApiProperty({ description: "OFX file content as string" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000)
  content: string;

  @ApiProperty({ description: "Account ID to import transactions into" })
  @IsUUID()
  accountId: string;

  @ApiProperty({ description: "Category mappings", type: [CategoryMappingDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CategoryMappingDto)
  categoryMappings: CategoryMappingDto[];

  @ApiProperty({
    description: "Account mappings for transfers",
    type: [AccountMappingDto],
  })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AccountMappingDto)
  accountMappings: AccountMappingDto[];

  @ApiPropertyOptional({
    description: "Date format override",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[YDMW/\-.]+$/, {
    message:
      "dateFormat must contain only date pattern characters (Y, M, D) and separators (/, -, .)",
  })
  @MaxLength(20)
  dateFormat?: string;
}

// --- CSV DTOs ---

export class CsvColumnMappingConfigDto {
  @ApiProperty({ description: "Column index for date field" })
  @IsInt()
  @Min(0)
  @Max(100)
  date: number;

  @ApiPropertyOptional({ description: "Column index for single amount field" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  amount?: number;

  @ApiPropertyOptional({
    description: "Column index for debit amount (used with credit)",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  debit?: number;

  @ApiPropertyOptional({
    description: "Column index for credit amount (used with debit)",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  credit?: number;

  @ApiPropertyOptional({ description: "Column index for payee field" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  payee?: number;

  @ApiPropertyOptional({ description: "Column index for category field" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  category?: number;

  @ApiPropertyOptional({ description: "Column index for subcategory field" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  subcategory?: number;

  @ApiPropertyOptional({ description: "Column index for memo field" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  memo?: number;

  @ApiPropertyOptional({
    description: "Column index for reference number field",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  referenceNumber?: number;

  @ApiProperty({ description: "Date format for parsing" })
  @IsString()
  @Matches(/^[YDMW/\-.]+$/, {
    message:
      "dateFormat must contain only date pattern characters (Y, M, D) and separators (/, -, .)",
  })
  @MaxLength(20)
  dateFormat: string;

  @ApiPropertyOptional({
    description:
      "Reverse the sign of single-amount values (for credit card CSVs where debits are positive)",
  })
  @IsOptional()
  @IsBoolean()
  reverseSign?: boolean;

  @ApiPropertyOptional({
    description:
      "Column index for transaction type indicator (income/expense/transfer)",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  amountTypeColumn?: number;

  @ApiPropertyOptional({
    description:
      "Values indicating income (force amount positive), case-insensitive match",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  incomeValues?: string[];

  @ApiPropertyOptional({
    description:
      "Values indicating expense (negate amount), case-insensitive match",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  expenseValues?: string[];

  @ApiPropertyOptional({
    description:
      "Values indicating transfer out (negate + mark as transfer), case-insensitive match",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  transferOutValues?: string[];

  @ApiPropertyOptional({
    description:
      "Values indicating transfer in (positive + mark as transfer), case-insensitive match",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  transferInValues?: string[];

  @ApiPropertyOptional({
    description:
      "Column index for transfer account name (defaults to category column if not set)",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  transferAccountColumn?: number;

  @ApiProperty({ description: "Whether the CSV has a header row" })
  @IsBoolean()
  hasHeader: boolean;

  @ApiProperty({ description: "CSV delimiter character" })
  @IsString()
  @MaxLength(1)
  delimiter: string;
}

export class CsvTransferRuleDto {
  @ApiProperty({ description: "Match type: payee or category" })
  @IsIn(["payee", "category"])
  type: "payee" | "category";

  @ApiProperty({ description: "Pattern to match (case-insensitive contains)" })
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  pattern: string;

  @ApiProperty({ description: "Transfer account name" })
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  accountName: string;
}

export class ParseCsvHeadersDto {
  @ApiProperty({ description: "CSV file content as string" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000)
  content: string;

  @ApiPropertyOptional({
    description: "CSV delimiter (auto-detected if omitted)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1)
  delimiter?: string;
}

export class ParseCsvDto {
  @ApiProperty({ description: "CSV file content as string" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000)
  content: string;

  @ApiProperty({
    description: "Column mapping configuration",
    type: CsvColumnMappingConfigDto,
  })
  @ValidateNested()
  @Type(() => CsvColumnMappingConfigDto)
  columnMapping: CsvColumnMappingConfigDto;

  @ApiPropertyOptional({
    description: "Transfer detection rules",
    type: [CsvTransferRuleDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CsvTransferRuleDto)
  transferRules?: CsvTransferRuleDto[];
}

export class ImportCsvDto {
  @ApiProperty({ description: "CSV file content as string" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000)
  content: string;

  @ApiProperty({ description: "Account ID to import transactions into" })
  @IsUUID()
  accountId: string;

  @ApiProperty({
    description: "Column mapping configuration",
    type: CsvColumnMappingConfigDto,
  })
  @ValidateNested()
  @Type(() => CsvColumnMappingConfigDto)
  columnMapping: CsvColumnMappingConfigDto;

  @ApiPropertyOptional({
    description: "Transfer detection rules",
    type: [CsvTransferRuleDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CsvTransferRuleDto)
  transferRules?: CsvTransferRuleDto[];

  @ApiProperty({ description: "Category mappings", type: [CategoryMappingDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CategoryMappingDto)
  categoryMappings: CategoryMappingDto[];

  @ApiProperty({
    description: "Account mappings for transfers",
    type: [AccountMappingDto],
  })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AccountMappingDto)
  accountMappings: AccountMappingDto[];

  @ApiPropertyOptional({
    description: "Date format override",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[YDMW/\-.]+$/, {
    message:
      "dateFormat must contain only date pattern characters (Y, M, D) and separators (/, -, .)",
  })
  @MaxLength(20)
  dateFormat?: string;
}

// --- CSV Column Mapping CRUD DTOs ---

export class CreateColumnMappingDto {
  @ApiProperty({ description: "User-defined name for this mapping" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiProperty({
    description: "Column mapping configuration",
    type: CsvColumnMappingConfigDto,
  })
  @ValidateNested()
  @Type(() => CsvColumnMappingConfigDto)
  columnMappings: CsvColumnMappingConfigDto;

  @ApiPropertyOptional({
    description: "Transfer detection rules",
    type: [CsvTransferRuleDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CsvTransferRuleDto)
  transferRules?: CsvTransferRuleDto[];
}

export class UpdateColumnMappingDto {
  @ApiPropertyOptional({ description: "Updated name" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name?: string;

  @ApiPropertyOptional({
    description: "Updated column mapping configuration",
    type: CsvColumnMappingConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CsvColumnMappingConfigDto)
  columnMappings?: CsvColumnMappingConfigDto;

  @ApiPropertyOptional({
    description: "Updated transfer detection rules",
    type: [CsvTransferRuleDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CsvTransferRuleDto)
  transferRules?: CsvTransferRuleDto[];
}

// --- Response DTOs ---

export class CsvHeadersResponseDto {
  @ApiProperty({ type: [String] })
  headers: string[];

  @ApiProperty({ description: "Sample data rows" })
  sampleRows: string[][];

  @ApiProperty()
  rowCount: number;
}

export class ColumnMappingResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  columnMappings: Record<string, unknown>;

  @ApiProperty()
  transferRules: Record<string, unknown>[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
