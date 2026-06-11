import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class AutoMergeGroupDto {
  @ApiProperty({
    example: "canonical-payee-uuid",
    description: "ID of the payee to keep (all sources are merged into this)",
  })
  @IsUUID()
  canonicalPayeeId: string;

  @ApiProperty({
    required: false,
    example: "Lidl",
    description:
      "Optional new name for the canonical payee (cascades to its transactions)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  canonicalName?: string;

  @ApiProperty({
    type: [String],
    description: "IDs of the payees to merge into the canonical and delete",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  sourcePayeeIds: string[];

  @ApiProperty({
    required: false,
    example: "*LIDL*",
    description:
      "Wildcard alias to create on the canonical so future imports auto-match",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  alias?: string;

  @ApiProperty({
    required: false,
    example: "category-uuid",
    description: "Optional default category to set on the canonical payee",
  })
  @IsOptional()
  @IsUUID()
  defaultCategoryId?: string;
}

export class ApplyAutoMergeDto {
  @ApiProperty({ type: [AutoMergeGroupDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AutoMergeGroupDto)
  groups: AutoMergeGroupDto[];
}
