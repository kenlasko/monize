import { IsBoolean } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class MarkClearedDto {
  @ApiProperty({
    description: "Whether the transaction should be marked as cleared",
  })
  @IsBoolean()
  isCleared: boolean;
}
