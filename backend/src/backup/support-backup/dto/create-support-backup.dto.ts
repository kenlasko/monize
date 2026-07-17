import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { SupportBackupSection } from "../support-backup-rules";

const SECTIONS: SupportBackupSection[] = [
  "investments",
  "scheduled",
  "budgets",
  "reports",
  "importMappings",
  "autoBackup",
];

/**
 * The multiplier must never be a whole number: a clean integer would leave
 * every scaled amount looking suspiciously round and makes M trivially
 * guessable from a single known value. Enforced here as well as generated
 * non-integer on the client.
 */
@ValidatorConstraint({ name: "isNonIntegerMultiplier", async: false })
export class IsNonIntegerMultiplierConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      !Number.isInteger(value)
    );
  }
  defaultMessage(): string {
    return "multiplier must be a non-integer number";
  }
}

export class CreateSupportBackupDto {
  /** Every private amount is multiplied by this; public rates/prices are not. */
  @IsNumber()
  @Min(1.00001)
  @Max(1_000_000)
  @Validate(IsNonIntegerMultiplierConstraint)
  multiplier: number;

  /**
   * Optional content sections to INCLUDE. Omitted means all sections are
   * included. The account core (accounts, transactions, categories, payees,
   * tags, loans, monthly balances) is always included.
   */
  @IsOptional()
  @IsArray()
  @IsIn(SECTIONS, { each: true })
  sections?: SupportBackupSection[];

  /**
   * Optional account scope. When set, only these accounts and their
   * referential closure are exported. Omitted means all accounts.
   */
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  accountIds?: string[];

  /** Optional inclusive lower bound (yyyy-MM-dd) on exported history. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateFrom?: string;

  /** Optional inclusive upper bound (yyyy-MM-dd) on exported history. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateTo?: string;

  /**
   * Password encrypting the produced file (AES-256-GCM). Required: a support
   * backup is made to leave the user's machine, so it never ships unencrypted.
   * The client pre-fills a random one the user can edit or regenerate.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password: string;
}
