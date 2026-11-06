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
  IsEnum,
} from "class-validator";
import { Type } from "class-transformer";
import { AccountType } from "../../accounts/entities/account.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import type { CsvInvestmentSummary } from "../csv-parser";

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
      "Name for a new parent category to create (used when parent does not exist yet). " +
      "A colon-delimited path (e.g. Housing:Mortgage) finds or creates every level.",
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
    description: "Account type for new loan account (LOAN or MORTGAGE)",
  })
  @IsOptional()
  @IsIn(["LOAN", "MORTGAGE"])
  newLoanType?: string;

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
    "CRYPTO",
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
  @IsIn([
    "STOCK",
    "ETF",
    "MUTUAL_FUND",
    "BOND",
    "OPTION",
    "GIC",
    "CRYPTO",
    "CASH",
    "OTHER",
  ])
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

export class CsvUnreadableDateRowDto {
  @ApiProperty({
    description:
      "The line of the file the row starts on, 1-based with the header",
  })
  rowNumber: number;

  @ApiProperty({
    description: "The date field as the file gave it, empty when it has none",
  })
  rawDate: string;
}

export class CsvUnreadableDatesDto {
  @ApiProperty({ description: "How many rows have a date that cannot be read" })
  count: number;

  @ApiProperty({
    type: [CsvUnreadableDateRowDto],
    description: "The first of them in file order (at most SKIPPED_ROWS_LIMIT)",
  })
  rows: CsvUnreadableDateRowDto[];
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

  @ApiPropertyOptional({
    description:
      "Investment-mode CSV parse summary: per-action counts, cash fallbacks, and rejected rows",
  })
  investmentSummary?: CsvInvestmentSummary;

  @ApiPropertyOptional({
    type: () => CsvUnreadableDatesDto,
    description:
      "CSV parses only: the rows the import will leave out because their date cannot be read under the mapping's date format",
  })
  unreadableDates?: CsvUnreadableDatesDto;
}

/**
 * Why an import left a row of the file out: `alreadyImported` when the account
 * already holds the row's bank id (OFX `FITID`), `duplicateTransfer` when the
 * transfer is already recorded between the same two accounts,
 * `unreadableDate` when a CSV row's date cannot be read under the mapping's
 * date format (or the row has none). The rest are an investment-mode CSV row
 * whose action needs data it does not carry (`InvestmentRejectReason`):
 * `missingSecurity`, `missingQuantity`, `missingAmount`, `missingProceeds`
 * (a sell with neither price nor amount), `missingSplitRatio`.
 */
export const IMPORT_SKIP_REASONS = [
  "alreadyImported",
  "duplicateTransfer",
  "unreadableDate",
  "missingSecurity",
  "missingQuantity",
  "missingAmount",
  "missingProceeds",
  "missingSplitRatio",
] as const;

export type ImportSkipReason = (typeof IMPORT_SKIP_REASONS)[number];

export class ImportSkippedRowDto {
  @ApiProperty({
    description:
      "The row's date, YYYY-MM-DD; empty when the reason is `unreadableDate`, whose `rawDate` carries the file's text",
  })
  date: string;

  @ApiProperty({ description: "The row's amount as the file gave it" })
  amount: number;

  @ApiProperty({
    description: "The currency of the account the row was imported into",
  })
  currencyCode: string;

  @ApiProperty({ description: "The row's payee text, empty when it has none" })
  payee: string;

  @ApiProperty({ enum: IMPORT_SKIP_REASONS })
  reason: ImportSkipReason;

  @ApiPropertyOptional({
    description:
      "The line of the file the row starts on, 1-based with the header; set for a CSV row the parse left out (`unreadableDate` and the investment-mode reasons)",
  })
  rowNumber?: number;

  @ApiPropertyOptional({
    description:
      "The date field as the file gave it, empty when it has none; set for `unreadableDate`",
  })
  rawDate?: string;
}

/**
 * How many skipped rows the result names. `skipped` keeps the full count; the
 * import screen shows at most this many and counts the rest.
 */
export const SKIPPED_ROWS_LIMIT = 50;

export class ImportResultDto {
  @ApiProperty()
  imported: number;

  @ApiProperty()
  skipped: number;

  @ApiProperty({
    type: [ImportSkippedRowDto],
    description: `The first ${SKIPPED_ROWS_LIMIT} rows counted in \`skipped\`, in the order the import reached them, so a person can see which rows of the file were not written and why. \`skipped\` keeps the full count.`,
  })
  skippedRows: ImportSkippedRowDto[];

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

  @ApiPropertyOptional({
    description:
      "IDs of loan/mortgage accounts that were created or received transactions during import and do not yet have scheduled payments configured",
  })
  loanAccountsNeedingSetup?: Array<{
    accountId: string;
    accountName: string;
    accountType: string;
    currencyCode: string;
  }>;

  @ApiPropertyOptional({
    description:
      "Number of imported share acquisitions of a bond-program security stored without a series (the file names none and none was on sale on the date, or the action has no purchase date): the bond lots report such a row until its series is chosen. Absent when zero.",
  })
  bondRowsWithoutSeries?: number;

