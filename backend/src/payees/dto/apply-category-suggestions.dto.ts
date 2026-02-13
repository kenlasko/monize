import { IsArray, IsUUID, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";

export class CategorySuggestionAssignmentDto {
  @ApiProperty({ description: "Payee ID to assign category to" })
  @IsUUID()
  payeeId: string;

  @ApiProperty({ description: "Category ID to assign to the payee" })
  @IsUUID()
  categoryId: string;
}

export class ApplyCategorySuggestionsDto {
  @ApiProperty({
    description: "Array of payee-to-category assignments",
    type: [CategorySuggestionAssignmentDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CategorySuggestionAssignmentDto)
  assignments: CategorySuggestionAssignmentDto[];
}
