import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";
import { SanitizeHtml } from "../../../common/decorators/sanitize-html.decorator";
import {
  EMAIL_RECEIPT_PARSER_MAX_FROM_DOMAINS,
  EMAIL_RECEIPT_PARSER_MAX_SUBJECT_WORDS,
} from "../../entities/email-receipt-parser.entity";
import {
  IsReceiptDomain,
  normalizeReceiptDomain,
} from "./receipt-domain.validator";

export const PARSER_NAME_MAX_LENGTH = 100;
export const PARSER_SUBJECT_WORD_MAX_LENGTH = 100;

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

const eachDomain = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? value.map(normalizeReceiptDomain) : value;

/** Subject words are compared lower-case (design section 6), so they are stored that way. */
const eachSubjectWord = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value.map((word) =>
        typeof word === "string" ? word.trim().toLowerCase() : word,
      )
    : value;

/** A nullable optional id: the form resends every field, blank means none. */
const notBlank = (_object: unknown, value: unknown) =>
  value !== null && value !== undefined && value !== "";

/**
 * A receipt parser (design section 5). The `definition` is validated by
 * `validateReceiptParserDefinition` in the service, which reports every problem
 * as a path and a code; the DTO only bounds its outer shape. Ownership of the
 * payee and of every category id is checked in the write's transaction.
 */
export class CreateEmailReceiptParserDto {
  @ApiProperty({ maxLength: PARSER_NAME_MAX_LENGTH })
  @SanitizeHtml()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(PARSER_NAME_MAX_LENGTH)
  name: string;

  @ApiPropertyOptional({ nullable: true, description: "The merchant's payee." })
  @IsOptional()
  @ValidateIf(notBlank)
  @IsUUID()
  payeeId?: string | null;

  @ApiProperty({
    type: [String],
    description:
      "Sender domains the parser reads (a sub-domain of one also matches). Lower-case, no @.",
    example: ["shop.example.com"],
  })
  @Transform(eachDomain)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EMAIL_RECEIPT_PARSER_MAX_FROM_DOMAINS)
  @IsReceiptDomain({ each: true })
  fromDomains: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      "When not empty, the subject must contain at least one of these (case-insensitive).",
  })
  @IsOptional()
  @Transform(eachSubjectWord)
  @IsArray()
  @ArrayMaxSize(EMAIL_RECEIPT_PARSER_MAX_SUBJECT_WORDS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(PARSER_SUBJECT_WORD_MAX_LENGTH, { each: true })
  subjectContains?: string[];

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "The version 1 definition (design section 5.1).",
  })
  @IsObject()
  definition: Record<string, unknown>;
}

/** A change to a parser: the fields to change, and the revision they were made against. */
export class UpdateEmailReceiptParserDto extends PartialType(
  CreateEmailReceiptParserDto,
) {
  @ApiProperty({
    minimum: 1,
    description:
      "The revision this edit was made against; a parser that has moved on is a 409.",
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision: number;
}

/** Body of `POST /email-receipt-parsers/:id/approve`. */
export class ApproveEmailReceiptParserDto {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      "When sent, the parser must still be at this revision (the version the person read).",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}

/** Body of `POST /email-receipt-parsers/test`: a draft definition against a stored email. */
export class TestEmailReceiptParserDto {
  @ApiProperty({ type: "object", additionalProperties: true })
  @IsObject()
  definition: Record<string, unknown>;

  @ApiProperty({ description: "The stored email to read." })
  @IsUUID()
  receiptId: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "The payee the parser would carry: its default category is the fallback, and the payee is a match signal.",
  })
  @IsOptional()
  @ValidateIf(notBlank)
  @IsUUID()
  payeeId?: string | null;
}
