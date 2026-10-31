import { IsInt, IsUUID, Min } from "class-validator";

export class SharedCommandDto {
  @IsUUID("4")
  operationId: string;

  @IsInt()
  @Min(0)
  expectedRevision: number;
}
