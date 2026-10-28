import {
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsOptional,
  Matches,
  IsUUID,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";

export class CategorySuggestionAssignmentDto {
  @ApiProperty({ description: "Payee ID to assign category to" })
  @IsUUID()
  payeeId: string;

  @ApiProperty({ description: "Category ID to assign to the payee" })
  @IsUUID()
  categoryId: string;

  @ApiProperty({
    required: false,
    description:
      "When true, also apply this category to the payee's existing uncategorized transactions",
  })
  @IsOptional()
  @IsBoolean()
  backfillTransactions?: boolean;
}

export class ApplyCategorySuggestionsDto {
  @ApiProperty({
    required: false,
    description: "Fingerprint from the category impact preview",
  })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  accrualImpactFingerprint?: string;

  @ApiProperty({
    description: "Array of payee-to-category assignments",
    type: [CategorySuggestionAssignmentDto],
  })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CategorySuggestionAssignmentDto)
  assignments: CategorySuggestionAssignmentDto[];
}
