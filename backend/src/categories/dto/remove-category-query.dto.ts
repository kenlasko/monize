import { IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export const UNCATEGORIZED = "uncategorized";

export class RemoveCategoryQueryDto {
  @ApiPropertyOptional({
    description:
      "Category UUID to move the category's rows to before deleting it, or the literal 'uncategorized'. The move and the delete commit together or not at all.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(36)
  @Matches(
    /^(uncategorized|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    { message: "reassignTo must be a category UUID or 'uncategorized'" },
  )
  reassignTo?: string;
}
