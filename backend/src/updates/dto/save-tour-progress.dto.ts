import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsString, Matches, MaxLength } from "class-validator";

/**
 * Body for POST /updates/tours/progress. `tourId` is an opaque persistence key
 * defined in the frontend tour registry (e.g. "intro/basics",
 * "release-1.13.0/accounts"); the pattern keeps it to a safe, path-like slug so
 * it can never smuggle SQL or unbounded input into the jsonb map.
 */
export class SaveTourProgressDto {
  @ApiProperty({
    description: "Opaque tour id from the frontend registry.",
    example: "intro/basics",
  })
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9./_-]*$/, {
    message: "tourId must be a lowercase slug (a-z, 0-9, . / _ -)",
  })
  tourId: string;

  @ApiProperty({ enum: ["completed", "dismissed"] })
  @IsIn(["completed", "dismissed"])
  status: "completed" | "dismissed";
}