  @ApiPropertyOptional({
    description:
      "Number of Quicken merged split transfers that were automatically removed during import",
  })
  mergedTransfersDeleted?: number;

  @ApiPropertyOptional({
    description:
      "Number of imported transactions that one of the user's transaction rules (trigger: import) changed. Absent when no rule changed a row.",
  })
  transactionsChangedByRules?: number;

  @ApiPropertyOptional({
    type: [String],
    description:
      "Warnings about suspect transactions that may need manual review (e.g. potential Quicken merged transfers that could not be reliably auto-removed)",
  })
  warnings?: string[];
}

// --- Multi-account QIF DTOs ---

export class QifAccountTypeChoiceDto {
  @ApiProperty({
    description:
      "Account name exactly as the file spells it, for an account whose type the file leaves unknown",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  accountName: string;

  @ApiProperty({ enum: AccountType, description: "Type to create it as" })
  @IsEnum(AccountType)
  accountType: AccountType;
}

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

  @ApiPropertyOptional({
    description:
      "The user's type for each account the file leaves without one; a type the file names is kept",
    type: [QifAccountTypeChoiceDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => QifAccountTypeChoiceDto)
  accountTypes?: QifAccountTypeChoiceDto[];
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

  @ApiProperty({
    description:
      "Account blocks found in the file; accountType is null when the file names no type QIF defines",
  })
  accounts: Array<{
    accountName: string;
    accountType: string | null;
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

export class CsvActionKeywordsDto {
  @ApiPropertyOptional({ description: "Values classified as buys" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  buy?: string[];

  @ApiPropertyOptional({ description: "Values classified as sells" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  sell?: string[];

  @ApiPropertyOptional({ description: "Values classified as dividends" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  dividend?: string[];

  @ApiPropertyOptional({ description: "Values classified as interest" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  interest?: string[];

  @ApiPropertyOptional({
    description: "Values classified as capital gain distributions",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  capitalGain?: string[];

  @ApiPropertyOptional({ description: "Values classified as reinvestments" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  reinvest?: string[];

  @ApiPropertyOptional({ description: "Values classified as stock splits" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  split?: string[];

  @ApiPropertyOptional({
    description: "Values classified as share transfers in",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  transferIn?: string[];

  @ApiPropertyOptional({
    description: "Values classified as share transfers out",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  transferOut?: string[];

  @ApiPropertyOptional({
    description: "Values classified as share additions (no cost)",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  addShares?: string[];

  @ApiPropertyOptional({ description: "Values classified as share removals" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  removeShares?: string[];

  @ApiPropertyOptional({ description: "Values classified as cash deposits" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  cashIn?: string[];

  @ApiPropertyOptional({
    description: "Values classified as cash withdrawals/fees",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  cashOut?: string[];
}

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

  @ApiPropertyOptional({
    description:
      "Column index for tags field (multi-tag values auto-split on the detected separator: |, ;, or ,)",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  tags?: number;

  @ApiPropertyOptional({
    description:
      "Column index for reconciliation status field (values are mapped to Monize statuses via keyword matching)",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  reconciliationStatus?: number;

  @ApiProperty({
    description:
      "Date format for parsing: a built-in one (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYY-DD-MM, DD-MMM-YYYY, MMM DD, YYYY) or a pattern of YYYY, YY, MMM, MM, DD and separators",
  })
  @IsString()
  // Space and comma separate a month name ("MMM DD, YYYY", "DD MMM YYYY").
  @Matches(/^[YDMW/\-., ]+$/, {
    message:
      "dateFormat must contain only date pattern characters (Y, M, D) and separators (/, -, ., comma, space)",
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

  @ApiPropertyOptional({
    description:
      "Treat rows as investment transactions classified by the action column",
  })
  @IsOptional()
  @IsBoolean()
  investmentMode?: boolean;

  @ApiPropertyOptional({
    description:
      "Column index for investment action (required in investment mode)",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  actionColumn?: number;

  @ApiPropertyOptional({
    description:
      "Column index for security symbol or name (required in investment mode)",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  securityColumn?: number;

  @ApiPropertyOptional({ description: "Column index for share quantity" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  quantityColumn?: number;

  @ApiPropertyOptional({ description: "Column index for per-share price" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priceColumn?: number;

  @ApiPropertyOptional({ description: "Column index for commission/fees" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  commissionColumn?: number;

  @ApiPropertyOptional({
    description:
      "Per-action keyword overrides for classifying action-column values (a list replaces the built-in defaults for that action)",
    type: CsvActionKeywordsDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CsvActionKeywordsDto)
  actionKeywords?: CsvActionKeywordsDto;
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
    description: "Security mappings for investment-mode imports",
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
      "Date format override; the wizard sends the column mapping's, so it takes the same patterns",
  })
  @IsOptional()
  @IsString()
  // Space and comma separate a month name ("MMM DD, YYYY"), as in
  // CsvColumnMappingConfigDto.dateFormat.
  @Matches(/^[YDMW/\-., ]+$/, {
    message:
      "dateFormat must contain only date pattern characters (Y, M, D) and separators (/, -, ., comma, space)",
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

  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      "Per column, the date format that reads the most of its values over the whole file, or null where none reads any",
  })
  columnDateFormats: (string | null)[];
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
