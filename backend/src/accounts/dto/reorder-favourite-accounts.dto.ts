import { IsArray, IsUUID } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ReorderFavouriteAccountsDto {
  @ApiProperty({
    description:
      "Ordered array of favourite account IDs. The position in the array determines the display order.",
    example: [
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    ],
  })
  @IsArray()
  @IsUUID("4", { each: true })
  accountIds: string[];
}
