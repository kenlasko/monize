import { Transform, Type } from "class-transformer";
import { IsCurrencyCode } from "../../../common/validators/is-currency-code.validator";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { MNY_RENAME_KINDS, MnyRenameKind } from "../model/mny-import-options";
import {
  ImportJobStatus,
  MnyImportProgress,
  MnyImportResult,
} from "../model/mny-import-job";

/**
 * Request and response shapes for the `.mny` import endpoints.
 *
 * The Money file password appears in exactly one place -- a multipart text field
 * on the parse call -- and in no response, no log line and no stored row (design
 * ADR-7). Same for the credentials the optional wipe re-authentication needs:
 * they travel on the start request and are spent immediately.
 */

/** Multipart text fields accompanying the uploaded file on `POST .../parse`. */
export class ParseMnyDto {
  @ApiPropertyOptional({
    description:
      "Money file password. Required only when the file is protected; never stored or echoed.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  password?: string;
}

/**
 * The most accounts or bills one start request may name (MIN-4). One entry
 * per account or schedule in the file: a large Money file has a few hundred
 * accounts, and a KMyMoney file at its record bound (`KMY_MAX_RECORDS`) is
 * nowhere near this many, so no file either format accepts is refused, while
 * a request can no longer carry an array of any size into the job.
 */
export const MNY_MAX_OPTION_ITEMS = 10_000;

export class MnyAccountOptionDto {
  @ApiProperty({ description: "Money ACCT.hacct of the account" })
  @IsInt()
  handle: number;

  @ApiProperty({ description: "False leaves the account out of the import" })
  @IsBoolean()
  include: boolean;

  @ApiPropertyOptional({
    description: "ISO code overriding the currency Money recorded",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @Transform(({ value }) =>
    typeof value === "string" ? value.toUpperCase() : value,
  )
  @IsCurrencyCode()
  currencyOverride?: string | null;
}

/**
 * The width of every name column a rename lands in (`VARCHAR(255)`). The
 * import holds each rename to its own element's bound as well, which is lower
 * for an investment account's pair suffix, and cuts any that misses it.
 */
export const MNY_MAX_RENAME_LENGTH = 255;

export class MnyRenameDto {
  @ApiProperty({ enum: MNY_RENAME_KINDS })
  @IsIn(MNY_RENAME_KINDS)
  kind: MnyRenameKind;

  @ApiProperty({ description: "Ordinal of the element within its section" })
  @IsInt()
  @Min(1)
  handle: number;

  @ApiProperty({ maxLength: MNY_MAX_RENAME_LENGTH })
  @IsString()
  @MaxLength(MNY_MAX_RENAME_LENGTH)
  name: string;
}

export class MnyImportOptionsDto {
  @ApiPropertyOptional({
    description:
      "Run the existing delete-my-data operation before importing. Requires the account password (or OIDC token) on this request.",
  })
  @IsOptional()
  @IsBoolean()
  wipeExistingData?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  referencedOnlyPayees?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  referencedOnlyCategories?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  importClosedAccounts?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  importPrices?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  importExchangeRates?: boolean;

  @ApiPropertyOptional({
    type: [MnyAccountOptionDto],
    maxItems: MNY_MAX_OPTION_ITEMS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MNY_MAX_OPTION_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => MnyAccountOptionDto)
  accounts?: MnyAccountOptionDto[];

  @ApiPropertyOptional({
    type: [Number],
    description: "BILL.hbill handles the user selected",
    maxItems: MNY_MAX_OPTION_ITEMS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MNY_MAX_OPTION_ITEMS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  bills?: number[];

  @ApiPropertyOptional({
    type: [MnyRenameDto],
    description:
      "Names for the file's names too long for Monize (KMyMoney only); any not named here is shortened",
    maxItems: MNY_MAX_OPTION_ITEMS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MNY_MAX_OPTION_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => MnyRenameDto)
  renames?: MnyRenameDto[];
}

export class StartMnyImportDto {
  @ApiProperty({ description: "Staged file returned by the parse call" })
  @IsUUID()
  stagedFileId: string;

  @ApiPropertyOptional({ type: MnyImportOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MnyImportOptionsDto)
  options?: MnyImportOptionsDto;

  @ApiPropertyOptional({
    description:
      "Account password, required only to confirm wipeExistingData. Spent on this request; never stored.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  wipePassword?: string;

  @ApiPropertyOptional({
    description: "OIDC id token, the wipe confirmation for OIDC accounts.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  wipeOidcIdToken?: string;
}

/**
 * The job as the wizard polls it. Deliberately not the entity: the row also
 * carries the staged file id and internal timestamps the client has no use for.
 */
export class MnyImportJobDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ["pending", "running", "completed", "failed"] })
  status: ImportJobStatus;

  @ApiPropertyOptional({ description: "Phase and row counts while running" })
  progress: MnyImportProgress | null;

  @ApiPropertyOptional({ description: "Counts and verification report" })
  result: MnyImportResult | null;

  @ApiPropertyOptional({
    description: "i18n key for a failed job (import.mnyErrors.<key>)",
  })
  errorKey: string | null;

  @ApiProperty({
    description: "Whether Retry over the same file is worth offering",
  })
  retryable: boolean;

  @ApiProperty({
    description:
      "True once the import's rows reached the ledger; a failure after it is not 'nothing saved', and the file must not be imported again",
  })
  dataCommitted: boolean;

  @ApiPropertyOptional()
  startedAt: Date | null;

  @ApiPropertyOptional()
  completedAt: Date | null;
}
