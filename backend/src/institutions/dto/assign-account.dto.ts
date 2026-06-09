import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

export class AssignAccountDto {
  @ApiProperty({
    example: "account-uuid",
    description: "ID of the account to assign to this institution",
  })
  @IsUUID()
  accountId: string;
}
