import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  IsOptional,
  IsArray,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ParseQifDto {
  @ApiProperty({ description: 'QIF file content as string' })
  @IsString()
  content: string;
}

export class CategoryMappingDto {
  @ApiProperty({ description: 'Original category name from QIF' })
  @IsString()
  originalName: string;

  @ApiPropertyOptional({ description: 'Existing category ID to map to' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Create new category with this name' })
  @IsOptional()
  @IsString()
  createNew?: string;

  @ApiPropertyOptional({ description: 'Parent category ID for new category' })
  @IsOptional()
  @IsUUID()
  parentCategoryId?: string;
}

export class AccountMappingDto {
  @ApiProperty({ description: 'Original transfer account name from QIF' })
  @IsString()
  originalName: string;

  @ApiPropertyOptional({ description: 'Existing account ID to map to' })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({ description: 'Create new account with this name' })
  @IsOptional()
  @IsString()
  createNew?: string;

  @ApiPropertyOptional({ description: 'Account type for new account' })
  @IsOptional()
  @IsString()
  accountType?: string;
}

export class SecurityMappingDto {
  @ApiProperty({ description: 'Original security name/symbol from QIF' })
  @IsString()
  originalName: string;

  @ApiPropertyOptional({ description: 'Existing security ID to map to' })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiPropertyOptional({ description: 'Create new security with this symbol' })
  @IsOptional()
  @IsString()
  createNew?: string;

  @ApiPropertyOptional({ description: 'Full name for new security' })
  @IsOptional()
  @IsString()
  securityName?: string;

  @ApiPropertyOptional({ description: 'Security type for new security (STOCK, ETF, MUTUAL_FUND, BOND, OPTION, CRYPTO, OTHER)' })
  @IsOptional()
  @IsString()
  securityType?: string;
}

export class ImportQifDto {
  @ApiProperty({ description: 'QIF file content as string' })
  @IsString()
  content: string;

  @ApiProperty({ description: 'Account ID to import transactions into' })
  @IsUUID()
  accountId: string;

  @ApiProperty({ description: 'Category mappings', type: [CategoryMappingDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CategoryMappingDto)
  categoryMappings: CategoryMappingDto[];

  @ApiProperty({ description: 'Account mappings for transfers', type: [AccountMappingDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AccountMappingDto)
  accountMappings: AccountMappingDto[];

  @ApiPropertyOptional({ description: 'Security mappings for investment transactions', type: [SecurityMappingDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SecurityMappingDto)
  securityMappings?: SecurityMappingDto[];

  @ApiPropertyOptional({ description: 'Skip duplicate transactions based on date, amount, and payee' })
  @IsOptional()
  @IsBoolean()
  skipDuplicates?: boolean;

  @ApiPropertyOptional({ description: 'Date format to use for parsing (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYY-DD-MM)' })
  @IsOptional()
  @IsString()
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

  @ApiProperty({ type: [String], description: 'Unique securities found in investment transactions' })
  securities: string[];

  @ApiProperty()
  dateRange: {
    start: string;
    end: string;
  };

  @ApiProperty({ description: 'Detected date format' })
  detectedDateFormat: string;

  @ApiProperty({ type: [String], description: 'Sample dates from the file' })
  sampleDates: string[];

  @ApiPropertyOptional({ description: 'Opening balance from QIF file, if present' })
  openingBalance: number | null;

  @ApiPropertyOptional({ description: 'Date of the opening balance record' })
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
}
